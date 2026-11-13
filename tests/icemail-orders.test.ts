import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createIcemail, parseIcemailDeletion, parseIcemailOrder, parseIcemailWallet, shapeOf } from "../src/integrations/icemail";
import { errorText } from "../src/integrations/http";
import { processIcemailActions } from "../src/jobs/icemail-orders";
import type { IcemailAccount } from "../src/jobs/icemail-sync";
import { cancelBy, DEFAULT_STYLES, itemStage, planMailboxes, readPeople, styleExample, verdictOf, type DomainFacts, type OrderItemFacts } from "../src/lib/icemail-board";
import { loadMigrations } from "../scripts/migrations";

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Icemail verdicts", () => {
  const base: DomainFacts = {
    mailboxes: 3, ageDays: 40, status: "active", call: "keep", reasons: [], blacklisted: false, issue: null,
    connected: 3, sent7: 900, daysSinceSent: 0, cancelling: false,
  };

  it("keeps a healthy domain, replaces a bad or blacklisted one", () => {
    expect(verdictOf(base)).toEqual({ verdict: "keep", reasons: [] });
    expect(verdictOf({ ...base, call: "replace", reasons: ["3.8× more spam/block bounces"] })).toEqual({ verdict: "replace", reasons: ["3.8× more spam/block bounces"] });
    expect(verdictOf({ ...base, call: "replace_now", reasons: [] }).verdict).toBe("replace");
    expect(verdictOf({ ...base, blacklisted: true }).reasons).toEqual(["Icemail lists it as blacklisted"]);
  });

  it("cancels inboxes that bill but can't send, or whose domain is retired", () => {
    expect(verdictOf({ ...base, connected: 0 }).verdict).toBe("cancel");
    expect(verdictOf({ ...base, status: "draining" }).reasons[0]).toMatch(/Replaced in Domain Engine/);
    // Young and not connected yet: still being set up.
    expect(verdictOf({ ...base, connected: 0, ageDays: 3 }).verdict).toBe("new");
  });

  it("says free, cancelling and keeps watch notes", () => {
    expect(verdictOf({ ...base, mailboxes: 0 }).verdict).toBe("free");
    expect(verdictOf({ ...base, cancelling: true, call: "replace" }).verdict).toBe("cancelling");
    const watch = verdictOf({ ...base, call: "watch", reasons: ["2.1× fewer replies"] });
    expect(watch).toEqual({ verdict: "keep", reasons: ["2.1× fewer replies"] });
    expect(verdictOf({ ...base, sent7: 0, daysSinceSent: 20 }).reasons[0]).toMatch(/hasn't sent in 20 days/);
  });

  it("times the cancel two days before the bill", () => {
    expect(cancelBy("2026-11-20", new Date("2026-11-13T15:00:00Z"))).toEqual({ by: "2026-11-18", daysLeft: 5 });
    expect(cancelBy("2026-11-14", new Date("2026-11-13T15:00:00Z"))).toEqual({ by: "2026-11-12", daysLeft: -1 });
    expect(cancelBy(null)).toBeNull();
  });
});

