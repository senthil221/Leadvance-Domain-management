import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hypertide, OrderStatus } from "../src/integrations/hypertide";
import { readOrders } from "../src/integrations/hypertide";
import type { Porkbun } from "../src/integrations/porkbun";
import { syncHypertideOrders } from "../src/jobs/hypertide-sync";
import { processNameserverRequests } from "../src/jobs/nameservers";
import { advanceItem } from "../src/jobs/replacements";
import { loadMigrations } from "../scripts/migrations";

const PORT = 54398;
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

const PAIR = ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"];
let pbId: string;
const fakePorkbun = (over: Partial<Porkbun> = {}) =>
  ({ dryRun: false, updateNs: vi.fn(async () => ({})), getNs: vi.fn(async () => PAIR), ...over }) as unknown as Porkbun;
const fakeHypertide = (paid: OrderStatus[] = [], unpaid: OrderStatus[] = []) =>
  ({
    dryRun: false,
    previewNameservers: vi.fn(async (names: string[]) => new Map(names.map((n) => [n, PAIR]))),
    activeOrders: vi.fn(async () => paid),
    pendingOrders: vi.fn(async () => unpaid),
  }) as unknown as Hypertide;
const domain = async (name: string) => (await sql`select * from domains where name = ${name}`)[0];
const request = async (name: string) =>
  (await sql`select r.* from nameserver_requests r join domains d on d.id = r.domain_id where d.name = ${name} order by r.created_at desc limit 1`)[0];

beforeEach(async () => {
  await sql`truncate nameserver_requests, hypertide_orders, replacement_items, replacement_batches, inboxes, domain_status_history, domains, clients cascade`;
  [{ id: pbId }] = await sql`select id from vendors where name = 'Porkbun'`;
  await sql`insert into domains (name, registrar_id, registrar_api_access) values ('freeone.com', ${pbId}, true), ('freetwo.com', ${pbId}, true)`;
  await sql`insert into domains (name) values ('elsewhere.com')`;
});

