import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadMigrations } from "../scripts/migrations";

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  for (const m of loadMigrations()) await db.exec(m.sql);
});
afterAll(async () => db.close());
beforeEach(async () => {
  await db.exec("truncate domains cascade; truncate hypertide_orders cascade; truncate icemail_accounts cascade;");
});

const add = async (name: string, opts: { status?: string; ns?: string[]; expires?: string } = {}) => {
  const { rows } = await db.query<{ id: string }>(
    "insert into domains (name, status, nameservers, expires_at) values ($1, $2, $3, $4) returning id",
    [name, opts.status ?? "in_storage", opts.ns ?? [], opts.expires ?? null]);
  return rows[0].id;
};
const inbox = (id: string, name: string, status: string, limit = 30) =>
  db.query("insert into inboxes (domain_id, email, status, daily_limit, provider_type) values ($1, $2, $3, $4, 'OUTLOOK')", [id, `a@${name}`, status, limit]);
const order = (orderId: string, name: string, status: string, domainId: string | null, gone = false, replaced: string[] = []) =>
  db.query("insert into hypertide_orders (id, domain_name, domain_id, status, gone_at, replaced_domains) values ($1, $2, $3, $4, $5, $6)",
    [orderId, name, domainId, status, gone ? new Date() : null, replaced]);
const mailbox = async (id: string, name: string, opts: { gone?: boolean; status?: string } = {}) => {
  const account = (await db.query<{ id: string }>(
    "insert into icemail_accounts (label, credentials, webhook_token, created_by) values ($1, 'x', $2, 'test') returning id",
    [`w${name}${opts.status ?? ""}${opts.gone ?? ""}`, `${name}${opts.status ?? ""}${opts.gone ?? ""}`.padEnd(40, "0")])).rows[0].id;
  await db.query("insert into icemail_mailboxes (id, account_id, domain_id, email, status, gone_at) values ($1, $2, $3, $4, $5, $6)",
    [`m${name}${opts.status ?? ""}${opts.gone ?? ""}`, account, id, `a${opts.status ?? ""}${opts.gone ?? ""}@${name}`.toLowerCase(), opts.status ?? "ACTIVE", opts.gone ? new Date() : null]);
};
const statusOf = async (id: string) => (await db.query<{ status: string }>("select status from domains where id = $1", [id])).rows[0].status;
const run = async () => (await db.query<{ moved: number; restored: number }>("select * from replace_dropped_domains()")).rows[0];
const free = async () =>
  (await db.query<{ name: string }>("select name from domains d where domain_is_free(d) order by name")).rows.map((r) => r.name);

