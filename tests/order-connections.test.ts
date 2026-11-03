import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations } from "../scripts/migrations";

describe("order_connections", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await PGlite.create();
    for (const m of loadMigrations()) await db.exec(m.sql);
  });
  afterAll(async () => db.close());

  type Inbox = { status?: string; warmup?: boolean; warmupStatus?: string; blocked?: string };
  const off: Inbox = { warmup: false, warmupStatus: "INACTIVE" };

  // A domain with one Hypertide order; inboxes default to connected and warming.
  const order = async (name: string, inboxes: Inbox[], opts: { status?: string; answering?: boolean; orderStatus?: string } = {}) => {
    const { rows } = await db.query<{ id: string }>(
      "insert into domains (name, status, nameservers_answering) values ($1, $2, $3) returning id",
      [name, opts.status ?? "active", opts.answering ?? true]);
    await db.query("insert into hypertide_orders (id, domain_name, domain_id, status) values ($1, $2, $3, $4)",
      [`rec-${name}`, name, rows[0].id, opts.orderStatus ?? "Done"]);
    for (const [i, x] of inboxes.entries()) {
      await db.query("insert into inboxes (domain_id, email, status, warmup_enabled, warmup_status, warmup_blocked_reason) values ($1, $2, $3, $4, $5, $6)",
        [rows[0].id, `u${i}@${name}`, x.status ?? "connected", x.warmup ?? true, x.warmupStatus ?? "ACTIVE", x.blocked ?? null]);
    }
  };
  const names = async () => (await db.query<{ name: string }>("select name from order_connections")).rows.map((r) => r.name);

  it("says how each active order stands in Smartlead", async () => {
    await order("allgood.com", [{}, {}]);
    await order("oldinbox.com", [{}, { ...off, status: "removed" }]);
    await order("partdisc.com", [{}, { ...off, status: "disconnected" }]);
    await order("alldisc.com", [{ status: "disconnected" }]);
    await order("gone.com", [{ status: "removed" }]);
    await order("never.com", []);
    await order("nodns.com", [{}], { answering: false });
    await order("warmoff.com", [{}, off]);
    await order("blocked.com", [{ blocked: "Message not delivered" }]);
    await order("settingup.com", [], { status: "provisioning" });
    await order("retired.com", [{ status: "disconnected" }], { status: "burned" });

    const { rows } = await db.query<{ name: string; state: string; problem: boolean }>("select name, state, problem from order_connections order by name");
    expect(rows.map((r) => [r.name, r.state, r.problem])).toEqual([
      ["alldisc.com", "disconnected", true],
      ["allgood.com", "ok", false],
      ["blocked.com", "warmup_blocked", true],
      ["gone.com", "deleted", true],
      ["never.com", "missing", true],
      ["nodns.com", "dns_gone", true],
      ["oldinbox.com", "ok", false],
      ["partdisc.com", "disconnected", true],
      ["retired.com", "retiring", false],
      ["settingup.com", "setting_up", false],
      ["warmoff.com", "warmup_off", true],
    ]);
  });

  it("leaves out cancelled orders, whatever Smartlead says", async () => {
    await order("cancelled.com", [{ status: "disconnected" }], { orderStatus: "NPC" });
    await order("cancelled2.com", [{ status: "removed" }], { orderStatus: "Cancelled" });
    const shown = await names();
    expect(shown).not.toContain("cancelled.com");
    expect(shown).not.toContain("cancelled2.com");
  });

  it("counts an active Icemail domain, and an order with no domain on file", async () => {
    const { rows: [account] } = await db.query<{ id: string }>(
      "insert into icemail_accounts (label, credentials, webhook_token, created_by) values ('a', 'x', $1, 'test') returning id", ["t".repeat(32)]);
    await db.query("insert into icemail_domains (id, account_id, domain_name, active) values ('i1', $1, 'ice-none.com', true), ('i2', $1, 'ice-off.com', false)", [account.id]);
    await db.query("insert into hypertide_orders (id, domain_name, status) values ('rec-x', 'NoFile.com', 'Done')");
    const { rows } = await db.query<{ provider: string; name: string; state: string; domain_id: string | null }>(
      "select provider, name, state, domain_id from order_connections where domain_id is null order by name");
    expect(rows).toEqual([
      { provider: "Icemail", name: "ice-none.com", state: "missing", domain_id: null },
      { provider: "Hypertide", name: "nofile.com", state: "missing", domain_id: null },
    ]);
  });
});
