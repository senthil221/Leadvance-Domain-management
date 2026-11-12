"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { jobSql, sql } from "@/lib/db";
import { planPurchases } from "@/lib/purchase-schedule";
import { isProvider, PROVIDERS } from "@/lib/registrar-providers";
import type { ActionResult } from "./actions";

// Buying domains spread over time: orders, pausing, retries and balances.

class UserError extends Error {}
function fail(e: unknown): { ok: false; error: string } {
  if (e instanceof UserError) return { ok: false, error: e.message };
  if (e instanceof z.ZodError) return { ok: false, error: e.issues[0]?.message ?? "Invalid input" };
  const err = e as { code?: string; message?: string };
  if (err?.code === "23505") return { ok: false, error: "One of these domains is already waiting to be bought in another order" };
  console.error(e);
  return { ok: false, error: "Something went wrong. Nothing was changed." };
}

const dryRun = () => process.env.INTEGRATIONS_DRY_RUN !== "false";
const envPorkbun = () => Boolean(process.env.PORKBUN_API_KEY && process.env.PORKBUN_SECRET_KEY);
const ENV_PORKBUN = "env:porkbun";

/** The accounts an order can buy from: uuid of a Settings account, or env:porkbun. */
async function accountsByKey() {
  const rows = await sql<{ id: string; provider: string; label: string }[]>`select id, provider, label from registrar_accounts order by provider, created_at`;
  const map = new Map<string, { accountId: string | null; provider: string; name: string }>();
  for (const r of rows) if (isProvider(r.provider)) map.set(r.id, { accountId: r.id, provider: r.provider, name: `${PROVIDERS[r.provider].label} · ${r.label}` });
  if (envPorkbun()) map.set(ENV_PORKBUN, { accountId: null, provider: "porkbun", name: "Porkbun · Server .env" });
  return map;
}

const domainName = z.string().trim().toLowerCase().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, "Not a domain name");
const orderInput = z.object({
  domains: z.array(domainName).min(1, "Paste at least one domain").max(500, "Up to 500 domains an order"),
  accounts: z.array(z.string().min(1)).min(1, "Pick at least one registrar account").max(20),
  maxPriceUsd: z.number().positive("Set the most to pay for one domain").max(500),
  days: z.number().int().min(1).max(7),
  fromHour: z.number().int().min(0).max(23),
  toHour: z.number().int().min(1).max(24),
  minGapMinutes: z.number().int().min(5, "Keep at least 5 minutes between buys").max(720),
  note: z.string().trim().max(200).optional(),
});

