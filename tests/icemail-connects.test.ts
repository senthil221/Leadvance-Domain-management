import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSmartlead, savedAccountId } from "../src/integrations/smartlead";
import { processSmartleadConnects, queueReadyConnects } from "../src/jobs/icemail-connects";
import type { IcemailAccount } from "../src/jobs/icemail-sync";
import { itemStage } from "../src/lib/icemail-board";
import { loadMigrations } from "../scripts/migrations";

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const SECRET = "abcd efgh ijkl mnop";

describe("Smartlead save reply", () => {
  it("finds the new account id wherever Smartlead puts it", () => {
    expect(savedAccountId({ ok: true, data: { id: 412 } })).toBe(412);
    expect(savedAccountId({ ok: true, emailAccountId: "77" })).toBe(77);
    expect(savedAccountId({ ok: true, message: "saved" })).toBeNull();
  });
});

describe("Icemail inboxes into Smartlead", () => {
  const PORT = 54410;
  let pg: PGlite;
  let server: PGLiteSocketServer;
  let sql: postgres.Sql;
  let accountId: string;

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

  /** fresh.io ordered with 3 inboxes for Qualifi (Smartlead client 9); `active` of them active at Icemail. */
  const seed = async (active = 3) => {
    await sql`truncate domains, clients, icemail_accounts, api_calls, job_state cascade`;
    [{ id: accountId }] = await sql`insert into icemail_accounts (label, credentials, webhook_token, created_by)
      values ('Main', 'sealed', ${"a".repeat(48)}, 'me') returning id`;
    const [c] = await sql`insert into clients (name, smartlead_client_id) values ('Qualifi', 9) returning id`;
    await sql`insert into domains (name, client_id) values ('fresh.io', ${c.id})`;
    // A connected Google inbox of the same client: its limits are copied.
    const [peer] = await sql`insert into domains (name, client_id) values ('old.io', ${c.id}) returning id`;
    await sql`insert into inboxes (domain_id, email, status, provider_type, daily_limit, min_wait_mins, smartlead_account_id)
      values (${peer.id}, 'a@old.io', 'connected', 'GMAIL', 15, 12, 1)`;
    const [o] = await sql`insert into icemail_orders (account_id, client_id, provider, created_by) values (${accountId}, ${c.id}, 'GOOGLE', 'me') returning id`;
    await sql`insert into icemail_order_items (order_id, domain_name, mailboxes, status, finished_at)
      values (${o.id}, 'fresh.io', ${sql.json(["sendil", "sendil.nathan", "sendil.n"].map((u) => ({ first_name: "Sendil", last_name: "Nathan", username: `${u}@fresh.io` })))}, 'ordered', now())`;
    await sql`insert into icemail_domains (id, account_id, domain_name) values ('dm1', ${accountId}, 'fresh.io')`;
    for (const [n, u] of ["sendil", "sendil.nathan", "sendil.n"].entries()) {
      await sql`insert into icemail_mailboxes (id, account_id, icemail_domain_id, email, first_name, last_name, status, active)
        values (${`mb${n}`}, ${accountId}, 'dm1', ${`${u}@fresh.io`}, 'Sendil', 'Nathan', ${n < active ? "ACTIVE" : "UPDATING"}, ${n < active})`;
    }
  };
  beforeEach(() => seed());

  const icemail = (passwords: Record<string, string | null | Error>): IcemailAccount => ({
    id: accountId, label: "Main",
    client: {
      appPassword: async (id: string) => {
        const p = passwords[id];
        if (p instanceof Error) throw p;
        return p ?? null;
      },
    } as unknown as IcemailAccount["client"],
  });
  const smartlead = (reply: (body: Record<string, unknown>) => Response, dryRun = false) => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return reply(body);
    }) as unknown as typeof fetch;
    return { client: createSmartlead({ apiKey: "k", sql, dryRun, fetchImpl, minSpacingMs: 0 }), bodies };
  };
  const statuses = async () => (await sql`select email, status, smartlead_account_id::int as sl from icemail_connects order by email`).map((r) => [r.email, r.status, r.sl]);

  it("queues a domain once all its inboxes are active, each inbox once", async () => {
    await seed(2);
    expect(await queueReadyConnects(sql)).toBe(0);
    await seed(3);
    expect(await queueReadyConnects(sql)).toBe(3);
    expect(await queueReadyConnects(sql)).toBe(0);
  });

  it("skips an inbox already in Smartlead", async () => {
    const [d] = await sql`select id from domains where name = 'fresh.io'`;
    await sql`insert into inboxes (domain_id, email, status, smartlead_account_id) values (${d.id}, 'sendil@fresh.io', 'connected', 50)`;
    expect(await queueReadyConnects(sql)).toBe(2);
  });

  it("adds each inbox with its app password, the client's limits and the warmup settings, and keeps no password", async () => {
    await queueReadyConnects(sql);
    let next = 100;
    const sl = smartlead(() => ok({ ok: true, data: { id: next++ } }));
    const r = await processSmartleadConnects(sql, [icemail({ mb0: SECRET, mb1: SECRET, mb2: SECRET })], sl.client);
    expect(r).toEqual({ connected: 3, dryRun: 0, noPassword: 0, failed: 0 });
    expect(sl.bodies.find((b) => b.from_email === "sendil.n@fresh.io")).toMatchObject({
      type: "GMAIL", from_name: "Sendil Nathan", from_email: "sendil.n@fresh.io", user_name: "sendil.n@fresh.io", password: SECRET,
      smtp_host: "smtp.gmail.com", imap_host: "imap.gmail.com", imap_port: 993,
      max_email_per_day: 15, time_to_wait_in_mins: 12, client_id: 9,
      warmup_enabled: true, total_warmup_per_day: 20, daily_rampup: 2, reply_rate_percentage: 40,
    });
    const rows = await statuses();
    expect(rows.map(([e, st]) => [e, st])).toEqual([["sendil.n@fresh.io", "connected"], ["sendil.nathan@fresh.io", "connected"], ["sendil@fresh.io", "connected"]]);
    expect(rows.map((x) => x[2]).sort()).toEqual([100, 101, 102]);
    // The password is nowhere in the database.
    for (const t of ["icemail_connects", "api_calls", "job_state"]) expect(JSON.stringify(await sql`select * from ${sql(t)}`)).not.toContain("efgh");
    // The new accounts are pulled in by the next Smartlead sync.
    expect((await sql`select job from job_state where job = 'smartlead-accounts'`).length).toBe(1);
  });

  it("waits for an app password, and says what Smartlead refused", async () => {
    await queueReadyConnects(sql);
    const sl = smartlead((b) => (b.from_email === "sendil.n@fresh.io" ? ok({ ok: false, message: "Authentication failed" }) : ok({ ok: true, data: { id: 5 } })));
    const r = await processSmartleadConnects(sql, [icemail({ mb0: null, mb1: SECRET, mb2: SECRET })], sl.client);
    expect(r).toEqual({ connected: 1, dryRun: 0, noPassword: 1, failed: 1 });
    const rows = await sql`select email, status, message from icemail_connects order by email`;
    expect(rows.map((x) => x.status)).toEqual(["failed", "connected", "no_password"]);
    expect(rows[0].message).toBe("Smartlead refused it: Authentication failed. Nothing was added");
    expect(rows[2].message).toMatch(/hasn't set this inbox's Google app password yet/);
    // Not tried again before 30 minutes.
    expect((await processSmartleadConnects(sql, [icemail({ mb0: SECRET })], sl.client)).connected).toBe(0);
  });

  it("can't tell after a server error, and asks Smartlead nothing in dry run", async () => {
    await queueReadyConnects(sql);
    const broken = smartlead(() => ok({ message: "oops" }, 502));
    await processSmartleadConnects(sql, [icemail({ mb0: SECRET, mb1: SECRET, mb2: SECRET })], broken.client, { max: 1 });
    const [failed] = await sql`select message from icemail_connects where status = 'failed'`;
    expect(failed.message).toMatch(/unclear whether Smartlead added it/);
    expect(broken.bodies.length).toBe(1); // sent once, never repeated

    const dry = smartlead(() => ok({}), true);
    const r = await processSmartleadConnects(sql, [icemail({ mb0: SECRET, mb1: SECRET, mb2: SECRET })], dry.client);
    expect(r.dryRun).toBe(2);
    expect(dry.bodies.length).toBe(0);
  });

  it("shows where an order's domain is on its way to Smartlead", () => {
    const base = { status: "ordered", message: null, nsStatus: null, mailboxes: 3, atIcemail: 3, activeAtIcemail: 3, otherStatus: null, inSmartlead: 0 };
    expect(itemStage({ ...base, connectQueued: 3 }).text).toBe("Adding 3 inboxes to Smartlead");
    expect(itemStage({ ...base, connectNoPassword: 1, connectDone: 2 }).label).toBe("Waiting");
    expect(itemStage({ ...base, connectFailed: 1, connectError: "Smartlead refused it: Authentication failed. Nothing was added" }))
      .toMatchObject({ label: "Not connected", tone: "danger" });
    expect(itemStage({ ...base, connectDone: 3 }).text).toMatch(/after the next Smartlead sync/);
    expect(itemStage({ ...base, connectDone: 3, inSmartlead: 3 }).label).toBe("Live");
  });
});