describe("New inboxes", () => {
  it("reads one person a line and drops repeats", () => {
    const r = readPeople("John Carter\nMaría  López\nmaria lopez\nSam\nAnn, Van der Berg\n");
    expect(r.people).toEqual([{ first: "John", last: "Carter" }, { first: "María", last: "López" }, { first: "Ann", last: "Van der Berg" }]);
    expect(r.bad).toEqual(["Sam"]);
  });

  it("gives one name several addresses on every domain, all with the same full name", () => {
    const { people } = readPeople("Sendil Nathan");
    const r = planMailboxes({ domains: ["a.com", "b.io"], people, styles: DEFAULT_STYLES });
    if ("error" in r) throw new Error(r.error);
    const sendil = { first_name: "Sendil", last_name: "Nathan" };
    expect(r.plan).toEqual([
      { domain: "a.com", mailboxes: [{ ...sendil, username: "sendil@a.com" }, { ...sendil, username: "sendil.nathan@a.com" }, { ...sendil, username: "sendil.n@a.com" }] },
      { domain: "b.io", mailboxes: [{ ...sendil, username: "sendil@b.io" }, { ...sendil, username: "sendil.nathan@b.io" }, { ...sendil, username: "sendil.n@b.io" }] },
    ]);
    // Styles come out in the listed order, whatever order they were ticked in.
    const two = planMailboxes({ domains: ["a.com"], people, styles: ["f.last", "first"] });
    if ("error" in two) throw new Error(two.error);
    expect(two.plan[0].mailboxes.map((m) => m.username)).toEqual(["sendil@a.com", "s.nathan@a.com"]);
    expect(styleExample("flast", { first: "María", last: "López" })).toBe("mlopez");
  });

  it("puts every name in every style, never repeats an address, and keeps to the limit", () => {
    const { people } = readPeople("John Carter\nJohn Smith");
    const r = planMailboxes({ domains: ["a.com"], people, styles: ["first", "first.last"] });
    if ("error" in r) throw new Error(r.error);
    // The second John can't have john@, so he takes the first unused style, then the next.
    expect(r.plan[0].mailboxes.map((m) => [m.username, m.last_name])).toEqual([
      ["john@a.com", "Carter"], ["john.carter@a.com", "Carter"], ["john.smith@a.com", "Smith"], ["john.s@a.com", "Smith"],
    ]);
    const many = readPeople("A Bee\nC Dee\nE Eff\nG Hay").people;
    expect(planMailboxes({ domains: ["a.com"], people: many, styles: DEFAULT_STYLES })).toEqual({ error: expect.stringContaining("12 inboxes a domain (4 names × 3 styles)") });
    expect(planMailboxes({ domains: ["a.com"], people, styles: [] })).toEqual({ error: "Tick at least one address style" });
    expect(planMailboxes({ domains: ["a.com"], people: [], styles: DEFAULT_STYLES })).toEqual({ error: "Add a name for the inboxes" });
    expect(planMailboxes({ domains: [], people, styles: DEFAULT_STYLES })).toEqual({ error: "Pick at least one domain" });
  });
});

describe("Order tracking", () => {
  const ordered: OrderItemFacts = { status: "ordered", message: "Ordered", nsStatus: null, mailboxes: 3, atIcemail: 0, activeAtIcemail: 0, otherStatus: null, inSmartlead: 0 };

  it("follows an ordered domain from Icemail to Smartlead", () => {
    expect(itemStage(ordered)).toMatchObject({ label: "Ordered", text: expect.stringContaining("after the next sync") });
    expect(itemStage({ ...ordered, atIcemail: 3, activeAtIcemail: 1, otherStatus: "updating" })).toEqual({ label: "Setting up", tone: "info", text: "1 of 3 active at Icemail, the rest updating" });
    expect(itemStage({ ...ordered, atIcemail: 3, activeAtIcemail: 3 })).toMatchObject({ label: "Ready", text: "All 3 active at Icemail; not connected in Smartlead yet" });
    expect(itemStage({ ...ordered, atIcemail: 3, activeAtIcemail: 3, inSmartlead: 2 })).toMatchObject({ label: "Connecting", text: "2 of 3 connected in Smartlead" });
    expect(itemStage({ ...ordered, atIcemail: 3, activeAtIcemail: 3, inSmartlead: 3 })).toMatchObject({ label: "Live", tone: "success" });
  });

  it("shows the worker status and its message before the order goes", () => {
    expect(itemStage({ ...ordered, status: "nameservers", message: null, nsStatus: "pending" })).toMatchObject({ label: "Nameservers", text: "Moving its nameservers to Icemail's ClouDNS (pending)" });
    expect(itemStage({ ...ordered, status: "failed", message: "Nothing was ordered" })).toEqual({ label: "Failed", tone: "danger", text: "Nothing was ordered" });
  });
});

