import type postgres from "postgres";
import { ApiError } from "../integrations/http";
import { queueJob } from "../lib/job-queue";
import type { IcemailAccount } from "./icemail-sync";

// New Icemail inboxes into Smartlead through Icemail's own export, the same as
// Export → Smartlead in its dashboard (Icemail never sets Google app passwords,
// so they can't be added to Smartlead directly). Once every inbox of an
// ordered domain is active at Icemail, one export is queued for the domain.
// Each run sends queued exports with the Smartlead login from the server's
// .env, then reads how the running ones are doing until Icemail says they're
// done; the Smartlead sync then shows the inboxes and the order goes Live.

type Sql = postgres.Sql;
export type SmartleadLogin = { username: string; password: string };

/** The Smartlead login Icemail exports with: ICEMAIL_SMARTLEAD_*, else the one Hypertide uses. Null when there's none. */
export function smartleadLoginFromEnv(env: Record<string, string | undefined> = process.env): SmartleadLogin | null {
  const username = (env.ICEMAIL_SMARTLEAD_USERNAME || env.HYPERTIDE_SMARTLEAD_USERNAME || "").trim();
  const password = env.ICEMAIL_SMARTLEAD_PASSWORD || env.HYPERTIDE_SMARTLEAD_PASSWORD || "";
  return username && password ? { username, password } : null;
}

const NO_LOGIN = "Waiting for the Smartlead login Icemail exports with: save ICEMAIL_SMARTLEAD_USERNAME and ICEMAIL_SMARTLEAD_PASSWORD with deploy/set-secret.sh";
/** How often a running export is looked at, and when one that hasn't finished is given up on. */
const CHECK_EVERY = "3 minutes";
const STUCK_AFTER = "6 hours";
const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^icemail (\S+) failed: /, "").slice(0, 600);

/**
 * Queues one export for each domain ordered from Domain Engine in the last two
 * weeks whose inboxes are all active at Icemail, with the ones not in Smartlead
 * yet. Never a domain that already had an export, or app-password connects
 * from before (those are exported by hand from the Orders tab).
 */
export async function queueReadyExports(sql: Sql, actor = "worker") {
  const rows = await sql`
    with ready as (
      select i.id as item_id, o.account_id, i.domain_name, jsonb_array_length(i.mailboxes) as wanted
      from icemail_order_items i join icemail_orders o on o.id = i.order_id
      where i.status = 'ordered' and i.finished_at > now() - interval '14 days'
        and not exists (select 1 from icemail_exports e where e.order_item_id = i.id)
        and not exists (select 1 from icemail_connects k where k.order_item_id = i.id)
    ),
    boxes as (
      select r.item_id, r.account_id, r.domain_name, r.wanted, m.id as mailbox_id,
        (m.active is true or upper(m.status) = 'ACTIVE') as active,
        exists (select 1 from inboxes b where lower(b.email) = m.email and b.smartlead_account_id is not null) as in_smartlead
      from ready r
      join icemail_domains x on x.domain_name = r.domain_name and x.account_id = r.account_id and x.gone_at is null
      join icemail_mailboxes m on m.icemail_domain_id = x.id and m.gone_at is null and coalesce(m.status, '') !~* 'cancel|delet'
    )
    insert into icemail_exports (account_id, order_item_id, domain_name, mailbox_ids, created_by)
    select account_id, item_id, domain_name, array_agg(mailbox_id order by mailbox_id) filter (where not in_smartlead), ${actor}
    from boxes
    group by item_id, account_id, domain_name, wanted
    having count(*) >= wanted and bool_and(active) and bool_or(not in_smartlead)
    on conflict do nothing
    returning id`;
  return rows.length;
}

