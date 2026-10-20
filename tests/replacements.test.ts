import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Porkbun } from "../src/integrations/porkbun";
import type { Hypertide } from "../src/integrations/hypertide";
import { actOnStep, advanceItem, advanceReplacements, approveHypertidePayment, trackHypertideOrders } from "../src/jobs/replacements";
import { loadMigrations } from "../scripts/migrations";

// The step runner uses the same Postgres client as production, so it runs
// against PGlite served over a socket.
const PORT = 54399;
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

let itemId: string;
let oldId: string;
let newId: string;

const step = async (col: string) => (await sql.unsafe(`select ${col} as s, note, last_error from replacement_items where id = $1`, [itemId]))[0];
const status = async (id: string) => (await sql`select status from domains where id = ${id}`)[0].status;
const fakePorkbun = (over: Partial<Porkbun> = {}) =>
  ({ dryRun: false, updateNs: vi.fn(async () => ({})), getNs: vi.fn(async () => ["ns1.hypertide.io", "ns2.hypertide.io"]), ...over }) as unknown as Porkbun;

beforeEach(async () => {
  await sql`truncate replacement_items, replacement_batches, campaign_inboxes, campaigns, inboxes, domain_status_history, alerts, domains, clients cascade`;
  await sql`update settings set value = '[]' where key = 'hypertide_nameservers'`;
  const [porkbun] = await sql`select id from vendors where name = 'Porkbun'`;
  const [client] = await sql`insert into clients (name) values ('Qualifi') returning id`;
  [{ id: oldId }] = await sql`insert into domains (name, status, client_id) values ('oldsend.com', 'active', ${client.id}) returning id`;
  [{ id: newId }] = await sql`insert into domains (name, registrar_id, registrar_api_access) values ('freshsend.com', ${porkbun.id}, true) returning id`;
  await sql`insert into inboxes (domain_id, email, sender_name, status, smartlead_account_id) values
    (${oldId}, 'amelia.wren@oldsend.com', 'Amelia Wren', 'connected', 11),
    (${oldId}, 'awren@oldsend.com', 'Amelia Wren', 'connected', 12),
    (${oldId}, 'sophia@oldsend.com', 'Sophia Lark', 'connected', 13)`;
  await sql`insert into campaigns (id, name) values (501, '1-Qualifi-Staffing 1-10 TM')`;
  await sql`insert into campaign_inboxes (campaign_id, inbox_id) select 501, id from inboxes where domain_id = ${oldId}`;
  const [b] = await sql`select start_replacement(array[${oldId}]::uuid[], array[${newId}]::uuid[], 'high_bounce', null, 'me') as id`;
  [{ id: itemId }] = await sql`select id from replacement_items where batch_id = ${b.id}`;
});

