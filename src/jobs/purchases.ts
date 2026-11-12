import type postgres from "postgres";
import { AccountBlocked, SkipPurchase } from "../integrations/buy";
import type { RegistrarAccount } from "../integrations/registrars";
import { planPurchases } from "../lib/purchase-schedule";

// The buying queue, run every minute: at most one domain a run, only once its
// time has come, and never sooner after the last buy than the order's gap.
// Before paying, each registrar checks the name is still free and within the
// order's price; a reply that leaves it unclear whether money was spent is
// marked failed with a note to look, never retried on its own.

type Ctx = { registrars: RegistrarAccount[] };

const VENDOR: Record<string, string> = { dynadot: "Dynadot", spaceship: "Spaceship", unstoppable: "Unstoppable", porkbun: "Porkbun" };
/** "dynadot ?command=register failed: Domain is reserved" → "Dynadot refused it: Domain is reserved". */
const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e))
  .replace(/^(w+) S+ failed(?: ([A-Z_]+))?: /, (m, s: string) => (VENDOR[s.toLowerCase()] ? `${VENDOR[s.toLowerCase()]} refused it: ` : m))
  .slice(0, 1000);

export function accountFor(registrars: RegistrarAccount[], accountId: string | null, provider: string) {
  return accountId ? registrars.find((a) => a.id === accountId) : registrars.find((a) => a.id === null && a.provider === provider);
}

/** Adds a bought domain to the inventory, linked to the account it came from. */
async function addToInventory(sql: postgres.Sql, item: { domain: string; account_id: string | null }, account: RegistrarAccount) {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.actor', 'domain purchase', true)`;
    const [v] = await tx`select id from vendors where name = ${account.vendor}`;
    const [row] = await tx`
      insert into domains (name, registrar_id, registrar_account_id, purchased_at, auto_renew)
      values (${item.domain}, ${v?.id ?? null}, ${item.account_id}, now(), false)
      on conflict (name) do update set
        registrar_id = coalesce(excluded.registrar_id, domains.registrar_id),
        registrar_account_id = coalesce(excluded.registrar_account_id, domains.registrar_account_id),
        purchased_at = coalesce(domains.purchased_at, excluded.purchased_at)
      returning id`;
    return row.id as string;
  });
}