export async function createPurchaseOrder(input: z.input<typeof orderInput>): Promise<ActionResult<{ orderId: string; scheduled: number; first: Date; last: Date; owned: string[]; dryRun: boolean }>> {
  try {
    const actor = await requireActor();
    const o = orderInput.parse(input);
    if (o.fromHour === o.toHour) throw new UserError("The working hours start and end at the same time");
    const accounts = await accountsByKey();
    const picked = [...new Set(o.accounts)].map((k) => ({ key: k, a: accounts.get(k) }));
    const gone = picked.find((p) => !p.a);
    if (gone) throw new UserError("One of the picked accounts is no longer connected; reload the page");

    const names = [...new Set(o.domains)];
    // Names already in the inventory are left out: buying them again can only fail or renew.
    const owned = (await sql<{ name: string }[]>`select name from domains where name = any(${names}::text[]) and archived_at is null`).map((r) => r.name);
    const toBuy = names.filter((n) => !owned.includes(n));
    if (!toBuy.length) throw new UserError("Every one of these domains is already in Domain Engine");

    const [tz] = await sql`select value #>> '{}' as tz from settings where key = 'stats_timezone'`;
    const timezone = (tz?.tz as string) || "UTC";
    const plan = planPurchases({
      domains: toBuy, accounts: picked.map((p) => p.key), start: new Date(Date.now() + 2 * 60_000),
      days: o.days, fromHour: o.fromHour, toHour: o.toHour, timezone, minGapMinutes: o.minGapMinutes,
    });
    if ("error" in plan) throw new UserError(plan.error);

    const orderId = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into purchase_orders (created_by, max_price_usd, days, from_hour, to_hour, min_gap_minutes, timezone, note)
        values (${actor}, ${o.maxPriceUsd}, ${o.days}, ${o.fromHour}, ${o.toHour}, ${o.minGapMinutes}, ${timezone}, ${o.note || null})
        returning id`;
      for (const p of plan.planned) {
        const a = accounts.get(p.accountId)!;
        await tx`insert into purchase_items (order_id, domain, account_id, provider, scheduled_at)
          values (${row.id}, ${p.domain}, ${a.accountId}, ${a.provider}, ${p.at})`;
      }
      return row.id as string;
    });
    const times = plan.planned.map((p) => p.at.getTime());
    refresh();
    return { ok: true, data: { orderId, scheduled: plan.planned.length, first: new Date(Math.min(...times)), last: new Date(Math.max(...times)), owned, dryRun: dryRun() } };
  } catch (e) {
    return fail(e);
  }
}

export async function setPurchaseOrder(orderId: string, what: "pause" | "resume" | "cancel"): Promise<ActionResult> {
  try {
    await requireActor();
    const id = z.uuid().parse(orderId);
    await sql.begin(async (tx) => {
      const [o] = await tx`select cancelled_at from purchase_orders where id = ${id} for update`;
      if (!o) throw new UserError("That order is gone");
      if (o.cancelled_at) throw new UserError("That order was cancelled");
      if (what === "pause") await tx`update purchase_orders set paused_at = now(), paused_reason = null where id = ${id}`;
      if (what === "cancel") {
        await tx`update purchase_orders set cancelled_at = now() where id = ${id}`;
        await tx`update purchase_items set status = 'cancelled', finished_at = now(), message = 'Cancelled before its time' where order_id = ${id} and status = 'queued'`;
      }
      if (what === "resume") {
        await tx`update purchase_orders set paused_at = null, paused_reason = null where id = ${id}`;
        // Fresh times from now, so the pause doesn't leave a pile of overdue buys.
        const { replanOrder } = await import("@/jobs/purchases");
        await replanOrder(tx, id);
      }
    });
    refresh();
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}

/** Puts a failed, skipped or cancelled domain back in the queue, a few minutes out. */
export async function retryPurchaseItem(itemId: string): Promise<ActionResult> {
  try {
    await requireActor();
    const id = z.uuid().parse(itemId);
    const later = new Date(Date.now() + (3 + Math.random() * 7) * 60_000);
    const [r] = await sql`
      update purchase_items i set status = 'queued', scheduled_at = ${later}, message = null, started_at = null, finished_at = null
      from purchase_orders o
      where i.id = ${id} and o.id = i.order_id and o.cancelled_at is null and i.status in ('failed', 'skipped', 'cancelled', 'dry_run')
      returning i.id`;
    if (!r) throw new UserError("Only a failed, skipped or cancelled domain in an open order can be retried");
    refresh();
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}

export async function cancelPurchaseItem(itemId: string): Promise<ActionResult> {
  try {
    await requireActor();
    const [r] = await sql`update purchase_items set status = 'cancelled', finished_at = now(), message = 'Cancelled before its time'
      where id = ${z.uuid().parse(itemId)} and status = 'queued' returning id`;
    if (!r) throw new UserError("Only a domain still waiting can be cancelled");
    refresh();
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}

/** Each account's balance, as the registrar reports it (Spaceship doesn't). */
export async function loadPurchaseBalances(): Promise<Record<string, { usd: number | null; error?: string }>> {
  await requireActor();
  const { loadRegistrars } = await import("@/integrations/registrars");
  const { createPorkbun } = await import("@/integrations/porkbun");
  const pbKey = process.env.PORKBUN_API_KEY, pbSecret = process.env.PORKBUN_SECRET_KEY;
  const porkbun = pbKey && pbSecret ? createPorkbun({ apiKey: pbKey, secretKey: pbSecret, sql: jobSql, dryRun: dryRun() }) : null;
  const { accounts } = await loadRegistrars(jobSql, { dryRun: dryRun(), porkbun });
  const out: Record<string, { usd: number | null; error?: string }> = {};
  await Promise.all(accounts.map(async (a) => {
    const key = a.id ?? ENV_PORKBUN;
    try {
      out[key] = { usd: a.client.buyer ? await a.client.buyer.balance() : null };
    } catch (e) {
      out[key] = { usd: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
    }
  }));
  return out;
}
