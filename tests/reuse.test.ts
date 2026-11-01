import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHypertide, type Hypertide, type OrderStatus } from "../src/integrations/hypertide";
import { syncHypertideOrders } from "../src/jobs/hypertide-sync";
import { loadMigrations } from "../scripts/migrations";

const res = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

describe("Hypertide orders paging", () => {
  it("follows nextCursor until hasMore is false", async () => {
    const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `rec${from + i}`, domain: `d${from + i}.com`, status: "NPC", paymentStatus: "Paid", createdAt: "2026-03-01" }));
    const fetchImpl = vi.fn(async (url: string) => {
      const cursor = new URL(url).searchParams.get("cursor");
      if (!cursor) return res({ success: true, orders: page(0, 100), hasMore: true, nextCursor: "c1" });
      if (cursor === "c1") return res({ success: true, orders: page(100, 100), hasMore: true, nextCursor: "c2" });
      return res({ success: true, orders: page(200, 7), hasMore: false, nextCursor: null });
    });
    const ht = createHypertide({ baseUrl: "https://ht.example/api/v1", apiKey: "k", dryRun: true, minSpacingMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    const orders = await ht.activeOrders();
    expect(orders).toHaveLength(207);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(String(fetchImpl.mock.calls[1][0])).toBe("https://ht.example/api/v1/orders/active?cursor=c1");
  });
});

describe("last used and cooling down", () => {
  const PORT = 54396;
  let pg: PGlite;
  let server: PGLiteSocketServer;
  let sql: postgres.Sql;

  beforeAll(async () => {
    pg = await PGlite.create();
    for (const m of loadMigrations()) await pg.exec(m.sql);
    server = new PGLiteSocketServer({ db: pg, port: PORT, host: "127.0.0.1" });
    await server.start();
    sql = postgres(`postgres://postgres@127.0.0.1:${PORT}/postgres`, { max: 1, onnotice: () => {} });
  });
  afterAll(async () => {
    await sql.end();
    await server.stop();
    await pg.close();
  });
  beforeEach(async () => {
    await sql`truncate hypertide_orders, domain_daily_stats, domains cascade`;
    await sql`update settings set value = '120' where key = 'reuse_after_days'`;
  });

  // Days counted from the database's own today, so the test holds in any timezone.
  let today = "";
  beforeEach(async () => { [{ today }] = await sql`select current_date::text as today`; });
  const ago = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
  const order = (id: string, domain: string, status: string, createdAt: string): OrderStatus =>
    ({ id, domain, status, paymentStatus: "Paid", subscriptionId: null, forwardingDomain: null, sendingTool: null, organizationName: null, createdAt });
  const fakeHt = (orders: OrderStatus[]) => ({ dryRun: false, activeOrders: vi.fn(async () => orders), pendingOrders: vi.fn(async () => []) }) as unknown as Hypertide;

  it("dates each domain's last use from Hypertide orders and sends, and keeps recently used ones out of the free pool", async () => {
    await sql`insert into domains (name) values ('never.com'), ('old.com'), ('recent.com'), ('sentrecently.com'), ('swapped.com')`;
    await sql`insert into domain_daily_stats (domain_id, day, sent) select id, ${ago(30)}::date, 40 from domains where name = 'sentrecently.com'`;
    await syncHypertideOrders(sql, { porkbun: null, hypertide: fakeHt([
      order("r1", "old.com", "NPC", ago(200)),
      order("r2", "recent.com", "NPC", ago(60)),
      order("r3", "newname.com", "Done", ago(40)),
    ]) });
    // Hypertide moved r3 from swapped.com to newname.com.
    await sql`update hypertide_orders set replaced_domains = '{swapped.com}' where id = 'r3'`;
    await sql`select refresh_last_used()`;

    const rows = await sql`select name, status, last_used_on::text as used,
      coalesce(status = 'in_storage' and last_used_on + reuse_after_days() > current_date, false) as cooling from domains order by name`;
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by["never.com"]).toMatchObject({ used: null, cooling: false });
    expect(by["old.com"]).toMatchObject({ used: ago(200), cooling: false });
    expect(by["recent.com"]).toMatchObject({ used: ago(60), cooling: true });
    expect(by["sentrecently.com"]).toMatchObject({ used: ago(30), cooling: true });
    expect(by["swapped.com"]).toMatchObject({ used: ago(40), cooling: true });

    // The Replace picker offers rested domains only, never-used first.
    const picks = await sql`
      select d.name from domains d
      where d.status = 'in_storage' and (d.last_used_on is null or d.last_used_on + reuse_after_days() <= current_date)
      order by (d.last_used_on is not null), (d.registrar_id is null), d.purchased_at nulls last, d.created_at, d.name`;
    expect(picks.map((p) => p.name)).toEqual(["never.com", "old.com"]);

    // A shorter window frees recent.com.
    await sql`update settings set value = '45' where key = 'reuse_after_days'`;
    const [r] = await sql`select last_used_on + reuse_after_days() <= current_date as free from domains where name = 'recent.com'`;
    expect(r.free).toBe(true);
  });

  it("records the day an order is first seen cancelled, and doesn't count Cancelled orders as setup", async () => {
    await sql`insert into domains (name) values ('a.com'), ('b.com')`;
    await syncHypertideOrders(sql, { porkbun: null, hypertide: fakeHt([order("r1", "a.com", "Done", ago(300)), order("r2", "b.com", "Cancelled", ago(10))]) });
    const before = await sql`select d.name, d.status from domains d order by name`;
    expect(before.map((d) => [d.name, d.status])).toEqual([["a.com", "provisioning"], ["b.com", "in_storage"]]);

    await syncHypertideOrders(sql, { porkbun: null, hypertide: fakeHt([order("r1", "a.com", "NPC", ago(300)), order("r2", "b.com", "Cancelled", ago(10))]) });
    const [o] = await sql`select ended_on::text as ended from hypertide_orders where id = 'r1'`;
    expect(o.ended).toBe(ago(0));
    const [d] = await sql`select last_used_on::text as used from domains where name = 'a.com'`;
    expect(d.used).toBe(ago(0));
  });
});
