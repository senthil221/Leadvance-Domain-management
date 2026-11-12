import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountBlocked, SkipPurchase, type Buyer } from "../src/integrations/buy";
import { parseDynadotPrice } from "../src/integrations/dynadot";
import { createPorkbun, porkbunBuyer } from "../src/integrations/porkbun";
import type { RegistrarAccount } from "../src/integrations/registrars";
import { spaceshipYearPrice } from "../src/integrations/spaceship";
import { createUnstoppable } from "../src/integrations/unstoppable";
import { processPurchases, replanOrder } from "../src/jobs/purchases";
import { planPurchases, workingMinutes } from "../src/lib/purchase-schedule";
import { loadMigrations } from "../scripts/migrations";

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// A seeded random, so the plans are the same every run.
const seeded = (seed = 7) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

describe("purchase schedule", () => {
  const start = new Date("2026-11-16T00:00:00Z"); // a Monday, midnight UTC
  const base = { accounts: ["a", "b"], start, days: 2, fromHour: 9, toHour: 21, timezone: "UTC", minGapMinutes: 20, random: seeded() };

  it("keeps every buy inside working hours, at least the gap apart, accounts taking turns", () => {
    const domains = Array.from({ length: 30 }, (_, i) => `brandname${i}.com`);
    const r = planPurchases({ ...base, domains });
    if ("error" in r) throw new Error(r.error);
    const times = r.planned.map((p) => p.at.getTime()).sort((x, y) => x - y);
    for (const t of times) expect(new Date(t).getUTCHours()).toBeGreaterThanOrEqual(9), expect(new Date(t).getUTCHours()).toBeLessThan(21);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(19 * 60_000);
    // Gaps vary: not a fixed interval.
    const gaps = new Set(times.slice(1).map((t, i) => Math.round((t - times[i]) / 60_000)));
    expect(gaps.size).toBeGreaterThan(5);
    const byAccount = r.planned.reduce<Record<string, number>>((m, p) => ({ ...m, [p.accountId]: (m[p.accountId] ?? 0) + 1 }), {});
    expect(byAccount).toEqual({ a: 15, b: 15 });
    // Not in alphabetical order.
    const inTimeOrder = [...r.planned].sort((x, y) => x.at.getTime() - y.at.getTime()).map((p) => p.domain);
    expect(inTimeOrder).not.toEqual([...domains].sort());
  });

  it("says how many fit when the list is too long for the window", () => {
    const r = planPurchases({ ...base, domains: Array.from({ length: 100 }, (_, i) => `x${i}.com`) });
    expect(r).toEqual({ error: expect.stringContaining("72 would") });
  });

  it("follows working hours in the order's timezone, across midnight too", () => {
    const ny = workingMinutes(start, 1, 9, 17, "America/New_York");
    expect(ny.length).toBe(8 * 60);
    expect(ny[0].toISOString()).toBe("2026-11-16T14:00:00.000Z");
    expect(workingMinutes(start, 1, 22, 2, "UTC").length).toBe(4 * 60);
  });
});

describe("registrar prices", () => {
  it("reads Dynadot's price text", () => {
    expect(parseDynadotPrice("44.00 in USD and domain is not premium")).toEqual({ price: 44, premium: false, usd: true });
    expect(parseDynadotPrice("1,250.00 in USD and domain is premium")).toEqual({ price: 1250, premium: true, usd: true });
    expect(parseDynadotPrice("9.99 in EUR").usd).toBe(false);
  });

  it("reads Spaceship's one-year price", () => {
    expect(spaceshipYearPrice({ priceClass: "standard", prices: { register: [
      { period: { value: 2, unit: "y" }, priceInDefaultCurrency: { finalPrice: { amount: "20.00", currency: "USD" } } },
      { period: { value: 1, unit: "y" }, priceInDefaultCurrency: { finalPrice: { amount: "10.98", currency: "USD" } } },
    ] } })).toEqual({ premium: false, price: 10.98 });
  });
});