describe("Icemail write calls", () => {
  it("orders on an imported domain without sending or keeping a password", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(new URL(url).pathname).toBe("/api/v1/order");
      body = JSON.parse(String(init.body));
      return ok({ success: true, data: [{ order_id: "ord1", domain_id: "dm1", domain_name: "fresh.io", mailboxes: [{ mailbox_id: "mb1", username: "john@fresh.io", password: "Secret1!" }] }] });
    }) as unknown as typeof fetch;
    const im = createIcemail({ apiKey: "k", fetchImpl, minSpacingMs: 0, dryRun: false });
    const r = await im.orderMailboxes("fresh.io", "GOOGLE", [{ first_name: "John", last_name: "Carter", username: "john@fresh.io" }]);
    expect(body).toEqual({ import: true, data: [{ domain_name: "fresh.io", mailbox_type: "GOOGLE", mailboxes: [{ first_name: "John", last_name: "Carter", username: "john@fresh.io" }] }] });
    expect(r).toEqual({ orderId: "ord1", domainId: "dm1", mailboxIds: ["mb1"] });
    expect(JSON.stringify(r)).not.toContain("Secret1");
  });

  it("asks nothing in dry run", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const im = createIcemail({ apiKey: "k", fetchImpl, minSpacingMs: 0 });
    expect(await im.orderMailboxes("fresh.io", "GOOGLE", [{ first_name: "A", last_name: "B", username: "a@fresh.io" }])).toBeNull();
    expect(await im.scheduleDeletion(["dm1"])).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("schedules deletion at the billing date and reads the per-domain answer", async () => {
    let sent: { method?: string; body?: unknown } = {};
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      sent = { method: init.method, body: JSON.parse(String(init.body)) };
      return ok({ success: true, data: { mode: "scheduled", per_domain: [{ domain_id: "dm1", mailbox_ids: ["a", "b"] }, { domain_id: "dm2", mailbox_ids: [], skipped: true }] } });
    }) as unknown as typeof fetch;
    const r = await createIcemail({ apiKey: "k", fetchImpl, minSpacingMs: 0, dryRun: false }).scheduleDeletion(["dm1", "dm2"]);
    expect(sent).toEqual({ method: "DELETE", body: { domain_ids: ["dm1", "dm2"], mode: "scheduled" } });
    expect(r).toEqual([{ domainId: "dm1", mailboxIds: ["a", "b"], skipped: false, error: null }, { domainId: "dm2", mailboxIds: [], skipped: true, error: null }]);
  });

  it("reads Icemail's field errors and odd shapes", () => {
    expect(errorText({ success: false, message: "Validation failed", errors: [{ field: "username", message: "username must end with @fresh.io" }] }))
      .toBe("Validation failed: username must end with @fresh.io");
    expect(parseIcemailOrder({ order_id: "o" }, "x.com")).toEqual({ orderId: "o", domainId: null, mailboxIds: [] });
    expect(parseIcemailDeletion(null)).toEqual([]);
  });
});