export async function processPurchases(sql: postgres.Sql, { registrars }: Ctx) {
  const out = { followed: 0, bought: 0, dryRun: 0, skipped: 0, failed: 0, paused: 0, waiting: 0 as number, found: 0 };

  // A purchase that errored or was cut short but shows up in the account
  // after all went through.
  const found = await sql`
    update purchase_items i set status = 'bought', domain_id = d.id, finished_at = coalesce(i.finished_at, now()),
      message = 'Bought: it showed up in the registrar account after the purchase reported a problem'
    from domains d
    where d.name = i.domain and i.status in ('failed', 'buying') and i.started_at < now() - interval '5 minutes'
      and d.registrar_seen_at > i.started_at
    returning i.id`;
  out.found = found.length;

  // A run that died mid-purchase: say so, and let the registrar sync show whether it happened.
  await sql`
    update purchase_items set status = 'failed', finished_at = now(),
      message = 'The worker stopped in the middle of this purchase, so it is unclear whether it went through. The next registrar sync shows it under Domains if it did; check the registrar before retrying'
    where status = 'buying' and started_at < now() - interval '20 minutes'`;

  // Orders the registrar finishes later.
  const open = await sql<{ id: string; domain: string; account_id: string | null; provider: string; vendor_ref: string; quoted_usd: string | null }[]>`
    select id, domain, account_id, provider, vendor_ref, quoted_usd from purchase_items
    where status = 'registering' order by started_at limit 10`;
  for (const item of open) {
    const account = accountFor(registrars, item.account_id, item.provider);
    if (!account?.client.buyer?.follow) continue;
    try {
      const r = await account.client.buyer.follow(item.vendor_ref);
      out.followed++;
      if (r.status === "bought") {
        const domainId = await addToInventory(sql, item, account);
        await sql`update purchase_items set status = 'bought', paid_usd = quoted_usd, domain_id = ${domainId}, finished_at = now(), message = null where id = ${item.id}`;
        out.bought++;
      } else if (r.status === "failed") {
        await sql`update purchase_items set status = 'failed', finished_at = now(), message = ${r.message} where id = ${item.id}`;
        out.failed++;
      }
    } catch (e) {
      await sql`update purchase_items set message = ${`Couldn't check on the order: ${msgOf(e)}`} where id = ${item.id}`;
    }
  }

  // The next one due, if the gap since the last buy has passed.
  const [item] = await sql<{ id: string; domain: string; account_id: string | null; provider: string; order_id: string; max_price_usd: string }[]>`
    update purchase_items set status = 'buying', started_at = now(), attempts = attempts + 1, message = null
    where id = (
      select i.id from purchase_items i join purchase_orders o on o.id = i.order_id
      where i.status = 'queued' and i.scheduled_at <= now() and o.paused_at is null and o.cancelled_at is null
        and not exists (
          select 1 from purchase_items x
          where x.started_at > now() - make_interval(mins => o.min_gap_minutes) and x.status <> 'cancelled')
      order by i.scheduled_at
      limit 1
      for update of i skip locked)
    returning id, domain, account_id, provider, order_id,
      (select max_price_usd from purchase_orders where id = order_id) as max_price_usd`;
  if (!item) {
    const [{ n }] = await sql`select count(*)::int as n from purchase_items i join purchase_orders o on o.id = i.order_id
      where i.status = 'queued' and o.paused_at is null and o.cancelled_at is null`;
    out.waiting = n;
    return out;
  }

  const account = accountFor(registrars, item.account_id, item.provider);
  const finish = (status: string, fields: { message?: string | null; quoted?: number | null; paid?: number | null; ref?: string | null; domainId?: string | null } = {}) =>
    sql`update purchase_items set status = ${status}, finished_at = ${status === "registering" ? null : sql`now()`},
      message = ${fields.message ?? null}, quoted_usd = coalesce(${fields.quoted ?? null}, quoted_usd), paid_usd = ${fields.paid ?? null},
      vendor_ref = coalesce(${fields.ref ?? null}, vendor_ref), domain_id = coalesce(${fields.domainId ?? null}::uuid, domain_id)
      where id = ${item.id}`;

  if (!account?.client.buyer) {
    await finish("failed", { message: "That registrar account is no longer connected, or its saved keys can't be read: check Settings → Connections. Nothing was bought" });
    out.failed++;
    return out;
  }
  const [mine] = await sql`select 1 from domains where name = ${item.domain} and archived_at is null`;
  if (mine) {
    await finish("skipped", { message: "Already in Domain Engine: you own it, or it was added before" });
    out.skipped++;
    return out;
  }

  try {
    const r = await account.client.buyer.buy(item.domain, Number(item.max_price_usd));
    if (r.status === "dry_run") {
      await finish("dry_run", { quoted: r.quotedUsd, message: "Dry run: free and within budget; nothing was bought" });
      out.dryRun++;
    } else if (r.status === "registering") {
      await finish("registering", { quoted: r.quotedUsd, ref: r.ref, message: "Ordered: waiting for the registrar to finish" });
    } else {
      const domainId = await addToInventory(sql, item, account);
      await finish("bought", { paid: r.paidUsd, quoted: r.paidUsd, ref: r.ref, domainId });
      out.bought++;
    }
  } catch (e) {
    if (e instanceof SkipPurchase) {
      await finish("skipped", { message: e.message, quoted: e.quotedUsd });
      out.skipped++;
    } else if (e instanceof AccountBlocked) {
      // Back in the queue, and the order waits until someone acts.
      await sql`update purchase_items set status = 'queued', started_at = null, message = ${e.message} where id = ${item.id}`;
      await sql`update purchase_orders set paused_at = now(), paused_reason = ${e.message} where id = ${item.order_id}`;
      out.paused++;
    } else {
      await finish("failed", { message: `${msgOf(e)}. Nothing should have been charged, but check the registrar before retrying` });
      out.failed++;
    }
  }
  return out;
}

/**
 * New times for an order's waiting domains, from now, with the order's
 * settings and each domain keeping its account. Used on resume, so a pause
 * doesn't leave a pile of overdue buys.
 */
export async function replanOrder(sql: postgres.Sql | postgres.TransactionSql, orderId: string, now = new Date()) {
  const [o] = await sql`select days, from_hour, to_hour, min_gap_minutes, timezone from purchase_orders where id = ${orderId}`;
  const items = await sql<{ id: string; domain: string; account_id: string | null; provider: string }[]>`
    select id, domain, account_id, provider from purchase_items where order_id = ${orderId} and status = 'queued' order by scheduled_at`;
  if (!o || !items.length) return 0;
  const key = (i: { account_id: string | null; provider: string }) => i.account_id ?? `env:${i.provider}`;
  const plan = planPurchases({
    domains: items.map((i) => i.domain), accounts: [...new Set(items.map(key))], start: now,
    days: o.days, fromHour: o.from_hour, toHour: o.to_hour, timezone: o.timezone, minGapMinutes: o.min_gap_minutes,
  });
  // If they no longer fit the window, keep the gap and let it run longer.
  const times = "planned" in plan
    ? plan.planned.map((p) => p.at).sort((a, b) => a.getTime() - b.getTime())
    : items.map((_, i) => new Date(now.getTime() + (i + 1) * o.min_gap_minutes * 60_000 * (1 + Math.random() * 0.5)));
  for (const [i, item] of items.entries()) await sql`update purchase_items set scheduled_at = ${times[i]} where id = ${item.id}`;
  return items.length;
}