describe("Porkbun buyer", () => {
  const pb = (responses: Record<string, unknown>, dryRun = false) => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace("https://api.porkbun.com/api/json/v3", "");
      calls.push(`${path} ${init.body}`);
      const key = Object.keys(responses).find((k) => path.startsWith(k));
      return ok(key ? responses[key] : { status: "ERROR", message: "unexpected" }, key ? 200 : 400);
    }) as unknown as typeof fetch;
    return { buyer: porkbunBuyer(createPorkbun({ apiKey: "pk1_x", secretKey: "sk1_x", dryRun, fetchImpl, minSpacingMs: 0 })), calls };
  };
  const free = { status: "SUCCESS", response: { avail: "yes", price: "10.37", premium: "no" } };

  it("pays the quoted price in cents and agrees to the terms", async () => {
    const { buyer, calls } = pb({ "/domain/checkDomain/": free, "/domain/create/": { status: "SUCCESS", cost: 1037, orderId: 99 } });
    expect(await buyer.buy("brightlane.com", 12)).toEqual({ status: "bought", paidUsd: 10.37, ref: "99" });
    expect(calls[1]).toContain('"cost":1037');
    expect(calls[1]).toContain('"agreeToTerms":"yes"');
  });

  it("skips over budget and premium without buying", async () => {
    const { buyer, calls } = pb({ "/domain/checkDomain/": free });
    await expect(buyer.buy("brightlane.com", 9)).rejects.toThrow(SkipPurchase);
    expect(calls.some((c) => c.startsWith("/domain/create"))).toBe(false);
    const prem = pb({ "/domain/checkDomain/": { status: "SUCCESS", response: { avail: "yes", price: "8", premium: "yes" } } });
    await expect(prem.buyer.buy("brightlane.com", 50)).rejects.toThrow(/Premium/);
  });

  it("pauses on low credit", async () => {
    const { buyer } = pb({ "/domain/checkDomain/": free, "/domain/create/": { status: "ERROR", code: "INSUFFICIENT_FUNDS", message: "Not enough credit" } });
    await expect(buyer.buy("brightlane.com", 12)).rejects.toThrow(AccountBlocked);
  });

  it("only checks in dry run", async () => {
    const { buyer, calls } = pb({ "/domain/checkDomain/": free }, true);
    expect(await buyer.buy("brightlane.com", 12)).toEqual({ status: "dry_run", quotedUsd: 10.37 });
    expect(calls).toHaveLength(1);
  });
});

describe("Unstoppable buyer", () => {
  const ud = (answers: Record<string, unknown | ((body: Record<string, unknown>) => unknown)>) => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const name = url.split("/").pop()!;
      calls.push(name);
      const a = answers[name];
      return ok(typeof a === "function" ? a(JSON.parse(String(init.body))) : a ?? {});
    }) as unknown as typeof fetch;
    return { buyer: createUnstoppable({ apiKey: "ud_mcp_x", dryRun: false, fetchImpl, minSpacingMs: 0 }).buyer!, calls };
  };
  const base = {
    ud_domains_search: { results: [{ name: "brightlane.com", marketplace: { status: "available" }, pricing: { amount: 1099 } }] },
    ud_contacts_list: { contacts: [{ id: "c1", status: "active" }] },
    ud_cart_add_domain_registration: { addedProducts: [{ domain: "brightlane.com", success: true, productId: 5 }] },
  };

  it("checks out only the one domain, paid from the balance", async () => {
    let cart: unknown[] = [];
    const { buyer, calls } = ud({
      ...base,
      ud_cart_get: () => ({ items: cart }),
      ud_cart_add_domain_registration: () => { cart = [{ productId: 5, domain: "brightlane.com" }]; return base.ud_cart_add_domain_registration; },
      ud_cart_quote: { quoteToken: "q1", quotedItemCount: 1, expectedTotalCharged: 0, items: [{ domain: "brightlane.com", lineTotalCents: 1099 }] },
      ud_cart_checkout: (b: Record<string, unknown>) => ({ success: b.quoteToken === "q1" && b.expectedTotalCharged === 0, orderId: 77 }),
    });
    expect(await buyer.buy("brightlane.com", 15)).toEqual({ status: "bought", paidUsd: 10.99, ref: "77" });
    expect(calls).toEqual(["ud_domains_search", "ud_contacts_list", "ud_cart_get", "ud_cart_add_domain_registration", "ud_cart_quote", "ud_cart_checkout"]);
  });

  it("won't touch a cart with someone else's items in it", async () => {
    const { buyer, calls } = ud({ ...base, ud_cart_get: { items: [{ productId: 1, domain: "other.com" }] } });
    await expect(buyer.buy("brightlane.com", 15)).rejects.toThrow(AccountBlocked);
    expect(calls).not.toContain("ud_cart_add_domain_registration");
  });

  it("never lets a card pay: empties the cart and pauses instead", async () => {
    let cart: unknown[] = [];
    const { buyer, calls } = ud({
      ...base,
      ud_cart_get: () => ({ items: cart }),
      ud_cart_add_domain_registration: () => { cart = [{ productId: 5, domain: "brightlane.com" }]; return base.ud_cart_add_domain_registration; },
      ud_cart_quote: { quoteToken: "q1", quotedItemCount: 1, expectedTotalCharged: 1099, items: [{ domain: "brightlane.com", lineTotalCents: 1099 }] },
      ud_cart_remove: () => { cart = []; return {}; },
    });
    await expect(buyer.buy("brightlane.com", 15)).rejects.toThrow(/would go on a card/);
    expect(calls).toContain("ud_cart_remove");
    expect(calls).not.toContain("ud_cart_checkout");
  });

  it("skips a name only for resale", async () => {
    const { buyer } = ud({ ud_domains_search: { results: [{ name: "brightlane.com", marketplace: { status: "registered-listed-for-sale" }, pricing: { amount: 99900 } }] } });
    await expect(buyer.buy("brightlane.com", 15)).rejects.toThrow(/resale/);
  });
});

