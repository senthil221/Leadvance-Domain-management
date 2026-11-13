import type postgres from "postgres";
import { SmartleadError, type Smartlead } from "../integrations/smartlead";
import { queueJob } from "../lib/job-queue";
import type { IcemailAccount } from "./icemail-sync";
import { loadWarmupProgram } from "./warmup-program";

// New Icemail inboxes into Smartlead, without Icemail's export (which wants
// the Smartlead login). Once every inbox of an ordered domain is active at
// Icemail, one connect is queued an inbox. Each run reads the inbox's Google
// app password from Icemail and adds it to Smartlead over SMTP/IMAP in the
// same step: the password lives only in this function, never in the database
// or a log. Sending limits copy the client's other Google inboxes; warmup
// takes Settings → Warming up.

type Sql = postgres.Sql;
type Options = { max?: number; fallback?: { maxPerDay: number; waitMins: number } };

/** Tried again this often while Icemail hasn't set an app password, and given up after a day. */
const NO_PASSWORD_RETRY = "30 minutes";
const NO_PASSWORD_GIVE_UP = "24 hours";
const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 600);

/**
 * Queues the inboxes of ordered domains that are all active at Icemail and
 * not in Smartlead yet. Only domains ordered from Domain Engine in the last
 * two weeks, and each inbox once.
 */
export async function queueReadyConnects(sql: Sql, actor = "worker") {
  const rows = await sql`
    with ready as (
      select i.id as item_id, o.account_id, i.domain_name, jsonb_array_length(i.mailboxes) as wanted
      from icemail_order_items i join icemail_orders o on o.id = i.order_id
      where i.status = 'ordered' and i.finished_at > now() - interval '14 days'
        and not exists (select 1 from icemail_connects k where k.order_item_id = i.id)
    ),
    boxes as (
      select r.item_id, r.account_id, r.domain_name, r.wanted, m.id as mailbox_id, m.email,
        (m.active is true or upper(m.status) = 'ACTIVE') as active,
        exists (select 1 from inboxes b where lower(b.email) = m.email and b.smartlead_account_id is not null) as in_smartlead
      from ready r
      join icemail_domains x on x.domain_name = r.domain_name and x.account_id = r.account_id and x.gone_at is null
      join icemail_mailboxes m on m.icemail_domain_id = x.id and m.gone_at is null and coalesce(m.status, '') !~* 'cancel|delet'
    ),
    due as (
      select item_id from boxes group by item_id, wanted
      having count(*) >= wanted and bool_and(active)
    )
    insert into icemail_connects (account_id, order_item_id, icemail_mailbox_id, email, domain_name, created_by)
    select b.account_id, b.item_id, b.mailbox_id, b.email, b.domain_name, ${actor}
    from boxes b join due using (item_id)
    where not b.in_smartlead
    on conflict do nothing
    returning id`;
  return rows.length;
}

/** Sending limits for a new inbox: the commonest among the client's connected Google inboxes, else all of them. */
async function sendingFor(sql: Sql, domainName: string, fallback: { maxPerDay: number; waitMins: number }) {
  const [r] = await sql<{ sl_client: string | null; per_day: number | null; wait: number | null; per_day_all: number | null; wait_all: number | null }[]>`
    with d as (
      select coalesce(d.client_id, (select o.client_id from icemail_order_items i join icemail_orders o on o.id = i.order_id
        where i.domain_name = d.name order by o.created_at desc limit 1)) as client_id
      from domains d where d.name = ${domainName}
    ),
    g as (
      select i.daily_limit, i.min_wait_mins, dd.client_id
      from inboxes i join domains dd on dd.id = i.domain_id
      where i.status = 'connected' and upper(coalesce(i.provider_type, '')) in ('GMAIL', 'GOOGLE')
    )
    select (select c.smartlead_client_id::text from d join clients c on c.id = d.client_id) as sl_client,
      (select mode() within group (order by daily_limit) from g where daily_limit > 0 and client_id = (select client_id from d)) as per_day,
      (select mode() within group (order by min_wait_mins) from g where min_wait_mins >= 0 and client_id = (select client_id from d)) as wait,
      (select mode() within group (order by daily_limit) from g where daily_limit > 0) as per_day_all,
      (select mode() within group (order by min_wait_mins) from g where min_wait_mins >= 0) as wait_all`.then((x) => x.map((y) => ({
      slClient: y.sl_client, perDay: y.per_day, wait: y.wait, perDayAll: y.per_day_all, waitAll: y.wait_all,
    })));
  return {
    clientId: r?.slClient != null ? Number(r.slClient) : null,
    maxPerDay: r?.perDay ?? r?.perDayAll ?? fallback.maxPerDay,
    waitMins: r?.wait ?? r?.waitAll ?? fallback.waitMins,
  };
}

