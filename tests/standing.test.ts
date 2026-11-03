import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations } from "../scripts/migrations";

let pg: PGlite;
const q = async <T>(text: string) => (await pg.query<T>(text)).rows;
let seq = 0;

/** A domain with some inboxes. Returns its id. */
async function domain(name: string, opts: { status?: string; provider?: string; connected?: number; disconnected?: number; removed?: number; expires?: string; esp?: string; tag?: string } = {}) {
  const provider = opts.provider ? `(select id from vendors where name = '${opts.provider}')` : "null";
  const [d] = await q<{ id: string }>(`insert into domains (name, status, inbox_provider_id, expires_at) values ('${name}', '${opts.status ?? "active"}', ${provider}, ${opts.expires ? `'${opts.expires}'` : "null"}) returning id`);
  const add = async (n: number, status: string) => {
    for (let i = 0; i < n; i++) {
      seq++;
      await pg.query(`insert into inboxes (domain_id, email, status, provider_type, smartlead_tags) values ($1, $2, $3, $4, $5)`, [d.id, `u${seq}@${name}`, status, opts.esp ?? "OUTLOOK", opts.tag ? [opts.tag] : []]);
    }
  };
  await add(opts.connected ?? 0, "connected");
  await add(opts.disconnected ?? 0, "disconnected");
  await add(opts.removed ?? 0, "removed");
  return d.id;
}
const htOrder = (name: string, status: string, extra: { ended?: string; gone?: boolean; replaced?: string[]; replacedAt?: string } = {}) =>
  pg.query(`insert into hypertide_orders (id, domain_name, status, ended_on, gone_at, replaced_domains, replaced_at, domain_id)
    values ($1, $2, $3, $4, $5, $6, $7, (select id from domains where name = $2))`,
    [`o-${name}`, name, status, extra.ended ?? null, extra.gone ? new Date().toISOString() : null, extra.replaced ?? [], extra.replacedAt ?? null]);
const standing = async (name: string) => (await q<{ standing: string; current: boolean; grace_left: number | null; order_state: string | null; order_live: boolean; provider: string | null }>(
  `select s.* from domain_standing s join domains d on d.id = s.domain_id where d.name = '${name}'`))[0];
// Counted from the database's own today: its clock decides, whatever the time zone here.
let dbToday = 0;
const daysAgo = (n: number) => new Date(dbToday - n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  pg = await PGlite.create();
  for (const m of loadMigrations()) await pg.exec(m.sql);
  dbToday = Date.parse(`${(await q<{ d: string }>("select current_date::text as d"))[0].d}T00:00:00Z`);
}, 60_000);
afterAll(async () => { await pg?.close(); });

