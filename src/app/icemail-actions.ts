"use server";

import { after } from "next/server";
import { refresh } from "next/cache";
import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { jobSql } from "@/lib/db";
import { ICEMAIL_NAMESERVERS, isAddressStyle, monthlyCost, planMailboxes, STYLE_ORDER, type AddressStyle } from "@/lib/icemail-board";
import { queueJob } from "@/lib/job-queue";
import type { ActionResult } from "./actions";

// Icemail orders and cancels from the Icemail page. Nothing here calls
// Icemail: each is queued and the worker sends it (src/jobs/icemail-orders.ts),
// with dry run respected there. The plain (job) connection keeps the JSON keys
// of the inboxes exactly as Icemail wants them.

class UserError extends Error {}
function fail(e: unknown): { ok: false; error: string } {
  if (e instanceof UserError) return { ok: false, error: e.message };
  if (e instanceof z.ZodError) return { ok: false, error: e.issues[0]?.message ?? "Invalid input" };
  const err = e as { code?: string };
  if (err?.code === "23505") return { ok: false, error: "One of these domains is already in another open Icemail order, or already being cancelled" };
  console.error(e);
  return { ok: false, error: "Something went wrong. Nothing was changed." };
}

const dryRun = () => process.env.INTEGRATIONS_DRY_RUN !== "false";
const kick = () => after(() => queueJob(jobSql, "icemail-orders").then(() => undefined, () => undefined));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const domainName = z.string().trim().toLowerCase().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, "Not a domain name");
const orderInput = z.object({
  accountId: z.uuid(),
  clientId: z.uuid().nullable(),
  provider: z.enum(["GOOGLE", "MICROSOFT"]),
  domains: z.array(z.object({ name: domainName, source: z.enum(["icemail", "inventory"]) })).min(1, "Pick at least one domain").max(50, "Up to 50 domains an order"),
  people: z.array(z.object({ first: z.string().trim().min(1).max(40), last: z.string().trim().min(1).max(40) })).min(1, "Add the names for the inboxes").max(50),
  /** Each name gets one inbox per style on every domain. */
  styles: z.array(z.string().refine(isAddressStyle, "Unknown address style")).min(1, "Tick at least one address style").max(STYLE_ORDER.length),
  note: z.string().trim().max(200).optional(),
  /** The Icemail domain this order replaces: it is cancelled before it renews. */
  replaces: z.string().min(1).max(100).nullable().optional(),
  /** The price the preview showed for one inbox: the order is refused if it changed since. */
  expectedPrice: z.number().nullable(),
});