describe("Icemail wallet", () => {
  it("reads the documented reply and the likely other shapes", () => {
    const docs = { balance: 125.5, currency: "USD", auto_topup: { enabled: true, threshold: 10 } };
    expect(parseIcemailWallet({ success: true, data: docs })).toEqual({ balance: 125.5, currency: "USD", autoTopup: true });
    // What Icemail actually sends.
    expect(parseIcemailWallet({ success: true, data: { available: 84.25, auto_topup: false, threshold: 0, topup_amount: 0 }, message: "ok" }))
      .toEqual({ balance: 84.25, currency: null, autoTopup: false });
    expect(parseIcemailWallet({ success: true, data: { wallet: { balance: "40.00", currency: "USD" } } })).toMatchObject({ balance: 40 });
    expect(parseIcemailWallet({ success: true, data: [{ available_balance: 12 }] })).toMatchObject({ balance: 12 });
    expect(parseIcemailWallet({ balance: { amount: 7, currency: "USD" }, auto_topup: false })).toEqual({ balance: 7, currency: "USD", autoTopup: false });
    expect(parseIcemailWallet({ data: { balance_cents: 2550 } })).toMatchObject({ balance: 25.5 });
    expect(parseIcemailWallet({ success: true, data: { something: 1 } })).toEqual({ balance: null, currency: null, autoTopup: null });
  });

  it("logs the shape of a reply it can't read, never its values", async () => {
    const fetchImpl = vi.fn(async () => ok({ success: true, data: { funds: { usd: 99.5 }, owner: "someone@x.com" } })) as unknown as typeof fetch;
    const logged: unknown[][] = [];
    const sql = ((_: TemplateStringsArray, ...values: unknown[]) => { logged.push(values); return Promise.resolve([]); }) as unknown as postgres.Sql;
    const w = await createIcemail({ apiKey: "k", fetchImpl, sql, minSpacingMs: 0 }).wallet();
    expect(w.balance).toBeNull();
    const note = logged.map((v) => v[5]).find((e) => typeof e === "string") as string;
    expect(note).toBe('No balance found in the reply. Its shape: {"success":"boolean","data":{"funds":{"usd":"number"},"owner":"string"}}');
    expect(JSON.stringify(logged)).not.toMatch(/99\.5|someone@x\.com/);
    expect(shapeOf([])).toEqual([]);
  });
});

