import type postgres from "postgres";
import { ApiError } from "../integrations/http";
import type { IcemailNewMailbox } from "../integrations/icemail";
import { queueJob } from "../lib/job-queue";
import type { IcemailAccount } from "./icemail-sync";

// Icemail orders and cancels queued from the Icemail page, run every minute.
// One domain an order request, at least `gapMs` apart (Icemail allows one
// order every five seconds). A domain from the inventory waits until its
// nameservers have moved to Icemail's ClouDNS. A reply that leaves it unclear
// whether inboxes were bought is marked failed with a note to look, never
// retried on its own. Cancels ask Icemail to delete a domain's inboxes on
// their next billing date, so they keep sending until then.

type Sql = postgres.Sql;
type Options = { gapMs?: number; maxOrders?: number; sleep?: (ms: number) => Promise<void> };

const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^icemail (\S+) failed: /, "Icemail refused it: ").slice(0, 1000);
const day = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);

export async function processIcemailActions(sql: Sql, accounts: IcemailAccount[], { gapMs = 5500, maxOrders = 8, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: Options = {}) {
  const out = { scheduled: 0, undone: 0, ordered: 0, dryRun: 0, failed: 0, waiting: 0 };
  const byId = new Map(accounts.map((a) => [a.id, a]));
  // Set once an order has gone to Icemail this run: the next one waits the gap.
  let ordering = false;

  // Cancels: ask Icemail to delete at the end of the billing period.
  const cancels = await sql<{ id: string; account_id: string; icemail_domain_id: string; domain_name: string }[]>`
    select id, account_id, icemail_domain_id, domain_name from icemail_cancels where status = 'queued' order by created_at limit 20`;
  for (const c of cancels) {
    const account = byId.get(c.account_id);
    const [live] = await sql<{ n: number; first: Date | null }[]>`
      select count(*)::int as n, min(next_billing_on) filter (where next_billing_on >= current_date) as first
      from icemail_mailboxes where icemail_domain_id = ${c.icemail_domain_id} and gone_at is null`;
    if (!account) {
      await sql`update icemail_cancels set status = 'failed', finished_at = now(), message = 'That Icemail workspace is no longer connected, or its key can''t be read: check Settings → Connections. Nothing was cancelled' where id = ${c.id}`;
      out.failed++;
      continue;
    }
    try {
      const r = await account.client.scheduleDeletion([c.icemail_domain_id]);
      if (!r) {
        await sql`update icemail_cancels set status = 'dry_run', finished_at = now(), deletes_on = ${day(live.first)}, mailboxes = ${live.n},
          message = 'Dry run: Icemail wasn''t asked. Its inboxes would have been deleted on their next billing date' where id = ${c.id}`;
        out.dryRun++;
        continue;
      }
      const mine = r.find((x) => x.domainId === c.icemail_domain_id) ?? r[0];
      if (!mine || mine.error || mine.skipped) {
        const why = mine?.error ? `Icemail refused it: ${mine.error}` : mine?.skipped ? "Icemail has no live inboxes on this domain, so there was nothing to cancel" : "Icemail didn't say what it did with this domain: check it in Icemail";
        await sql`update icemail_cancels set status = 'failed', finished_at = now(), message = ${why} where id = ${c.id}`;
        out.failed++;
        continue;
      }
      await sql`update icemail_cancels set status = 'scheduled', finished_at = now(), deletes_on = ${day(live.first)},
        mailboxes = ${mine.mailboxIds.length || live.n}, message = null where id = ${c.id}`;
      out.scheduled++;
    } catch (e) {
      await sql`update icemail_cancels set status = 'failed', finished_at = now(), message = ${msgOf(e)} where id = ${c.id}`;
      out.failed++;
    }
  }

  // Taking a scheduled deletion back.
  const undos = await sql<{ id: string; account_id: string; icemail_domain_id: string }[]>`
    select id, account_id, icemail_domain_id from icemail_cancels where status = 'undo_queued' order by created_at limit 20`;
  for (const c of undos) {
    const account = byId.get(c.account_id);
    try {
      if (!account) throw new Error("That Icemail workspace is no longer connected: check Settings → Connections");
      const r = await account.client.cancelScheduledDeletion([c.icemail_domain_id]);
      if (r && !r.ok.includes(c.icemail_domain_id)) throw new Error("Icemail wouldn't take it back: the billing date may have passed, so the deletion has already started");
      await sql`update icemail_cancels set status = 'undone', finished_at = now(),
        message = ${r ? null : "Dry run: Icemail wasn't asked"} where id = ${c.id}`;
      out.undone++;
    } catch (e) {
      // Still scheduled at Icemail.
      await sql`update icemail_cancels set status = 'scheduled', message = ${`Couldn't take it back: ${msgOf(e)}`} where id = ${c.id}`;
      out.failed++;
    }
  }

  // A run that died mid-order: say so, and let the next sync show whether it happened.
  await sql`
    update icemail_order_items set status = 'failed', finished_at = now(),
      message = 'The worker stopped in the middle of this order, so it is unclear whether Icemail took it. Check the domain in Icemail (the next sync shows its inboxes here) before retrying'
    where status = 'ordering' and started_at < now() - interval '20 minutes'`;

  // Domains waiting for their nameservers to move to Icemail.
  await sql`
    update icemail_order_items i set status = 'queued', message = null
    from nameserver_requests r
    where i.status = 'nameservers' and r.id = i.ns_request_id and r.status in ('done', 'dry_run')`;
  const nsFailed = await sql`
    update icemail_order_items i set status = 'failed', finished_at = now(),
      message = 'Its nameservers couldn''t be moved to Icemail' || coalesce(': ' || rtrim(r.message, '. '), '') ||
        '. Retry once they point at the four ClouDNS nameservers'
    from nameserver_requests r
    where i.status = 'nameservers' and r.id = i.ns_request_id and r.status in ('manual', 'failed')
    returning i.id`;
  out.failed += nsFailed.length;
  // A nameserver request removed before it ran.
  await sql`
    update icemail_order_items set status = 'failed', finished_at = now(), message = 'Its nameserver change was removed before it ran: retry to order it anyway, once the nameservers point at ClouDNS'
    where status = 'nameservers' and ns_request_id is null`;

  for (let n = 0; n < maxOrders; n++) {
    const [item] = await sql<{ id: string; domain_name: string; domain_id: string | null; mailboxes: IcemailNewMailbox[]; account_id: string; client_id: string | null; provider: "GOOGLE" | "MICROSOFT" }[]>`
      update icemail_order_items set status = 'ordering', started_at = now(), attempts = attempts + 1, message = null
      where id = (
        select i.id from icemail_order_items i join icemail_orders o on o.id = i.order_id
        where i.status = 'queued' and o.cancelled_at is null
        order by o.created_at, i.domain_name
        limit 1
        for update of i skip locked)
      returning id, domain_name, domain_id, mailboxes,
        (select account_id from icemail_orders where id = order_id) as account_id,
        (select client_id from icemail_orders where id = order_id) as client_id,
        (select provider from icemail_orders where id = order_id) as provider`;
    if (!item) break;
    const finish = (status: string, message: string | null, orderRef: string | null = null) =>
      sql`update icemail_order_items set status = ${status}, message = ${message}, finished_at = now(),
        icemail_order_id = coalesce(${orderRef}, icemail_order_id) where id = ${item.id}`;

    const account = byId.get(item.account_id);
    if (!account) {
      await finish("failed", "That Icemail workspace is no longer connected, or its key can't be read: check Settings → Connections. Nothing was ordered");
      out.failed++;
      continue;
    }
    // Inboxes already there: a second order would only pay twice.
    const [{ live }] = await sql<{ live: number }[]>`
      select count(*)::int as live from icemail_mailboxes m
      join icemail_domains x on x.id = m.icemail_domain_id
      where x.domain_name = ${item.domain_name} and x.gone_at is null and m.gone_at is null and coalesce(m.status, '') !~* 'cancel|delet'`;
    if (live > 0) {
      await finish("failed", `It already has ${live} inbox${live === 1 ? "" : "es"} on Icemail, so nothing was ordered. Cancel those first, or pick another domain`);
      out.failed++;
      continue;
    }

    if (ordering) await sleep(gapMs);
    ordering = true;
    try {
      const r = await account.client.orderMailboxes(item.domain_name, item.provider, item.mailboxes);
      if (!r) {
        await finish("dry_run", `Dry run: Icemail wasn't asked. It would have created ${item.mailboxes.length} inbox${item.mailboxes.length === 1 ? "" : "es"}`);
        out.dryRun++;
        continue;
      }
      await finish("ordered", "Ordered: Icemail sets the inboxes up over the next hours", r.orderId);
      if (item.domain_id && item.client_id) {
        await sql`update domains set client_id = ${item.client_id} where id = ${item.domain_id} and client_id is null`;
      }
      out.ordered++;
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) {
        // Rate limited before anything happened: back in the queue for the next run.
        await sql`update icemail_order_items set status = 'queued', started_at = null, message = 'Icemail asked to slow down; it goes in the next run' where id = ${item.id}`;
        break;
      }
      const sure = e instanceof ApiError && e.status != null && e.status >= 400 && e.status < 500;
      await finish("failed", sure ? `${msgOf(e)}. Nothing was ordered` : `${msgOf(e)}. It is unclear whether Icemail took the order: check the domain in Icemail before retrying`);
      out.failed++;
    }
  }

  const [{ waiting }] = await sql<{ waiting: number }[]>`select count(*)::int as waiting from icemail_order_items where status in ('queued', 'nameservers')`;
  out.waiting = waiting;
  // The new inboxes and scheduled dates show sooner than the half-hourly sync.
  if (out.ordered || out.scheduled || out.undone) await queueJob(sql, "icemail");
  return out;
}