export async function processSmartleadConnects(sql: Sql, accounts: IcemailAccount[], smartlead: Smartlead | null,
  { max = 20, fallback = { maxPerDay: 20, waitMins: 10 } }: Options = {}) {
  const out = { connected: 0, dryRun: 0, noPassword: 0, failed: 0 };
  const byId = new Map(accounts.map((a) => [a.id, a]));

  // A run that died mid-way: Smartlead may or may not have it.
  await sql`
    update icemail_connects set status = 'failed', finished_at = now(),
      message = 'The worker stopped in the middle of adding it, so it is unclear whether Smartlead has it. Check Smartlead before retrying'
    where status = 'connecting' and started_at < now() - interval '20 minutes'`;
  // Icemail never set the app password.
  out.failed += (await sql`
    update icemail_connects set status = 'failed', finished_at = now(),
      message = 'Icemail still hasn''t set this inbox''s Google app password after a day. Set it in Icemail, then retry'
    where status = 'no_password' and created_at < now() - ${NO_PASSWORD_GIVE_UP}::interval
    returning id`).length;

  const claimed = await sql<{ id: string; account_id: string; icemail_mailbox_id: string; email: string; domain_name: string }[]>`
    update icemail_connects set status = 'connecting', started_at = now(), attempts = attempts + 1
    where id in (
      select id from icemail_connects
      where status = 'queued' or (status = 'no_password' and started_at < now() - ${NO_PASSWORD_RETRY}::interval)
      order by created_at limit ${max}
      for update skip locked)
    returning id, account_id, icemail_mailbox_id, email, domain_name`;
  if (!claimed.length) return out;

  const finish = (id: string, status: string, message: string | null, slId: number | null = null) =>
    sql`update icemail_connects set status = ${status}, message = ${message}, finished_at = now(),
      smartlead_account_id = coalesce(${slId}, smartlead_account_id) where id = ${id}`;
  const warmup = await loadWarmupProgram(sql);
  const sending = new Map<string, Awaited<ReturnType<typeof sendingFor>>>();

  for (const c of claimed) {
    const account = byId.get(c.account_id);
    if (!account) {
      await finish(c.id, "failed", "That Icemail workspace is no longer connected, or its key can't be read: check Settings → Connections. Nothing was added");
      out.failed++;
      continue;
    }
    if (!smartlead) {
      await finish(c.id, "failed", "This server has no Smartlead API key, so nothing was added");
      out.failed++;
      continue;
    }
    // Already there (added by hand or by Icemail's export): nothing to do.
    const [have] = await sql<{ id: string }[]>`
      select smartlead_account_id::text as id from inboxes where lower(email) = ${c.email} and smartlead_account_id is not null limit 1`;
    if (have) {
      await finish(c.id, "connected", "Already in Smartlead", Number(have.id));
      out.connected++;
      continue;
    }

    let appPassword: string | null;
    try {
      appPassword = await account.client.appPassword(c.icemail_mailbox_id);
    } catch (e) {
      await finish(c.id, "failed", `Couldn't read its app password from Icemail: ${msgOf(e)}. Nothing was added`);
      out.failed++;
      continue;
    }
    if (!appPassword) {
      await sql`update icemail_connects set status = 'no_password',
        message = 'Icemail hasn''t set this inbox''s Google app password yet; tried again every 30 minutes' where id = ${c.id}`;
      out.noPassword++;
      continue;
    }

    if (!sending.has(c.domain_name)) sending.set(c.domain_name, await sendingFor(sql, c.domain_name, fallback));
    const s = sending.get(c.domain_name)!;
    const [who] = await sql<{ first: string | null; last: string | null }[]>`
      select first_name as first, last_name as last from icemail_mailboxes where id = ${c.icemail_mailbox_id}`;
    const fromName = [who?.first, who?.last].filter(Boolean).join(" ") || c.email.split("@")[0];

    try {
      const r = await smartlead.addGmailAccount({
        email: c.email, fromName, appPassword, maxPerDay: s.maxPerDay, waitMins: s.waitMins, clientId: s.clientId,
        warmup: { enabled: true, perDay: warmup.perDay, rampup: warmup.rampup, replyRate: warmup.replyRate },
      });
      if ("dryRun" in r) {
        await finish(c.id, "dry_run", "Dry run: Smartlead wasn't asked");
        out.dryRun++;
      } else {
        await finish(c.id, "connected", null, r.id);
        out.connected++;
      }
    } catch (e) {
      const sure = e instanceof SmartleadError && e.status != null && e.status < 500;
      await finish(c.id, "failed", sure ? `${msgOf(e)}. Nothing was added` : `${msgOf(e)}. It is unclear whether Smartlead added it: check Smartlead before retrying`);
      out.failed++;
    } finally {
      appPassword = null;
    }
  }
  // Pull the new accounts in, so the Orders tab and the domain show them.
  if (out.connected) await queueJob(sql, "smartlead-accounts");
  return out;
}