export async function createIcemailOrder(input: z.input<typeof orderInput>): Promise<ActionResult<{ orderId: string; domains: number; inboxes: number; monthly: number | null; nameservers: number; dryRun: boolean }>> {
  try {
    const actor = await requireActor();
    const o = orderInput.parse(input);
    const names = [...new Set(o.domains.map((d) => d.name))];
    if (names.length !== o.domains.length) throw new UserError("A domain is in the list twice");

    const result = await jobSql.begin(async (tx) => {
      const [account] = await tx<{ id: string; price_google: string | null; price_microsoft: string | null }[]>`
        select id, price_google, price_microsoft from icemail_accounts where id = ${o.accountId}`;
      if (!account) throw new UserError("That Icemail workspace was removed; reload the page");
      const priceRaw = o.provider === "GOOGLE" ? account.price_google : account.price_microsoft;
      const price = priceRaw == null ? null : Number(priceRaw);
      if (price !== o.expectedPrice) throw new UserError("Icemail's price changed since the page loaded; reload and check the cost again");
      if (o.clientId) {
        const [c] = await tx`select 1 from clients where id = ${o.clientId} and archived_at is null`;
        if (!c) throw new UserError("That client is gone; reload the page");
      }

      // Connected domains: this workspace's, with no live inboxes and no cancel waiting.
      const fromIcemail = o.domains.filter((d) => d.source === "icemail").map((d) => d.name);
      const connected = fromIcemail.length ? await tx<{ id: string; domain_name: string; domain_id: string | null; live: number }[]>`
        select x.id, x.domain_name, x.domain_id,
          (select count(*)::int from icemail_mailboxes m where m.icemail_domain_id = x.id and m.gone_at is null and coalesce(m.status, '') !~* 'cancel|delet') as live
        from icemail_domains x where x.account_id = ${o.accountId} and x.gone_at is null and x.domain_name = any(${fromIcemail}::text[])` : [];
      for (const n of fromIcemail) {
        const x = connected.find((c) => c.domain_name === n);
        if (!x) throw new UserError(`${n} isn't connected to this Icemail workspace (or the last sync didn't see it); reload the page`);
        if (x.live) throw new UserError(`${n} already has ${plural(x.live, "inbox", "inboxes")} on Icemail`);
      }
      // Free domains from the inventory.
      const fromInventory = o.domains.filter((d) => d.source === "inventory").map((d) => d.name);
      const free = fromInventory.length ? await tx<{ id: string; name: string }[]>`
        select d.id, d.name from domains d where d.name = any(${fromInventory}::text[]) and d.archived_at is null and domain_is_free(d)` : [];
      for (const n of fromInventory) if (!free.some((f) => f.name === n)) throw new UserError(`${n} is no longer a free domain; reload the page`);

      const plan = planMailboxes({ domains: names, people: o.people, styles: o.styles as AddressStyle[] });
      if ("error" in plan) throw new UserError(plan.error);
      const inboxes = plan.plan.reduce((s, p) => s + p.mailboxes.length, 0);
      const monthly = monthlyCost(inboxes, price);

      let replaced: { id: string; domain_name: string; domain_id: string | null } | undefined;
      if (o.replaces) {
        [replaced] = await tx<{ id: string; domain_name: string; domain_id: string | null }[]>`
          select id, domain_name, domain_id from icemail_domains where id = ${o.replaces} and account_id = ${o.accountId} and gone_at is null`;
        if (!replaced) throw new UserError("The domain being replaced is gone from this workspace; reload the page");
      }

      await tx`select set_config('app.actor', ${actor}, true)`;
      const [order] = await tx<{ id: string }[]>`
        insert into icemail_orders (account_id, client_id, provider, price_usd, quoted_monthly_usd, note, created_by)
        values (${o.accountId}, ${o.clientId}, ${o.provider}, ${price}, ${monthly}, ${o.note || null}, ${actor})
        returning id`;
      let nameservers = 0;
      for (const p of plan.plan) {
        const x = connected.find((c) => c.domain_name === p.domain);
        const inv = free.find((f) => f.name === p.domain);
        let nsRequest: string | null = null;
        if (inv) {
          // Icemail imports a domain only once it points at its ClouDNS.
          await tx`delete from nameserver_requests where domain_id = ${inv.id} and status = 'pending'`;
          const [r] = await tx<{ id: string }[]>`
            insert into nameserver_requests (domain_id, source, target, actor) values (${inv.id}, 'custom', ${ICEMAIL_NAMESERVERS}::text[], ${actor}) returning id`;
          nsRequest = r.id;
          nameservers++;
        }
        await tx`
          insert into icemail_order_items (order_id, domain_name, domain_id, icemail_domain_id, mailboxes, ns_request_id, status)
          values (${order.id}, ${p.domain}, ${x?.domain_id ?? inv?.id ?? null}, ${x?.id ?? null}, ${tx.json(p.mailboxes)}, ${nsRequest},
            ${nsRequest ? "nameservers" : "queued"})`;
        if (inv && o.clientId) await tx`update domains set client_id = ${o.clientId} where id = ${inv.id} and client_id is null`;
      }
      if (replaced) {
        await tx`
          insert into icemail_cancels (account_id, icemail_domain_id, domain_name, domain_id, reason, replacement_order_id, created_by)
          values (${o.accountId}, ${replaced.id}, ${replaced.domain_name}, ${replaced.domain_id}, 'replace', ${order.id}, ${actor})`;
      }
      return { orderId: order.id, domains: plan.plan.length, inboxes, monthly, nameservers };
    });

    kick();
    if (result.nameservers) after(() => queueJob(jobSql, "nameserver-requests").then(() => undefined, () => undefined));
    refresh();
    return { ok: true, data: { ...result, dryRun: dryRun() } };
  } catch (e) {
    return fail(e);
  }
}