describe("free domains", () => {
  it("counts registrar default nameservers and no nameservers as free, nothing else", async () => {
    await add("porkbun.com", { ns: ["curitiba.ns.porkbun.com", "fortaleza.ns.porkbun.com"] });
    await add("dynadot.com", { ns: ["ns1.dyna-ns.net", "ns2.dyna-ns.net"] });
    await add("spaceship.com", { ns: ["launch1.spaceship.net", "launch2.spaceship.net"] });
    await add("none.com");
    await add("hypertide.com", { ns: ["ns1.hypertide.io", "ns2.hypertide.io"] });
    await add("cloudflare.com", { ns: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"] });
    await add("mixed.com", { ns: ["curitiba.ns.porkbun.com", "ns2.hypertide.io"] });
    expect(await free()).toEqual(["dynadot.com", "none.com", "porkbun.com", "spaceship.com"]);
  });

  it("leaves out expired domains and anything not in storage", async () => {
    await add("expired.com", { expires: "2020-01-01" });
    await add("renews.com", { expires: "2099-01-01" });
    await add("sending.com", { status: "active" });
    await add("replaced.com", { status: "burned" });
    expect(await free()).toEqual(["renews.com"]);
  });

  it("leaves out domains with any trace of use", async () => {
    const withInbox = await add("deletedinbox.com");
    await inbox(withInbox, "deletedinbox.com", "removed");
    const ordered = await add("cancelledorder.com");
    await order("o1", "cancelledorder.com", "NPC", ordered);
    await add("swappedout.com");
    await order("o2", "other.com", "Done", null, false, ["swappedout.com"]);
    const lastUsed = await add("lastused.com");
    await db.query("update domains set last_used_on = '2024-01-01' where id = $1", [lastUsed]);
    const setUp = await add("wassetup.com");
    await db.query("select transition_domain($1, 'provisioning', 'set up', 'test')", [setUp]);
    await db.query("select transition_domain($1, 'in_storage', 'cancelled', 'test')", [setUp]);
    await add("clean.com");
    expect(await free()).toEqual(["clean.com"]);
  });
});

describe("replace_dropped_domains", () => {
  it("moves active and warming domains with no Smartlead inboxes and a cancelled order to Replaced", async () => {
    const active = await add("active.com", { status: "active" });
    await inbox(active, "active.com", "removed");
    await order("o1", "active.com", "NPC", active);
    const warming = await add("warming.com", { status: "warming" });
    await order("o2", "warming.com", "Cancelled", warming);
    const gone = await add("gone.com", { status: "active" });
    await order("o3", "gone.com", "Done", gone, true);

    expect((await run()).moved).toBe(3);
    expect(await statusOf(active)).toBe("burned");
    expect(await statusOf(warming)).toBe("burned");
    expect(await statusOf(gone)).toBe("burned");
    const { rows } = await db.query<{ actor: string; forced: boolean }>("select actor, forced from domain_status_history where domain_id = $1 order by at desc limit 1", [active]);
    expect(rows[0]).toEqual({ actor: "auto replace", forced: true });
  });

  it("needs both: inboxes gone and the order ended", async () => {
    const stillSending = await add("stillsending.com", { status: "active" });
    await inbox(stillSending, "stillsending.com", "connected");
    await order("o1", "stillsending.com", "NPC", stillSending);
    const disconnected = await add("disconnected.com", { status: "active" });
    await inbox(disconnected, "disconnected.com", "disconnected");
    await order("o2", "disconnected.com", "NPC", disconnected);
    const paidFor = await add("paidfor.com", { status: "active" });
    await inbox(paidFor, "paidfor.com", "removed");
    await order("o3", "paidfor.com", "Done", paidFor);
    const noOrder = await add("noorder.com", { status: "active" });
    await inbox(noOrder, "noorder.com", "removed");

    expect((await run()).moved).toBe(0);
    for (const id of [stillSending, disconnected, paidFor, noOrder]) expect(await statusOf(id)).toBe("active");
  });

  it("treats ended Icemail mailboxes like a cancelled Hypertide order", async () => {
    const gone = await add("gone.com", { status: "active" });
    await inbox(gone, "gone.com", "removed");
    await mailbox(gone, "gone.com", { gone: true });
    const cancelled = await add("cancelled.com", { status: "warming" });
    await inbox(cancelled, "cancelled.com", "removed");
    await mailbox(cancelled, "cancelled.com", { status: "CANCELLED" });

    expect((await run()).moved).toBe(2);
    expect(await statusOf(gone)).toBe("burned");
    expect(await statusOf(cancelled)).toBe("burned");
  });

  it("keeps a domain while any Icemail mailbox or inbox is still live", async () => {
    const live = await add("live.com", { status: "active" });
    await inbox(live, "live.com", "removed");
    await mailbox(live, "live.com");
    const partly = await add("partly.com", { status: "active" });
    await inbox(partly, "partly.com", "removed");
    await mailbox(partly, "partly.com", { gone: true });
    await mailbox(partly, "partly.com");
    const sending = await add("sending.com", { status: "active" });
    await inbox(sending, "sending.com", "connected");
    await mailbox(sending, "sending.com", { gone: true });
    const both = await add("both.com", { status: "active" });
    await inbox(both, "both.com", "removed");
    await order("o1", "both.com", "NPC", both);
    await mailbox(both, "both.com");

    expect((await run()).moved).toBe(0);
    for (const id of [live, partly, sending, both]) expect(await statusOf(id)).toBe("active");
  });

  it("leaves a domain in a running replacement to the replacement", async () => {
    const old = await add("old.com", { status: "active" });
    await order("o1", "old.com", "NPC", old);
    const fresh = await add("new.com", { status: "provisioning" });
    const { rows } = await db.query<{ id: string }>("insert into replacement_batches (reason, status, actor) values ('other', 'running', 'test') returning id");
    await db.query("insert into replacement_items (batch_id, old_domain_id, new_domain_id) values ($1, $2, $3)", [rows[0].id, old, fresh]);

    expect((await run()).moved).toBe(0);
    expect(await statusOf(old)).toBe("active");
  });

  it("undoes its own move when inboxes come back, but not a move made by hand", async () => {
    const auto = await add("auto.com", { status: "active" });
    await inbox(auto, "auto.com", "removed");
    await order("o1", "auto.com", "NPC", auto);
    await run();
    expect(await statusOf(auto)).toBe("burned");
    await db.query("update inboxes set status = 'connected' where domain_id = $1", [auto]);

    const byHand = await add("byhand.com", { status: "active" });
    await db.query("select transition_domain($1, 'burned', 'Marked as replaced', 'someone', null, true)", [byHand]);
    await inbox(byHand, "byhand.com", "connected");

    const r = await run();
    expect(r.restored).toBe(1);
    expect(await statusOf(auto)).toBe("active");
    expect(await statusOf(byHand)).toBe("burned");
  });
});