describe("replacement steps", () => {
  it("asks for the Hypertide nameservers when none are set", async () => {
    await advanceItem(sql, { porkbun: fakePorkbun() }, itemId);
    const s = await step("step_nameservers");
    expect(s.s).toBe("manual");
    expect(s.note).toMatch(/Settings/);
  });

  it("runs the whole lifecycle: nameservers via Porkbun, manual inboxes, Smartlead check, campaigns, then statuses", async () => {
    await sql`update settings set value = '["ns1.hypertide.io","ns2.hypertide.io"]' where key = 'hypertide_nameservers'`;
    const pb = fakePorkbun();
    await advanceItem(sql, { porkbun: pb }, itemId);

    expect(pb.updateNs).toHaveBeenCalledWith("freshsend.com", ["ns1.hypertide.io", "ns2.hypertide.io"]);
    expect((await step("step_nameservers")).s).toBe("done");
    const inboxes = await step("step_inboxes");
    expect(inboxes.s).toBe("manual");
    expect(inboxes.note).toContain("Order 3 inboxes");
    expect(inboxes.note).toContain("Amelia Wren ×2, Sophia Lark");

    await actOnStep(sql, { porkbun: pb }, itemId, "inboxes", "done", "me");
    expect((await step("step_smartlead")).s).toBe("running");
    expect(await status(newId)).toBe("provisioning");

    // The Smartlead sync finds the new inboxes.
    await sql`insert into inboxes (domain_id, email, status) values (${newId}, 'amelia.wren@freshsend.com', 'connected')`;
    await advanceItem(sql, { porkbun: pb }, itemId);
    expect((await step("step_smartlead")).s).toBe("done");
    expect(await status(newId)).toBe("warming");
    const campaigns = await step("step_campaigns");
    expect(campaigns.s).toBe("manual");
    expect(campaigns.note).toContain("1-Qualifi-Staffing 1-10 TM");

    const r = await actOnStep(sql, { porkbun: pb }, itemId, "campaigns", "done", "me");
    expect(r.completed).toBe(true);
    expect(await status(newId)).toBe("active");
    expect(await status(oldId)).toBe("draining");

    const summary = await advanceReplacements(sql, { porkbun: pb });
    expect(summary.batchesCompleted).toBe(1);
  });

  it("in dry-run, logs the change and leaves the step for a person", async () => {
    await sql`update settings set value = '["ns1.hypertide.io"]' where key = 'hypertide_nameservers'`;
    const pb = fakePorkbun({ dryRun: true } as Partial<Porkbun>);
    await advanceItem(sql, { porkbun: pb }, itemId);
    const s = await step("step_nameservers");
    expect(s.s).toBe("manual");
    expect(s.note).toMatch(/^Dry run/);
    expect(pb.updateNs).toHaveBeenCalled();
    expect(pb.getNs).not.toHaveBeenCalled();
  });

  it("fails clearly when Porkbun doesn't show the new nameservers, and Retry tries again", async () => {
    await sql`update settings set value = '["ns1.hypertide.io","ns2.hypertide.io"]' where key = 'hypertide_nameservers'`;
    const stale = fakePorkbun({ getNs: vi.fn(async () => ["curitiba.ns.porkbun.com"]) } as Partial<Porkbun>);
    await advanceItem(sql, { porkbun: stale }, itemId);
    const s = await step("step_nameservers");
    expect(s.s).toBe("failed");
    expect(s.last_error).toMatch(/still reports curitiba\.ns\.porkbun\.com/);

    await actOnStep(sql, { porkbun: fakePorkbun() }, itemId, "nameservers", "retry", "me");
    expect((await step("step_nameservers")).s).toBe("done");
  });

  it("gives instructions instead of calling Porkbun for other registrars", async () => {
    await sql`update settings set value = '["ns1.hypertide.io"]' where key = 'hypertide_nameservers'`;
    await sql`update domains set registrar_id = (select id from vendors where name = 'Unstoppable Domains') where id = ${newId}`;
    const pb = fakePorkbun();
    await advanceItem(sql, { porkbun: pb }, itemId);
    expect((await step("step_nameservers")).note).toMatch(/at Unstoppable Domains/);
    expect(pb.updateNs).not.toHaveBeenCalled();
  });

  it("only lets a person act on the current step", async () => {
    await expect(actOnStep(sql, { porkbun: null }, itemId, "campaigns", "done", "me")).rejects.toThrow(/earlier steps/);
  });
});