export async function processIcemailExports(sql: Sql, accounts: IcemailAccount[], login: SmartleadLogin | null, { max = 10 } = {}) {
  const out = { sent: 0, dryRun: 0, done: 0, failed: 0, running: 0, waitingForLogin: 0 };
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const fail = (id: string, message: string) => sql`
    update icemail_exports set status = 'failed', message = ${message}, finished_at = now() where id = ${id}`;

  // A run that died while asking Icemail: it may or may not have started the export.
  out.failed += (await sql`
    update icemail_exports set status = 'failed', finished_at = now(),
      message = 'The worker stopped while asking Icemail to export them, so it is unclear whether the export started. Check Export History in Icemail before retrying'
    where status = 'sending' and started_at < now() - interval '20 minutes' returning id`).length;

  // Send the queued ones (a queued row with an export id is a retry: republished).
  const queued = await sql<{ id: string; account_id: string; domain_name: string; mailbox_ids: string[]; icemail_export_id: string | null }[]>`
    select id, account_id, domain_name, mailbox_ids, icemail_export_id from icemail_exports
    where status = 'queued' order by created_at limit ${max}`;
  for (const e of queued) {
    const account = byId.get(e.account_id);
    if (!account) {
      await fail(e.id, "That Icemail workspace is no longer connected, or its key can't be read: check Settings → Connections. Nothing was exported");
      out.failed++;
      continue;
    }
    if (!login && !e.icemail_export_id) {
      await sql`update icemail_exports set message = ${NO_LOGIN} where id = ${e.id} and message is distinct from ${NO_LOGIN}`;
      out.waitingForLogin++;
      continue;
    }
    // Inboxes that reached Smartlead some other way (by hand, say) are left out.
    const [left] = await sql<{ ids: string[] }[]>`
      select coalesce(array_agg(m.id order by m.id), '{}') as ids from icemail_mailboxes m
      where m.id = any(${e.mailbox_ids}::text[]) and not exists (select 1 from inboxes b where lower(b.email) = m.email and b.smartlead_account_id is not null)`;
    if (!left.ids.length) {
      await sql`update icemail_exports set status = 'done', message = 'Already in Smartlead', finished_at = now() where id = ${e.id}`;
      out.done++;
      continue;
    }
    const [claimed] = await sql`update icemail_exports set status = 'sending', started_at = now(), attempts = attempts + 1, message = null
      where id = ${e.id} and status = 'queued' returning id`;
    if (!claimed) continue;
    try {
      if (e.icemail_export_id) {
        const sent = await account.client.republishExport(e.icemail_export_id);
        if (!sent) {
          await sql`update icemail_exports set status = 'dry_run', message = 'Dry run: Icemail wasn''t asked to try the export again', finished_at = now() where id = ${e.id}`;
          out.dryRun++;
        } else {
          await sql`update icemail_exports set status = 'exporting', checked_at = now(), started_at = now(), finished_at = null where id = ${e.id}`;
          out.sent++;
        }
        continue;
      }
      const r = await account.client.exportToSmartlead(left.ids, login!, `Domain Engine · ${e.domain_name}`);
      if (!r) {
        await sql`update icemail_exports set status = 'dry_run', message = 'Dry run: Icemail wasn''t asked to export them', finished_at = now() where id = ${e.id}`;
        out.dryRun++;
      } else if (!r.exportId) {
        // Started, but with no id to follow it by: the Smartlead sync shows the inboxes once it's done.
        await sql`update icemail_exports set status = 'done', mailbox_ids = ${left.ids}, total = ${r.total ?? left.ids.length}, finished_at = now(),
          message = 'Icemail started the export but gave no id to follow it by; the inboxes show here once Smartlead has them' where id = ${e.id}`;
        out.sent++;
      } else {
        await sql`update icemail_exports set status = 'exporting', icemail_export_id = ${r.exportId}, mailbox_ids = ${left.ids},
          total = ${r.total ?? left.ids.length}, checked_at = now() where id = ${e.id}`;
        out.sent++;
      }
    } catch (err) {
      const status = err instanceof ApiError ? err.status : null;
      const why = msgOf(err);
      const message = status === 429
        ? `Icemail refused it: ${why}. It allows one export an inbox a day; nothing was exported, so retry tomorrow, or check Export History in Icemail if they were exported by hand`
        : status != null && status < 500
          ? `Icemail refused the export: ${why}. Nothing was exported${/credential|password|login|unauthor/i.test(why) ? "; check the Smartlead login saved on this server" : ""}`
          : `${why}. It is unclear whether Icemail started the export: check Export History in Icemail before retrying`;
      await fail(e.id, message);
      out.failed++;
    }
  }

  // Follow the running ones.
  const running = await sql<{ id: string; account_id: string; icemail_export_id: string; total: number | null; stuck: boolean }[]>`
    select id, account_id, icemail_export_id, total, started_at < now() - ${STUCK_AFTER}::interval as stuck
    from icemail_exports
    where status = 'exporting' and icemail_export_id is not null
      and (checked_at is null or checked_at < now() - ${CHECK_EVERY}::interval)
    order by checked_at nulls first limit 20`;
  for (const e of running) {
    const account = byId.get(e.account_id);
    if (!account) continue;
    try {
      const s = await account.client.exportStatus(e.icemail_export_id);
      const total = s.total ?? e.total;
      await sql`update icemail_exports set checked_at = now(), total = ${total}, processed = ${s.processed}, succeeded = ${s.succeeded}, failed_count = ${s.failed}, message = null
        where id = ${e.id}`;
      if (s.status === "completed" && !s.failed) {
        await sql`update icemail_exports set status = 'done', finished_at = now() where id = ${e.id}`;
        out.done++;
      } else if (s.status === "completed" || s.status === "failed") {
        const n = s.failed ?? total;
        await fail(e.id, `Icemail's export to Smartlead ${s.status === "failed" ? "failed" : "finished"} with ${n ?? "some"} of ${total ?? "its"} inboxes not exported. Retry asks Icemail to try them again (once every 2 hours)`);
        out.failed++;
      } else if (e.stuck) {
        await fail(e.id, `Icemail's export hasn't finished after ${STUCK_AFTER} (${s.processed ?? 0} of ${total ?? "?"} done). Retry asks Icemail to pick it up again`);
        out.failed++;
      } else {
        out.running++;
      }
    } catch (err) {
      await sql`update icemail_exports set checked_at = now(), message = ${`Couldn't read the export's progress from Icemail: ${msgOf(err)}; trying again in a few minutes`} where id = ${e.id}`;
      out.running++;
    }
  }
  // Pull the exported inboxes in, so the order shows them as Live.
  if (out.done) await queueJob(sql, "smartlead-accounts");
  return out;
}
