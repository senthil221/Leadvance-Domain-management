import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createIcemail, parseIcemailExport } from "../src/integrations/icemail";
import { processIcemailExports, queueReadyExports, smartleadLoginFromEnv } from "../src/jobs/icemail-exports";
import type { IcemailAccount } from "../src/jobs/icemail-sync";
import { itemStage } from "../src/lib/icemail-board";
import { loadMigrations } from "../scripts/migrations";

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const LOGIN = { username: "otp@example.com", password: "hunter2-secret" };

describe("Smartlead login for Icemail's export", () => {
  it("takes the Icemail one, else Hypertide's, else none", () => {
    expect(smartleadLoginFromEnv({ ICEMAIL_SMARTLEAD_USERNAME: "a@x.io", ICEMAIL_SMARTLEAD_PASSWORD: "p", HYPERTIDE_SMARTLEAD_USERNAME: "h@x.io", HYPERTIDE_SMARTLEAD_PASSWORD: "q" }))
      .toEqual({ username: "a@x.io", password: "p" });
    expect(smartleadLoginFromEnv({ HYPERTIDE_SMARTLEAD_USERNAME: " h@x.io ", HYPERTIDE_SMARTLEAD_PASSWORD: "q" })).toEqual({ username: "h@x.io", password: "q" });
    expect(smartleadLoginFromEnv({ ICEMAIL_SMARTLEAD_USERNAME: "a@x.io" })).toBeNull();
  });

  it("sends the export once, with the login in the body and not in the log", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return ok({ message: "Too many" }, 429);
    }) as unknown as typeof fetch;
    const icemail = createIcemail({ apiKey: "k", fetchImpl, minSpacingMs: 0, dryRun: false });
    await expect(icemail.exportToSmartlead(["m1"], LOGIN, "Domain Engine · a.io")).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(1); // a 429 isn't retried: it refused the whole export
    expect(calls[0].body).toEqual({ mailbox_ids: ["m1"], sequencer: "smartlead", name: "Domain Engine · a.io", username: LOGIN.username, password: LOGIN.password });
    expect(parseIcemailExport({ status: "COMPLETED", total: 3, processed: 3, success: 2, failed: 1 })).toEqual({ status: "completed", total: 3, processed: 3, succeeded: 2, failed: 1 });
  });
});