describe("Icemail orders and cancels job", () => {
  const PORT = 54389;
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
  beforeEach(async () => {
    await sql`truncate domains, icemail_accounts, nameserver_requests, job_state cascade`;
    [{ id: accountId }] = await sql`insert into icemail_accounts (label, credentials, webhook_token, created_by)
      values ('Main', 'sealed', ${"a".repeat(48)}, 'me') returning id`;
  });

  type Calls = { orders: string[]; deletions: string[][]; undos: string[][] };
  const fakeAccount = (calls: Calls, { dry = false, fail }: { dry?: boolean; fail?: Error } = {}): IcemailAccount => ({
    id: accountId, label: "Main",
    client: {
      orderMailboxes: async (domain: string) => {
        calls.orders.push(domain);
        if (fail) throw fail;
        return dry ? null : { orderId: `ord-${domain}`, domainId: `dm-${domain}`, mailboxIds: ["m1"] };
      },
      scheduleDeletion: async (ids: string[]) => { calls.deletions.push(ids); return dry ? null : ids.map((domainId) => ({ domainId, mailboxIds: ["a", "b"], skipped: false, error: null })); },
      cancelScheduledDeletion: async (ids: string[]) => { calls.undos.push(ids); return dry ? null : { ok: ids, failed: [] }; },
    } as unknown as IcemailAccount["client"],
  });
  const newCalls = (): Calls => ({ orders: [], deletions: [], undos: [] });
  const order = async (items: { domain: string; status?: string; nsRequest?: string | null }[]) => {
    const [o] = await sql`insert into icemail_orders (account_id, provider, created_by) values (${accountId}, 'GOOGLE', 'me') returning id`;
    for (const i of items) {
      await sql`insert into icemail_order_items (order_id, domain_name, mailboxes, status, ns_request_id)
        values (${o.id}, ${i.domain}, ${sql.json([{ first_name: "John", last_name: "Carter", username: `john@${i.domain}` }])}, ${i.status ?? "queued"}, ${i.nsRequest ?? null})`;
    }
    return o.id as string;
  };
  const statuses = async () => (await sql`select domain_name, status, message from icemail_order_items order by domain_name`).map((r) => [r.domain_name, r.status]);

  it("orders queued domains, a gap apart, and asks for a sync after", async () => {
    await order([{ domain: "a.com" }, { domain: "b.com" }]);
    const calls = newCalls();
    const sleep = vi.fn(async () => {});
    const r = await processIcemailActions(sql, [fakeAccount(calls)], { sleep, gapMs: 5500 });
    expect(r).toMatchObject({ ordered: 2, failed: 0, waiting: 0 });
    expect(calls.orders).toEqual(["a.com", "b.com"]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(5500);
    expect(await statuses()).toEqual([["a.com", "ordered"], ["b.com", "ordered"]]);
    const [ref] = await sql`select icemail_order_id from icemail_order_items where domain_name = 'a.com'`;
    expect(ref.icemail_order_id).toBe("ord-a.com");
    const [job] = await sql`select last_started_at from job_state where job = 'icemail'`;
    expect(job.last_started_at).toBeNull();
  });

  it("marks dry runs, and never orders on a domain that already has inboxes", async () => {
    await sql`insert into icemail_domains (id, account_id, domain_name) values ('dm-busy', ${accountId}, 'busy.com')`;
    await sql`insert into icemail_mailboxes (id, account_id, icemail_domain_id, email, status) values ('mb1', ${accountId}, 'dm-busy', 'x@busy.com', 'ACTIVE')`;
    await order([{ domain: "a.com" }, { domain: "busy.com" }]);
    const calls = newCalls();
    const r = await processIcemailActions(sql, [fakeAccount(calls, { dry: true })], { sleep: async () => {} });
    expect(r).toMatchObject({ dryRun: 1, failed: 1, ordered: 0 });
    expect(calls.orders).toEqual(["a.com"]);
    expect(await statuses()).toEqual([["a.com", "dry_run"], ["busy.com", "failed"]]);
  });

  it("waits for the nameservers, then orders; fails with what to do when they can't move", async () => {
    const [d1] = await sql`insert into domains (name) values ('fresh.io') returning id`;
    const [d2] = await sql`insert into domains (name) values ('manual.io') returning id`;
    const [r1] = await sql`insert into nameserver_requests (domain_id, source, target, actor) values (${d1.id}, 'custom', ${["pns71.cloudns.net"]}::text[], 'me') returning id`;
    const [r2] = await sql`insert into nameserver_requests (domain_id, source, target, actor) values (${d2.id}, 'custom', ${["pns71.cloudns.net"]}::text[], 'me') returning id`;
    await order([{ domain: "fresh.io", status: "nameservers", nsRequest: r1.id }, { domain: "manual.io", status: "nameservers", nsRequest: r2.id }]);
    const calls = newCalls();

    await processIcemailActions(sql, [fakeAccount(calls)], { sleep: async () => {} });
    expect(calls.orders).toEqual([]);
    expect(await statuses()).toEqual([["fresh.io", "nameservers"], ["manual.io", "nameservers"]]);

    await sql`update nameserver_requests set status = 'done' where id = ${r1.id}`;
    await sql`update nameserver_requests set status = 'manual', message = 'No API access' where id = ${r2.id}`;
    await processIcemailActions(sql, [fakeAccount(calls)], { sleep: async () => {} });
    expect(calls.orders).toEqual(["fresh.io"]);
    expect(await statuses()).toEqual([["fresh.io", "ordered"], ["manual.io", "failed"]]);
    const [m] = await sql`select message from icemail_order_items where domain_name = 'manual.io'`;
    expect(m.message).toBe("Its nameservers couldn't be moved to Icemail: No API access. Retry once they point at the four ClouDNS nameservers");
  });

  it("says whether money may have been spent when an order errors", async () => {
    const { ApiError } = await import("../src/integrations/http");
    await order([{ domain: "a.com" }]);
    await processIcemailActions(sql, [fakeAccount(newCalls(), { fail: new ApiError("icemail /order failed: Insufficient balance", 400) })], { sleep: async () => {} });
    const [a] = await sql`select status, message from icemail_order_items`;
    expect(a).toEqual({ status: "failed", message: "Icemail refused it: Insufficient balance. Nothing was ordered" });

    await sql`update icemail_order_items set status = 'queued'`;
    await processIcemailActions(sql, [fakeAccount(newCalls(), { fail: new ApiError("icemail unreachable: timeout", null) })], { sleep: async () => {} });
    const [b] = await sql`select status, message from icemail_order_items`;
    expect(b.status).toBe("failed");
    expect(b.message).toMatch(/unclear whether Icemail took the order/);
  });

  it("schedules a cancel for the billing date, and takes it back", async () => {
    await sql`insert into icemail_domains (id, account_id, domain_name) values ('dm-old', ${accountId}, 'old.com')`;
    await sql`insert into icemail_mailboxes (id, account_id, icemail_domain_id, email, status, next_billing_on) values
      ('m1', ${accountId}, 'dm-old', 'a@old.com', 'ACTIVE', current_date + 9), ('m2', ${accountId}, 'dm-old', 'b@old.com', 'ACTIVE', current_date + 5)`;
    const [k] = await sql`insert into icemail_cancels (account_id, icemail_domain_id, domain_name, created_by) values (${accountId}, 'dm-old', 'old.com', 'me') returning id`;
    const calls = newCalls();
    const r = await processIcemailActions(sql, [fakeAccount(calls)], { sleep: async () => {} });
    expect(r.scheduled).toBe(1);
    expect(calls.deletions).toEqual([["dm-old"]]);
    const [row] = await sql`select status, mailboxes, deletes_on = current_date + 5 as earliest from icemail_cancels where id = ${k.id}`;
    expect(row).toEqual({ status: "scheduled", mailboxes: 2, earliest: true });

    await sql`update icemail_cancels set status = 'undo_queued' where id = ${k.id}`;
    await processIcemailActions(sql, [fakeAccount(calls)], { sleep: async () => {} });
    expect(calls.undos).toEqual([["dm-old"]]);
    expect((await sql`select status from icemail_cancels where id = ${k.id}`)[0].status).toBe("undone");
  });

  it("leaves a workspace that's gone with a reason, not a retry", async () => {
    await sql`insert into icemail_domains (id, account_id, domain_name) values ('dm-x', ${accountId}, 'x.com')`;
    await sql`insert into icemail_cancels (account_id, icemail_domain_id, domain_name, created_by) values (${accountId}, 'dm-x', 'x.com', 'me')`;
    await order([{ domain: "a.com" }]);
    const r = await processIcemailActions(sql, [], { sleep: async () => {} });
    expect(r.failed).toBe(2);
    const [c] = await sql`select status, message from icemail_cancels`;
    expect(c.status).toBe("failed");
    expect(c.message).toMatch(/no longer connected/);
  });

  it("keeps who cleared an order and when", async () => {
    const id = await order([{ domain: "a.com" }]);
    await sql`update icemail_orders set cleared_at = now(), cleared_by = 'me' where id = ${id}`;
    const [o] = await sql`select cleared_by, cleared_at is not null as cleared from icemail_orders where id = ${id}`;
    expect(o).toEqual({ cleared_by: "me", cleared: true });
  });

  it("allows one open order and one live cancel per domain", async () => {
    await order([{ domain: "a.com" }]);
    await expect(order([{ domain: "a.com" }])).rejects.toThrow(/duplicate key/);
    await sql`insert into icemail_cancels (account_id, icemail_domain_id, domain_name, created_by) values (${accountId}, 'dm-y', 'y.com', 'me')`;
    await expect(sql`insert into icemail_cancels (account_id, icemail_domain_id, domain_name, created_by) values (${accountId}, 'dm-y', 'y.com', 'me')`).rejects.toThrow(/duplicate key/);
  });
});