/** Cancels these Icemail domains: Icemail deletes their inboxes on their next billing date. */
export async function cancelIcemailDomains(input: { ids: string[] }): Promise<ActionResult<{ queued: number; dryRun: boolean }>> {
  try {
    const actor = await requireActor();
    const ids = z.array(z.string().min(1).max(100)).min(1, "Pick a domain to cancel").max(100).parse(input.ids);
    const queued = await jobSql.begin(async (tx) => {
      const rows = await tx<{ id: string; account_id: string; domain_name: string; domain_id: string | null; live: number; cancelling: boolean }[]>`
        select x.id, x.account_id, x.domain_name, x.domain_id,
          (select count(*)::int from icemail_mailboxes m where m.icemail_domain_id = x.id and m.gone_at is null and coalesce(m.status, '') !~* 'cancel|delet') as live,
          exists (select 1 from icemail_cancels k where k.icemail_domain_id = x.id and k.status in ('queued', 'scheduled', 'undo_queued')) as cancelling
        from icemail_domains x where x.id = any(${ids}::text[]) and x.gone_at is null`;
      if (rows.length !== ids.length) throw new UserError("One of these domains is gone from Icemail; reload the page");
      const empty = rows.find((r) => !r.live);
      if (empty) throw new UserError(`${empty.domain_name} has no live inboxes, so there's nothing to cancel`);
      const already = rows.find((r) => r.cancelling);
      if (already) throw new UserError(`${already.domain_name} is already being cancelled`);
      for (const r of rows) {
        await tx`insert into icemail_cancels (account_id, icemail_domain_id, domain_name, domain_id, reason, created_by, mailboxes)
          values (${r.account_id}, ${r.id}, ${r.domain_name}, ${r.domain_id}, 'cancel', ${actor}, ${r.live})`;
      }
      return rows.length;
    });
    kick();
    refresh();
    return { ok: true, data: { queued, dryRun: dryRun() } };
  } catch (e) {
    return fail(e);
  }
}

/** Takes a cancel back: one not yet sent is dropped, one Icemail has is undone there. */
export async function undoIcemailCancel(cancelId: string): Promise<ActionResult<{ sent: boolean }>> {
  try {
    await requireActor();
    const id = z.uuid().parse(cancelId);
    const [r] = await jobSql<{ status: string }[]>`
      update icemail_cancels set
        status = case when status = 'queued' then 'undone' else 'undo_queued' end,
        message = case when status = 'queued' then 'Taken back before Icemail was asked' else null end,
        finished_at = case when status = 'queued' then now() else finished_at end
      where id = ${id} and status in ('queued', 'scheduled') and (deletes_on is null or deletes_on > current_date)
      returning status`;
    if (!r) throw new UserError("Only a cancel still waiting, or scheduled for a day still ahead, can be taken back");
    if (r.status === "undo_queued") kick();
    refresh();
    return { ok: true, data: { sent: r.status === "undo_queued" } };
  } catch (e) {
    return fail(e);
  }
}