describe("Icemail inboxes exported to Smartlead", () => {
  const PORT = 54410;
  let pg: PGlite;
  let server: PGLiteSocketServer;
  let sql: postgres.Sql;
  let accountId: string;
  let itemId: string;

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

  /** fresh.pro ordered with 3 inboxes; `active` of them active at Icemail. */
  const seed = async (active = 3) => {
    await sql`truncate domains, clients, icemail_accounts, api_calls, job_state cascade`;
    [{ id: accountId }] = await sql`insert into icemail_accounts (label, credentials, webhook_token, created_by)
      values ('Main', 'sealed', ${"a".repeat(48)}, 'me') returning id`;
    await sql`insert into domains (name) values ('fresh.pro')`;
    const [o] = await sql`insert into icemail_orders (account_id, provider, created_by) values (${accountId}, 'GOOGLE', 'me') returning id`;
    [{ id: itemId }] = await sql`insert into icemail_order_items (order_id, domain_name, mailboxes, status, finished_at)
      values (${o.id}, 'fresh.pro', ${sql.json(["steve", "steve.k", "stevek"].map((u) => ({ first_name: "Steve", last_name: "K", username: `${u}@fresh.pro` })))}, 'ordered', now()) returning id`;
    await sql`insert into icemail_domains (id, account_id, domain_name) values ('dm1', ${accountId}, 'fresh.pro')`;
    for (const [n, u] of ["steve", "steve.k", "stevek"].entries()) {
      await sql`insert into icemail_mailboxes (id, account_id, icemail_domain_id, email, status, active)
        values (${`mb${n}`}, ${accountId}, 'dm1', ${`${u}@fresh.pro`}, ${n < active ? "ACTIVE" : "UPDATING"}, ${n < active})`;
    }
  };
  beforeEach(() => seed());

  type Fake = { exports: { ids: string[]; login: unknown }[]; republished: string[]; status: Record<string, unknown> };
  const icemail = (fake: Fake, opts: { dry?: boolean; fail?: Error; exportId?: string | null } = {}): IcemailAccount => ({
    id: accountId, label: "Main",
    client: {
      exportToSmartlead: async (ids: string[], login: unknown) => {
        fake.exports.push({ ids, login });
        if (opts.fail) throw opts.fail;
        return opts.dry ? null : { exportId: opts.exportId === undefined ? "exp1" : opts.exportId, total: ids.length };
      },
      exportStatus: async () => parseIcemailExport(fake.status),
      republishExport: async (id: string) => { fake.republished.push(id); return !opts.dry; },
    } as unknown as IcemailAccount["client"],
  });
  const fake = (): Fake => ({ exports: [], republished: [], status: { status: "processing", total: 3, processed: 1 } });
  const row = async () => (await sql`select * from icemail_exports`)[0];

  it("queues a domain once all its inboxes are active, once, leaving out ones in Smartlead", async () => {
    await seed(2);
    expect(await queueReadyExports(sql)).toBe(0);
    await seed(3);
    const [d] = await sql`select id from domains where name = 'fresh.pro'`;
    await sql`insert into inboxes (domain_id, email, status, smartlead_account_id) values (${d.id}, 'steve@fresh.pro', 'connected', 9)`;
    expect(await queueReadyExports(sql)).toBe(1);
    expect(await queueReadyExports(sql)).toBe(0);
    expect((await row()).mailbox_ids).toEqual(["mb1", "mb2"]);
  });

  it("counts an inbox ready only when its status is ACTIVE, and puts back an export Icemail says is too early", async () => {
    const { ApiError } = await import("../src/integrations/http");
    // Icemail's flag says active while the inbox is still being set up.
    await sql`update icemail_mailboxes set status = 'IN_PROGRESS', active = true`;
    expect(await queueReadyExports(sql)).toBe(0);

    // Queued from an older sync: put back without asking Icemail.
    await sql`insert into icemail_exports (account_id, order_item_id, domain_name, mailbox_ids, created_by)
      values (${accountId}, ${itemId}, 'fresh.pro', ${["mb0", "mb1", "mb2"]}, 'me')`;
    const f = fake();
    expect((await processIcemailExports(sql, [icemail(f)], LOGIN)).notReady).toBe(1);
    expect(f.exports).toHaveLength(0);
    expect(await row()).toMatchObject({ status: "cancelled", message: expect.stringMatching(/^Not every inbox was ACTIVE at Icemail yet \(steve\.k@fresh\.pro \(IN_PROGRESS\)/) });

    // Active by our sync, but Icemail still refuses: put back too.
    await sql`update icemail_mailboxes set status = 'ACTIVE'`;
    expect(await queueReadyExports(sql)).toBe(1);
    const tooEarly = new ApiError("icemail /export failed: Cannot export mailboxes that are not ACTIVE. Non-active mailboxes: steve@fresh.pro (IN_PROGRESS)", 400);
    expect((await processIcemailExports(sql, [icemail(fake(), { fail: tooEarly })], LOGIN)).notReady).toBe(1);
    expect((await sql`select status, message from icemail_exports order by created_at desc limit 1`)[0])
      .toMatchObject({ status: "cancelled", message: "Not every inbox was ACTIVE at Icemail yet (steve@fresh.pro (IN_PROGRESS)); exported once they are" });

    // The next run queues it again, and it goes.
    expect(await queueReadyExports(sql)).toBe(1);
    const ok2 = fake();
    expect((await processIcemailExports(sql, [icemail(ok2)], LOGIN)).sent).toBe(1);
    expect(ok2.exports).toHaveLength(1);
  });

  it("leaves alone a domain from the app-password connects", async () => {
    await sql`insert into icemail_connects (account_id, order_item_id, icemail_mailbox_id, email, domain_name, status, created_by)
      values (${accountId}, ${itemId}, 'mb0', 'steve@fresh.pro', 'fresh.pro', 'cancelled', 'me')`;
    expect(await queueReadyExports(sql)).toBe(0);
  });

  it("waits for a Smartlead login, then exports and follows it to done, keeping no password", async () => {
    await queueReadyExports(sql);
    const f = fake();
    expect(await processIcemailExports(sql, [icemail(f)], null)).toMatchObject({ waitingForLogin: 1, sent: 0 });
    expect((await row()).message).toMatch(/ICEMAIL_SMARTLEAD_USERNAME/);
    expect(f.exports).toHaveLength(0);

    expect(await processIcemailExports(sql, [icemail(f)], LOGIN)).toMatchObject({ sent: 1, running: 0 });
    expect(f.exports).toEqual([{ ids: ["mb0", "mb1", "mb2"], login: LOGIN }]);
    // Its progress is first read a few minutes on.
    expect((await processIcemailExports(sql, [icemail(f)], LOGIN)).running).toBe(0);
    await sql`update icemail_exports set checked_at = now() - interval '4 minutes'`;
    expect((await processIcemailExports(sql, [icemail(f)], LOGIN)).running).toBe(1);
    let r = await row();
    expect(r).toMatchObject({ status: "exporting", icemail_export_id: "exp1", total: 3, processed: 1, message: null });
    expect(itemStage({ status: "ordered", message: null, nsStatus: null, mailboxes: 3, atIcemail: 3, activeAtIcemail: 3, otherStatus: null, inSmartlead: 0,
      exportStatus: r.status, exportTotal: r.total, exportProcessed: r.processed })).toEqual({ label: "Exporting", tone: "info", text: "Icemail is exporting them to Smartlead: 1 of 3 done" });

    // Looked at again only after a few more minutes.
    f.status = { status: "completed", total: 3, processed: 3, success: 3, failed: 0 };
    expect((await processIcemailExports(sql, [icemail(f)], LOGIN)).done).toBe(0);
    await sql`update icemail_exports set checked_at = now() - interval '4 minutes'`;
    expect((await processIcemailExports(sql, [icemail(f)], LOGIN)).done).toBe(1);
    r = await row();
    expect(r).toMatchObject({ status: "done", succeeded: 3 });
    expect((await sql`select 1 from job_state where job = 'smartlead-accounts'`).length).toBe(1);
    for (const t of ["icemail_exports", "api_calls", "job_state"]) expect(JSON.stringify(await sql`select * from ${sql(t)}`)).not.toContain("hunter2");
  });

  it("says what Icemail refused, and that it may have started after a server error", async () => {
    const { ApiError } = await import("../src/integrations/http");
    await queueReadyExports(sql);
    await processIcemailExports(sql, [icemail(fake(), { fail: new ApiError("icemail /export failed: Credentials does not match", 400) })], LOGIN);
    expect((await row()).message).toBe("Icemail refused the export: Credentials does not match. Nothing was exported; check the Smartlead login saved on this server");

    await sql`update icemail_exports set status = 'queued', message = null`;
    await processIcemailExports(sql, [icemail(fake(), { fail: new ApiError("icemail /export failed: Mailboxes already exported", 429) })], LOGIN);
    expect((await row()).message).toMatch(/one export an inbox a day; nothing was exported/);

    await sql`update icemail_exports set status = 'queued', message = null`;
    await processIcemailExports(sql, [icemail(fake(), { fail: new ApiError("icemail unreachable: socket hang up", null) })], LOGIN);
    expect((await row()).message).toMatch(/unclear whether Icemail started the export: check Export History/);
  });

  it("asks nothing in dry run, and retries a part-failed export as Icemail's republish", async () => {
    await queueReadyExports(sql);
    const dry = fake();
    expect((await processIcemailExports(sql, [icemail(dry, { dry: true })], LOGIN)).dryRun).toBe(1);
    expect((await row()).status).toBe("dry_run");

    await sql`update icemail_exports set status = 'queued', message = null`;
    const f = fake();
    await processIcemailExports(sql, [icemail(f)], LOGIN);
    f.status = { status: "completed", total: 3, processed: 3, success: 2, failed: 1 };
    await sql`update icemail_exports set checked_at = null`;
    expect((await processIcemailExports(sql, [icemail(f)], LOGIN)).failed).toBe(1);
    expect((await row()).message).toMatch(/finished with 1 of 3 inboxes not exported\. Retry asks Icemail/);

    // The Retry button re-queues it with its export id: republished, no new export.
    await sql`update icemail_exports set status = 'queued'`;
    expect((await processIcemailExports(sql, [icemail(f)], null)).sent).toBe(1);
    expect(f.republished).toEqual(["exp1"]);
    expect(f.exports).toHaveLength(1);
    // Not failed again from the old export's last status in the same run.
    expect((await row()).status).toBe("exporting");
  });

  it("gives up on an export that hasn't finished in six hours", async () => {
    await queueReadyExports(sql);
    const f = fake();
    await processIcemailExports(sql, [icemail(f)], LOGIN);
    await sql`update icemail_exports set started_at = now() - interval '7 hours', checked_at = null`;
    expect((await processIcemailExports(sql, [icemail(f)], LOGIN)).failed).toBe(1);
    expect((await row()).message).toMatch(/hasn't finished after 6 hours \(1 of 3 done\)/);
  });
});