describe("domain_standing", () => {
  it("connected with a Done order is active", async () => {
    await domain("live.com", { provider: "Hypertide", connected: 3 });
    await htOrder("live.com", "Done");
    expect(await standing("live.com")).toMatchObject({ standing: "active", current: true, order_state: "active", order_live: true });
  });

  it("keeps a cancelled order's inboxes in for the grace period, and out afterwards", async () => {
    await domain("grace.com", { provider: "Hypertide", connected: 3 });
    await htOrder("grace.com", "Cancelled", { ended: daysAgo(5) });
    expect(await standing("grace.com")).toMatchObject({ standing: "grace", current: true, grace_left: 13 });
    await domain("late.com", { provider: "Hypertide", connected: 3 });
    await htOrder("late.com", "Cancelled", { ended: daysAgo(30) });
    expect(await standing("late.com")).toMatchObject({ standing: "cancelled", current: false, grace_left: 0 });
  });

  it("the grace period follows the drain_days setting", async () => {
    await pg.exec(`insert into settings (key, value) values ('drain_days', '3') on conflict (key) do update set value = excluded.value`);
    expect(await standing("grace.com")).toMatchObject({ standing: "cancelled", current: false });
    await pg.exec(`delete from settings where key = 'drain_days'`);
  });

  it("a domain tagged replaced with no date is in grace while connected", async () => {
    await domain("tagged.com", { provider: "Hypertide", connected: 2, tag: "Replaced" });
    await htOrder("tagged.com", "Done");
    expect(await standing("tagged.com")).toMatchObject({ standing: "grace", current: true });
  });

  it("a domain moved off its order counts from the day it moved", async () => {
    await domain("old-one.com", { provider: "Hypertide", connected: 2 });
    await domain("new-one.com", { provider: "Hypertide", connected: 2 });
    await htOrder("new-one.com", "Done", { replaced: ["old-one.com"], replacedAt: `${daysAgo(2)}T00:00:00Z` });
    expect(await standing("old-one.com")).toMatchObject({ standing: "grace", grace_left: 16 });
    expect(await standing("new-one.com")).toMatchObject({ standing: "active" });
    await domain("older-one.com", { provider: "Hypertide", disconnected: 2 });
    await htOrder("new-two.com", "Done", { replaced: ["older-one.com"], replacedAt: `${daysAgo(40)}T00:00:00Z` });
    expect(await standing("older-one.com")).toMatchObject({ standing: "replaced", current: false });
  });

  it("disconnected and deleted inboxes aren't active, whatever domains.status says", async () => {
    await domain("down.com", { provider: "Hypertide", disconnected: 3 });
    await htOrder("down.com", "Done");
    expect(await standing("down.com")).toMatchObject({ standing: "disconnected", current: false, order_live: true });
    await domain("deleted.com", { provider: "Hypertide", removed: 3 });
    await htOrder("deleted.com", "Done");
    expect(await standing("deleted.com")).toMatchObject({ standing: "deleted", current: false });
  });

  it("expired beats everything, connected or not", async () => {
    await domain("expired.com", { provider: "Hypertide", connected: 3, expires: daysAgo(1) });
    await htOrder("expired.com", "Done");
    expect(await standing("expired.com")).toMatchObject({ standing: "expired", current: false });
    await domain("today.com", { provider: "Hypertide", connected: 3, expires: daysAgo(0) });
    await htOrder("today.com", "Done");
    expect((await standing("today.com")).standing).toBe("active");
  });

  it("reads Icemail orders for Icemail domains, not Hypertide's", async () => {
    await pg.exec(`insert into icemail_accounts (label, credentials, webhook_token, created_by) values ('test', 'x', '${"t".repeat(32)}', 'test')`);
    const icemail = (name: string, active: boolean, gone = false) => pg.query(
      `insert into icemail_domains (id, account_id, domain_name, domain_id, active, gone_at)
       select $1, (select id from icemail_accounts limit 1), $1, id, $2, $3 from domains where name = $1`, [name, active, gone ? new Date().toISOString() : null]);
    await domain("ice.com", { provider: "Icemail", connected: 2, esp: "GMAIL" });
    await icemail("ice.com", true);
    expect(await standing("ice.com")).toMatchObject({ provider: "Icemail", order_state: "active", standing: "active", current: true });
    await domain("ice-gone.com", { provider: "Icemail", connected: 2, esp: "GMAIL" });
    await icemail("ice-gone.com", false, true);
    expect(await standing("ice-gone.com")).toMatchObject({ order_state: "gone", standing: "grace", grace_left: 18 });
    await domain("ice-none.com", { provider: "Icemail", connected: 2, esp: "GMAIL" });
    expect(await standing("ice-none.com")).toMatchObject({ order_state: "missing", standing: "no_order", current: false });
  });

  it("moves Google domains with no Hypertide order to Icemail, and leaves the rest", async () => {
    await domain("google.com", { provider: "Hypertide", connected: 2, esp: "GMAIL" });
    await domain("outlook.com", { provider: "Hypertide", connected: 2, esp: "OUTLOOK" });
    await domain("google-ordered.com", { provider: "Hypertide", connected: 2, esp: "GMAIL" });
    await htOrder("google-ordered.com", "Done");
    const backfill = loadMigrations().find((m) => m.sql.includes("create or replace view domain_standing"))!.sql.match(/update domains d set inbox_provider_id[\s\S]*?;/)![0];
    await pg.exec(backfill);
    expect((await standing("google.com")).provider).toBe("Icemail");
    expect((await standing("outlook.com")).provider).toBe("Hypertide");
    expect((await standing("google-ordered.com")).provider).toBe("Hypertide");
  });

  it("treats a domain with no provider as live: nothing says its order ended", async () => {
    await domain("unknown.com", { connected: 1 });
    expect(await standing("unknown.com")).toMatchObject({ standing: "active", current: true, order_state: null, order_live: true });
  });

  it("a deleted tenant only shows as dead while its order is still paid for", async () => {
    const tenant = (name: string) => pg.query(`update inboxes set connect_error = 'AADSTS500341: deleted' where domain_id = (select id from domains where name = $1)`, [name]);
    await domain("dead-paid.com", { provider: "Hypertide", disconnected: 2 });
    await htOrder("dead-paid.com", "Done");
    await tenant("dead-paid.com");
    await domain("dead-over.com", { provider: "Hypertide", disconnected: 2 });
    await htOrder("dead-over.com", "Cancelled", { ended: daysAgo(60) });
    await tenant("dead-over.com");
    const dead = (await q<{ name: string }>(`select d.name from dead_domains x join domains d on d.id = x.domain_id`)).map((r) => r.name);
    const live = (await q<{ name: string }>(`select d.name from live_dead_domains x join domains d on d.id = x.domain_id`)).map((r) => r.name);
    expect(dead).toEqual(expect.arrayContaining(["dead-paid.com", "dead-over.com"]));
    expect(live).toContain("dead-paid.com");
    expect(live).not.toContain("dead-over.com");
  });
});