/** Puts a failed or dry-run domain of an order back in the queue. */
export async function retryIcemailItem(itemId: string): Promise<ActionResult> {
  try {
    await requireActor();
    const [r] = await jobSql`
      update icemail_order_items i set status = 'queued', message = null, started_at = null, finished_at = null
      from icemail_orders o
      where i.id = ${z.uuid().parse(itemId)} and o.id = i.order_id and o.cancelled_at is null and i.status in ('failed', 'dry_run', 'cancelled')
      returning i.id`;
    if (!r) throw new UserError("Only a failed, dry-run or cancelled domain can be tried again");
    kick();
    refresh();
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}

/** Drops a domain from an order before the worker sends it. */
export async function cancelIcemailItem(itemId: string): Promise<ActionResult> {
  try {
    await requireActor();
    const [r] = await jobSql<{ ns_request_id: string | null }[]>`
      update icemail_order_items set status = 'cancelled', finished_at = now(), message = 'Taken out of the order before it was sent'
      where id = ${z.uuid().parse(itemId)} and status in ('queued', 'nameservers') returning ns_request_id`;
    if (!r) throw new UserError("Only a domain still waiting can be taken out");
    // Its nameservers stay where they are, if the change hasn't run yet.
    if (r.ns_request_id) await jobSql`delete from nameserver_requests where id = ${r.ns_request_id} and status = 'pending'`;
    refresh();
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Clears orders from the Orders tab once nothing is left for the worker to do
 * on them. Nothing is deleted and Icemail isn't asked; Bring back undoes it.
 */
export async function clearIcemailOrders(ids: string[]): Promise<ActionResult<{ cleared: number }>> {
  try {
    const actor = await requireActor();
    const list = z.array(z.uuid()).min(1, "Pick an order to clear").max(200).parse(ids);
    const rows = await jobSql`
      update icemail_orders o set cleared_at = now(), cleared_by = ${actor}
      where o.id = any(${list}::uuid[]) and o.cleared_at is null
        and not exists (select 1 from icemail_order_items i where i.order_id = o.id and i.status in ('queued', 'nameservers', 'ordering'))
      returning o.id`;
    if (!rows.length) throw new UserError("Only an order with nothing still waiting can be cleared");
    refresh();
    return { ok: true, data: { cleared: rows.length } };
  } catch (e) {
    return fail(e);
  }
}

/** Puts a cleared order back in the Orders tab. */
export async function unclearIcemailOrder(id: string): Promise<ActionResult> {
  try {
    await requireActor();
    await jobSql`update icemail_orders set cleared_at = null, cleared_by = null where id = ${z.uuid().parse(id)}`;
    refresh();
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Exports an ordered domain's inboxes to Smartlead through Icemail now. A
 * failed export that Icemail started is tried again (Icemail's republish);
 * otherwise a new export of the inboxes active at Icemail and not in Smartlead
 * is queued. The worker sends it with the server's Smartlead login.
 */
export async function exportIcemailItem(itemId: string): Promise<ActionResult> {
  try {
    const actor = await requireActor();
    const id = z.uuid().parse(itemId);
    const queued = await jobSql.begin(async (tx) => {
      const [live] = await tx`select 1 from icemail_exports where order_item_id = ${id} and status in ('queued', 'sending', 'exporting')`;
      if (live) throw new UserError("An export of this domain is already on its way");
      const [last] = await tx<{ id: string; status: string; icemail_export_id: string | null }[]>`
        select id, status, icemail_export_id from icemail_exports where order_item_id = ${id} order by created_at desc limit 1`;
      // Icemail started it and some inboxes didn't make it: ask it to try those again.
      if (last && last.status === "failed" && last.icemail_export_id) {
        await tx`update icemail_exports set status = 'queued', message = null, started_at = null, finished_at = null where id = ${last.id}`;
        return 1;
      }
      const added = await tx`
        insert into icemail_exports (account_id, order_item_id, domain_name, mailbox_ids, created_by)
        select o.account_id, i.id, i.domain_name, array_agg(m.id order by m.id), ${actor}
        from icemail_order_items i
        join icemail_orders o on o.id = i.order_id
        join icemail_domains x on x.domain_name = i.domain_name and x.account_id = o.account_id and x.gone_at is null
        join icemail_mailboxes m on m.icemail_domain_id = x.id and m.gone_at is null and coalesce(m.status, '') !~* 'cancel|delet'
        where i.id = ${id} and i.status = 'ordered' and upper(coalesce(m.status, case when m.active then 'ACTIVE' end)) = 'ACTIVE'
          and not exists (select 1 from inboxes b where lower(b.email) = m.email and b.smartlead_account_id is not null)
        group by o.account_id, i.id, i.domain_name
        returning id`;
      return added.length;
    });
    if (!queued) throw new UserError("Nothing to export: its inboxes are in Smartlead already, or none is active at Icemail yet");
    kick();
    refresh();
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}