describe("purchase queue", () => {
  const PORT = 54390;
  let pg: PGlite, server: PGLiteSocketServer, sql: postgres.Sql;
  let accountId: string;

  beforeAll(async () => {
    pg = await PGlite.create();
    for (const m of loadMigrations()) await pg.exec(m.sql);
    server = new PGLiteSocketServer({ db: pg, port: PORT, host: "127.0.0.1" });
    await server.start();
    sql = postgres(`postgres://postgres@127.0.0.1:${PORT}/postgres`, { max: 1, onnotice: () => {} });
  });
  afterAll(async () => { await sql.end(); await server.stop(); await pg.close(); });

  beforeEach(async () => {
    await sql`truncate purchase_items, purchase_orders, registrar_accounts, domains cascade`;
    [{ id: accountId }] = await sql`insert into registrar_accounts (provider, label, credentials, created_by) values ('dynadot', 'Main', 'x', 'me') returning id`;
  });

  const account = (buyer: Partial<Buyer>): RegistrarAccount => ({
    id: accountId, provider: "dynadot", vendor: "Dynadot", label: "Main",
    client: { provider: "dynadot", dryRun: false, listAll: async () => [], getNs: async () => [], updateNs: async () => ({ pending: false }), buyer: { balance: async () => null, buy: vi.fn(), ...buyer } as Buyer },
  });
  const order = async (domains: string[], minutesAgo: number[], gap = 20) => {
    const [o] = await sql`insert into purchase_orders (created_by, max_price_usd, days, from_hour, to_hour, min_gap_minutes, timezone)
      values ('me', 12, 1, 0, 24, ${gap}, 'UTC') returning id`;
    for (const [i, d] of domains.entries()) {
      await sql`insert into purchase_items (order_id, domain, account_id, provider, scheduled_at)
        values (${o.id}, ${d}, ${accountId}, 'dynadot', now() - make_interval(mins => ${minutesAgo[i]}))`;
    }
    return o.id as string;
  };
  const items = () => sql`select domain, status, paid_usd::float8 as paid, message from purchase_items order by domain`;

  it("buys one due domain a run, adds it to the inventory, and waits out the gap", async () => {
    await order(["alpha.com", "bravo.com"], [10, 5]);
    const buy = vi.fn(async () => ({ status: "bought" as const, paidUsd: 10.5, ref: null }));
    const reg = [account({ buy })];
    expect(await processPurchases(sql, { registrars: reg })).toMatchObject({ bought: 1 });
    expect(buy).toHaveBeenCalledWith("alpha.com", 12);
    // The second is due, but the last buy was just now.
    expect(await processPurchases(sql, { registrars: reg })).toMatchObject({ bought: 0, waiting: 1 });
    const [d] = await sql`select d.registrar_account_id, v.name as vendor from domains d join vendors v on v.id = d.registrar_id where d.name = 'alpha.com'`;
    expect(d).toEqual({ registrar_account_id: accountId, vendor: "Dynadot" });
    expect(await items()).toEqual([
      { domain: "alpha.com", status: "bought", paid: 10.5, message: null },
      { domain: "bravo.com", status: "queued", paid: null, message: null },
    ]);
  });

  it("pauses the order when the account can't pay, keeping the domain queued", async () => {
    const id = await order(["alpha.com"], [1]);
    await processPurchases(sql, { registrars: [account({ buy: async () => { throw new AccountBlocked("Dynadot balance is too low"); } })] });
    const [o] = await sql`select paused_at is not null as paused, paused_reason from purchase_orders where id = ${id}`;
    expect(o).toEqual({ paused: true, paused_reason: "Dynadot balance is too low" });
    expect((await items())[0]).toMatchObject({ status: "queued", message: "Dynadot balance is too low" });
    // Resume gives it a fresh time ahead.
    await sql`update purchase_orders set paused_at = null where id = ${id}`;
    await replanOrder(sql, id);
    const [{ ahead }] = await sql`select scheduled_at > now() as ahead from purchase_items`;
    expect(ahead).toBe(true);
  });

  it("skips names already owned and records skips with the price", async () => {
    await sql`insert into domains (name) values ('alpha.com')`;
    await order(["alpha.com"], [1]);
    const buy = vi.fn();
    await processPurchases(sql, { registrars: [account({ buy })] });
    expect(buy).not.toHaveBeenCalled();
    expect((await items())[0]).toMatchObject({ status: "skipped", message: expect.stringContaining("Already in Domain Engine") });

    await sql`truncate purchase_items, purchase_orders cascade`;
    await order(["charlie.com"], [1]);
    await processPurchases(sql, { registrars: [account({ buy: async () => { throw new SkipPurchase("Costs $14.00, over your $12.00 limit", 14); } })] });
    const [s] = await sql`select status, quoted_usd::float8 as quoted from purchase_items`;
    expect(s).toEqual({ status: "skipped", quoted: 14 });
  });

  it("follows an order the registrar finishes later", async () => {
    await order(["alpha.com"], [1]);
    const reg = [account({ buy: async () => ({ status: "registering" as const, quotedUsd: 9, ref: "op1" }), follow: async () => ({ status: "bought" as const }) })];
    await processPurchases(sql, { registrars: reg });
    expect((await items())[0].status).toBe("registering");
    await processPurchases(sql, { registrars: reg });
    expect((await items())[0]).toMatchObject({ status: "bought", paid: 9 });
  });
});