describe("replacement steps through Hypertide", () => {
  const pair = ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"];
  const creds = { api_key: "sl", username: "ops@leadvance.io", password: "pw", oauth_link: "https://login.microsoftonline.com/x" };
  const fakeHypertide = (over: Partial<Hypertide> = {}) => ({
    dryRun: false,
    previewNameservers: vi.fn(async () => new Map([["freshsend.com", pair]])),
    createOrder: vi.fn(async () => ({ dryRun: false, recordId: "recNEW1", nameservers: new Map(), message: null })),
    charge: vi.fn(async () => ({ dryRun: false, message: "Payment processed successfully" })),
    verifyNameservers: vi.fn(async () => ({ dryRun: false, results: [{ domain: "freshsend.com", verified: true, message: null, expected: pair, current: pair }] })),
    activeOrders: vi.fn(async () => [{ id: "recNEW1", domain: "freshsend.com", status: "Done", paymentStatus: "Paid" }]),
    ...over,
  }) as unknown as Hypertide;
  const setTemplate = (forwarding: string) =>
    sql`update settings set value = ${sql.json({ plan: "entra", inbox_quantity: 50, forwarding_domain: forwarding, client_name: "" })} where key = 'hypertide_order_template'`;

  it("points the domain at its own Hypertide pair, orders, waits for payment, then follows the order to Done", async () => {
    await setTemplate("leadvance.io");
    const ht = fakeHypertide();
    const pb = fakePorkbun({ getNs: vi.fn(async () => pair) } as Partial<Porkbun>);
    const ctx = { porkbun: pb, hypertide: ht, hypertideCredentials: creds };

    await advanceItem(sql, ctx, itemId);
    expect(pb.updateNs).toHaveBeenCalledWith("freshsend.com", pair);
    expect((await sql`select hypertide_ns from replacement_items where id = ${itemId}`)[0].hypertide_ns).toEqual(pair);

    // The order went out with the old domain's senders and the template.
    const payload = (ht.createOrder as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload).toMatchObject({ plan: "entra", domains: ["freshsend.com"], forwarding_domain: "leadvance.io", client_name: "Qualifi" });
    expect(payload.users).toEqual([{ first_name: "Amelia", last_name: "Wren" }, { first_name: "Sophia", last_name: "Lark" }]);
    const inboxes = await step("step_inboxes");
    expect(inboxes.s).toBe("manual");
    expect(inboxes.note).toMatch(/not paid yet/);
    expect(ht.charge).not.toHaveBeenCalled();

    // Nothing is charged until a person approves; then the order is tracked.
    const paid = await approveHypertidePayment(sql, ctx, [itemId], "me");
    expect(paid).toEqual({ charged: 1, dryRun: false });
    expect(ht.charge).toHaveBeenCalledWith(["recNEW1"], expect.stringContaining("approved by me"));
    expect((await step("step_inboxes")).s).toBe("running");

    const tracked = await trackHypertideOrders(sql, ctx);
    expect(tracked).toMatchObject({ open: 1, verified: 1, done: 1 });
    expect((await step("step_inboxes")).s).toBe("done");
    expect((await step("step_smartlead")).s).toBe("running");

    await expect(approveHypertidePayment(sql, ctx, [itemId], "me")).rejects.toThrow(/Nothing to pay for/);
  });

  it("in dry-run, has Hypertide check the order without placing it", async () => {
    await setTemplate("leadvance.io");
    await sql`update replacement_items set step_nameservers = 'done' where id = ${itemId}`;
    const ht = fakeHypertide({ dryRun: true, createOrder: vi.fn(async () => ({ dryRun: true, recordId: null, nameservers: new Map(), message: "ok" })) } as Partial<Hypertide>);
    await advanceItem(sql, { porkbun: null, hypertide: ht, hypertideCredentials: creds }, itemId);
    const s = await step("step_inboxes");
    expect(s.s).toBe("manual");
    expect(s.note).toMatch(/^Dry run: Hypertide checked the order \(50 Microsoft inboxes for freshsend\.com\)/);
    expect((await sql`select hypertide_order_id from replacement_items where id = ${itemId}`)[0].hypertide_order_id).toBeNull();
  });

  it("says what's missing instead of sending an incomplete order", async () => {
    await setTemplate("");
    await sql`update replacement_items set step_nameservers = 'done' where id = ${itemId}`;
    const ht = fakeHypertide();
    await advanceItem(sql, { porkbun: null, hypertide: ht, hypertideCredentials: { api_key: "sl" } }, itemId);
    const s = await step("step_inboxes");
    expect(s.s).toBe("manual");
    expect(s.note).toMatch(/Can't order on Hypertide yet: .*forwarding domain.*Smartlead login.*OAuth/);
    expect(ht.createOrder).not.toHaveBeenCalled();
  });
});