describe("nameserver requests", () => {
  it("switches Porkbun domains to the Hypertide pair and lists the pair for other registrars", async () => {
    await sql`insert into nameserver_requests (domain_id, source, actor) select id, 'hypertide', 'me' from domains`;
    const pb = fakePorkbun();
    const r = await processNameserverRequests(sql, { porkbun: pb, hypertide: fakeHypertide() });
    expect(r).toMatchObject({ requests: 3, done: 2, manual: 1 });
    expect(pb.updateNs).toHaveBeenCalledWith("freeone.com", PAIR);
    expect((await domain("freeone.com")).nameservers).toEqual(PAIR);
    const manual = await request("elsewhere.com");
    expect(manual.status).toBe("manual");
    expect(manual.target).toEqual(PAIR);
  });

  it("only records what it would do in dry run", async () => {
    await sql`insert into nameserver_requests (domain_id, source, target, actor)
      select id, 'custom', array['NS1.Example.net', 'ns2.example.net'], 'me' from domains where name = 'freeone.com'`;
    const pb = fakePorkbun({ dryRun: true });
    await processNameserverRequests(sql, { porkbun: pb, hypertide: null });
    expect(pb.getNs).not.toHaveBeenCalled();
    const r = await request("freeone.com");
    expect(r.status).toBe("dry_run");
    expect(r.target).toEqual(["ns1.example.net", "ns2.example.net"]);
  });

  it("fails clearly without Hypertide or a saved pair", async () => {
    await sql`insert into nameserver_requests (domain_id, source, actor) select id, 'hypertide', 'me' from domains where name = 'freeone.com'`;
    await processNameserverRequests(sql, { porkbun: fakePorkbun(), hypertide: null });
    const r = await request("freeone.com");
    expect(r.status).toBe("failed");
    expect(r.message).toMatch(/Hypertide isn't connected/);
  });

  it("flags a change Porkbun didn't apply", async () => {
    await sql`insert into nameserver_requests (domain_id, source, actor) select id, 'hypertide', 'me' from domains where name = 'freeone.com'`;
    await processNameserverRequests(sql, { porkbun: fakePorkbun({ getNs: vi.fn(async () => ["curitiba.porkbun.com"]) }), hypertide: fakeHypertide() });
    expect((await request("freeone.com")).status).toBe("failed");
  });
});

describe("Hypertide order sync", () => {
  it("reads orders defensively", () => {
    expect(readOrders({ orders: [{ id: "rec1", domain: " FreeOne.com ", status: "Done", paymentStatus: "Paid" }, { id: "", domain: "x.com" }] }))
      .toEqual([expect.objectContaining({ id: "rec1", domain: "freeone.com", status: "Done", paymentStatus: "Paid" })]);
  });

  it("mirrors orders, adds unknown domains and moves ordered storage domains to provisioning", async () => {
    const ht = fakeHypertide(
      [{ id: "rec1", domain: "freeone.com", status: "In progress", paymentStatus: "Paid", subscriptionId: "sub_1" }],
      [{ id: "rec2", domain: "brandnew.com", status: "Todo", paymentStatus: "Unpaid" }],
    );
    const r = await syncHypertideOrders(sql, { porkbun: null, hypertide: ht });
    expect(r).toMatchObject({ orders: 2, added: 1, provisioning: 2 });
    expect((await domain("freeone.com")).status).toBe("provisioning");
    expect((await domain("brandnew.com")).status).toBe("provisioning");
    expect((await domain("freetwo.com")).status).toBe("in_storage");
    const [o] = await sql`select * from hypertide_orders where id = 'rec1'`;
    expect(o).toMatchObject({ payment_status: "Paid", subscription_id: "sub_1", gone_at: null });

    // Cancelled orders drop out of the feed and are marked gone.
    await syncHypertideOrders(sql, { porkbun: null, hypertide: fakeHypertide() });
    expect((await sql`select count(*)::int as n from hypertide_orders where gone_at is not null`)[0].n).toBe(2);
  });

  it("finishes a hand-ordered replacement's inbox step once the order is Done", async () => {
    const [client] = await sql`insert into clients (name) values ('Kapable') returning id`;
    const [old] = await sql`insert into domains (name, status, client_id) values ('oldsend.com', 'active', ${client.id}) returning id`;
    const fresh = await domain("freeone.com");
    await sql`insert into inboxes (domain_id, email, sender_name, status) values (${old.id}, 'amy@oldsend.com', 'Amy Wren', 'connected')`;
    const [b] = await sql`select start_replacement(array[${old.id}]::uuid[], array[${fresh.id}]::uuid[], 'high_bounce', null, 'me') as id`;
    await sql`update replacement_batches set manual_inboxes = true where id = ${b.id}`;
    await sql`update replacement_items set step_nameservers = 'done' where batch_id = ${b.id}`;
    const [item] = await sql`select id from replacement_items where batch_id = ${b.id}`;

    const ht = fakeHypertide([{ id: "rec9", domain: "freeone.com", status: "In progress", paymentStatus: "Paid" }]);
    await advanceItem(sql, { porkbun: null, hypertide: ht }, item.id);
    let [s] = await sql`select step_inboxes, note from replacement_items where id = ${item.id}`;
    expect(s.step_inboxes).toBe("manual");
    expect(s.note).toMatch(/finishes on its own/);

    await syncHypertideOrders(sql, { porkbun: null, hypertide: ht });
    [s] = await sql`select step_inboxes from replacement_items where id = ${item.id}`;
    expect(s.step_inboxes).toBe("manual");

    const done = fakeHypertide([{ id: "rec9", domain: "freeone.com", status: "Done", paymentStatus: "Paid" }]);
    const r = await syncHypertideOrders(sql, { porkbun: null, hypertide: done });
    expect(r.replacementsReady).toBe(1);
    [s] = await sql`select step_inboxes, step_smartlead from replacement_items where id = ${item.id}`;
    expect(s.step_inboxes).toBe("done");
    expect(s.step_smartlead).toBe("running");
  });
});
