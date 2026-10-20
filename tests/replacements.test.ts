import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Porkbun } from "../src/integrations/porkbun";
import { actOnStep, advanceItem, advanceReplacements } from "../src/jobs/replacements";
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
