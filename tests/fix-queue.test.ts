import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations } from "../scripts/migrations";
import { FIX_FACTS_SQL, fixCsv, fixQueue, fixSummary, problemsOf, type FixFact } from "../src/lib/fix-queue";

let seq = 0;
const fact = (over: Partial<FixFact> = {}): FixFact => ({
  domainId: `d${++seq}`, name: `d${seq}.com`, status: "active", standing: "active", current: true, orderLive: true, orderState: "active", provider: "Hypertide",
  graceLeft: null, clientId: "c1", clientName: "Client One", clientHue: 200, connected: 3, disconnected: 0, capacity: 45, lostCapacity: 0,
  warmupOff: 0, warmupBlocked: 0, lowRep: 0, rep: 98, sent7: 200, replies7: 4, daysSent: 5, daysSinceSent: 0,
  bounces7: 2, dnsBounces: 0, senderBounces: 0, blockBounces: 0, spamBounces: 0,
  nameserversAnswering: true, dnsSpf: true, dnsDkim: true, dnsDmarc: true, dnsMx: true, listed: 0, daysToExpiry: 200, autoRenew: null, orderProblem: null, ...over,
});
const kinds = (over: Partial<FixFact>) => problemsOf(fact(over)).map((p) => p.kind);

describe("what counts as a problem", () => {
  it("leaves a healthy domain alone", () => {
    expect(problemsOf(fact())).toEqual([]);
  });

  it("flags mail still going out after the order ended, with what it sends a day", () => {
    const [p] = problemsOf(fact({ standing: "cancelled", current: false, orderLive: false, orderState: "cancelled" }));
    expect(p).toMatchObject({ kind: "sending_after_end", tier: "urgent", risk: 40 });
    expect(p.evidence).toContain("cancelled");
  });

  it("ignores an ended domain that has already stopped", () => {
    expect(kinds({ standing: "cancelled", current: false, orderLive: false, daysSinceSent: 5 })).toEqual([]);
    expect(kinds({ standing: "cancelled", current: false, orderLive: false, sent7: 0, daysSent: 0, daysSinceSent: null })).toEqual([]);
    expect(kinds({ standing: "cancelled", current: false, orderLive: false, connected: 0, disconnected: 3 })).toEqual([]);
  });

  it("is less sure when the provider's list has merely lost the order", () => {
    expect(problemsOf(fact({ standing: "no_order", current: false, orderLive: false, orderState: "missing" }))[0]).toMatchObject({ kind: "sending_after_end", tier: "soon" });
  });

  it("only asks about a domain in its grace period when it's about to go and still sending", () => {
    expect(kinds({ standing: "grace", graceLeft: 12, nameserversAnswering: false, rep: 50 })).toEqual([]);
    expect(problemsOf(fact({ standing: "grace", graceLeft: 4 }))[0]).toMatchObject({ kind: "grace_ending", tier: "soon" });
    expect(problemsOf(fact({ standing: "grace", graceLeft: 1 }))[0]).toMatchObject({ kind: "grace_ending", tier: "urgent" });
  });

  it("calls every inbox down urgent, and some down this week, sized by what's lost", () => {
    expect(problemsOf(fact({ connected: 0, disconnected: 3, capacity: 0, lostCapacity: 45 }))[0]).toMatchObject({ kind: "disconnected", tier: "urgent", risk: 45 });
    expect(problemsOf(fact({ connected: 2, disconnected: 1, lostCapacity: 15 }))[0]).toMatchObject({ kind: "disconnected", tier: "soon", risk: 15 });
  });

  it("doesn't chase disconnected inboxes on a retired domain", () => {
    expect(kinds({ status: "resting", disconnected: 2, standing: "retired", current: false, orderLive: true, sent7: 0, daysSent: 0, daysSinceSent: null })).toEqual([]);
  });

  it("puts the DNS cause ahead of the disconnects it causes", () => {
    const q = fixQueue([fact({ connected: 0, disconnected: 3, capacity: 0, lostCapacity: 45, nameserversAnswering: false })]);
    expect(q.items[0].top.kind).toBe("dns_down");
    expect(q.items[0].problems.map((p) => p.kind)).toEqual(["dns_down", "disconnected"]);
  });

  it("reads bounces that blame our DNS or tenant, once there are enough", () => {
    expect(kinds({ dnsBounces: 2 })).toEqual([]);
    expect(problemsOf(fact({ dnsBounces: 3 }))[0]).toMatchObject({ kind: "dns_records", tier: "urgent" });
    expect(problemsOf(fact({ senderBounces: 3 }))[0]).toMatchObject({ kind: "tenant", tier: "urgent" });
  });

  it("treats a missing record by what it breaks", () => {
    expect(problemsOf(fact({ dnsSpf: false }))[0]).toMatchObject({ kind: "dns_records", tier: "urgent" });
    expect(problemsOf(fact({ dnsDmarc: false }))[0]).toMatchObject({ kind: "dns_records", tier: "watch" });
    // No inboxes yet, so nothing is failing: it's just unused.
    expect(kinds({ connected: 0, capacity: 0, sent7: 0, daysSent: 0, daysSinceSent: null, dnsSpf: false, orderProblem: "missing" })).toEqual(["paid_unused"]);
    // Not checked yet isn't missing.
    expect(kinds({ dnsSpf: null, dnsDkim: null, dnsDmarc: null, dnsMx: null, nameserversAnswering: null })).toEqual([]);
  });

  it("warns about expiry unless auto-renew is known to be on", () => {
    expect(problemsOf(fact({ daysToExpiry: 10 }))[0]).toMatchObject({ kind: "expiring", tier: "soon" });
    expect(problemsOf(fact({ daysToExpiry: 2, autoRenew: false }))[0]).toMatchObject({ kind: "expiring", tier: "urgent" });
    expect(kinds({ daysToExpiry: 2, autoRenew: true })).toEqual([]);
    expect(kinds({ daysToExpiry: 30 })).toEqual([]);
  });

  it("doesn't say expired twice for a domain that's still sending", () => {
    expect(kinds({ standing: "expired", current: false, orderLive: true, daysToExpiry: -3 })).toEqual(["sending_after_end"]);
  });

  it("flags a paid order with no inboxes, with nothing at risk but the money", () => {
    expect(problemsOf(fact({ connected: 0, capacity: 0, sent7: 0, daysSent: 0, daysSinceSent: null, orderProblem: "missing" }))[0]).toMatchObject({ kind: "paid_unused", tier: "soon", risk: 0 });
  });

  it("flags block lists, heavy spam and total silence on real volume", () => {
    expect(kinds({ listed: 1 })).toEqual(["blocklisted"]);
    expect(kinds({ blockBounces: 5 })).toEqual(["blocklisted"]);
    // On a block list and a few bounces that name one go by different names, with different next steps.
    expect(problemsOf(fact({ listed: 1, blockBounces: 6 }))[0]).toMatchObject({ label: "Block listed", evidence: "On 1 block list; 6 block list bounces in 7 days" });
    const bounced = problemsOf(fact({ blockBounces: 6 }))[0];
    expect(bounced).toMatchObject({ label: "Block list bounces", evidence: "6 block list bounces in 7 days" });
    expect(bounced.next).toContain("Replace list");
    expect(problemsOf(fact({ nameserversAnswering: false }))[0].label).toBe("DNS down");
    expect(fixCsv(fixQueue([fact({ blockBounces: 6, warmupOff: 1 })]).items).split("\n")[1]).toContain("Block list bounces,6 block list bounces in 7 days");
    expect(kinds({ blockBounces: 4 })).toEqual([]);
    expect(kinds({ spamBounces: 10, sent7: 500 })).toEqual(["spam"]);
    expect(kinds({ spamBounces: 10, sent7: 5000 })).toEqual([]);
    expect(kinds({ sent7: 300, replies7: 0 })).toEqual(["silent"]);
    expect(kinds({ sent7: 299, replies7: 0 })).toEqual([]);
  });

  it("keeps reputation and warm-up as things to watch", () => {
    for (const over of [{ rep: 80 }, { warmupOff: 1 }, { warmupBlocked: 2 }]) expect(problemsOf(fact(over))[0].tier).toBe("watch");
  });
});

describe("the queue", () => {
  it("ranks by tier, then by daily volume at risk", () => {
    const small = fact({ name: "small.com", nameserversAnswering: false, sent7: 50, daysSent: 5 });
    const big = fact({ name: "big.com", nameserversAnswering: false, sent7: 5000, daysSent: 5 });
    const worry = fact({ name: "worry.com", listed: 1, sent7: 90000, daysSent: 5 });
    const watch = fact({ name: "watch.com", rep: 70, sent7: 900000, daysSent: 5 });
    expect(fixQueue([watch, worry, small, big]).items.map((i) => i.name)).toEqual(["big.com", "small.com", "worry.com", "watch.com"]);
  });

  it("counts a domain's risk once, whatever else is wrong with it", () => {
    const { items } = fixQueue([fact({ nameserversAnswering: false, listed: 2, rep: 70, sent7: 500, daysSent: 5 })]);
    expect(items[0].problems).toHaveLength(3);
    expect(items[0].risk).toBe(100);
    expect(fixSummary(items).risk).toBe(100);
    expect(fixSummary(items).tiers.urgent.count).toBe(1);
    expect(fixSummary(items).tiers.soon.count).toBe(0);
    expect(fixSummary(items).kinds.map((k) => k.kind)).toEqual(["dns_down", "blocklisted", "low_rep"]);
  });

  it("sets a snoozed problem aside, while the domain's other problems stay", () => {
    const d = fact({ name: "two.com", nameserversAnswering: false, rep: 70 });
    const q = fixQueue([d], [{ name: "two.com", kind: "dns_down", until: "2030-01-01T00:00:00Z" }]);
    expect(q.items[0].top.kind).toBe("low_rep");
    expect(q.items[0].tier).toBe("watch");
    expect(q.snoozed.map((s) => [s.name, s.top.kind])).toEqual([["two.com", "dns_down"]]);
  });

  it("takes a domain off when its only problem is snoozed", () => {
    const q = fixQueue([fact({ name: "one.com", rep: 70 })], [{ name: "one.com", kind: "low_rep", until: "2030-01-01T00:00:00Z" }]);
    expect(q.items).toEqual([]);
    expect(q.snoozed).toHaveLength(1);
  });

  it("exports a CSV that a spreadsheet can't read as a formula", () => {
    const { items } = fixQueue([fact({ name: "csv.com", clientName: "=Evil, Inc", rep: 70 })]);
    const [head, row] = fixCsv(items).split("\n");
    expect(head).toContain("Next step");
    expect(row).toContain("csv.com,'=Evil, Inc");
  });
});

describe("the facts", () => {
  let pg: PGlite;
  const toCamel = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.replace(/_(\w)/g, (_, c: string) => c.toUpperCase()), v])) as unknown as FixFact;
  const facts = async () => (await pg.query<Record<string, unknown>>(FIX_FACTS_SQL)).rows.map(toCamel);
  const add = async (name: string, opts: { status?: string; connected?: number; disconnected?: number; limit?: number } = {}) => {
    const { rows: [d] } = await pg.query<{ id: string }>(`insert into domains (name, status) values ($1, $2) returning id`, [name, opts.status ?? "active"]);
    let n = 0;
    for (const [count, status] of [[opts.connected ?? 0, "connected"], [opts.disconnected ?? 0, "disconnected"]] as const) {
      for (let i = 0; i < count; i++) await pg.query(`insert into inboxes (domain_id, email, status, daily_limit) values ($1, $2, $3, $4)`, [d.id, `u${++n}@${name}`, status, opts.limit ?? 15]);
    }
    return d.id;
  };

  beforeAll(async () => {
    pg = await PGlite.create();
    // Production runs in UTC. Without this, "today" differs from current_date for part of each day on a machine elsewhere.
    await pg.exec("set timezone = 'UTC'");
    for (const m of loadMigrations()) await pg.exec(m.sql);
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it("adds up what the rules need, per domain, from the last 7 days only", async () => {
    const id = await add("facts.com", { connected: 2, disconnected: 1 });
    await pg.query(`insert into domain_daily_stats (domain_id, day, sent, replies) values ($1, current_date, 100, 3), ($1, current_date - 2, 50, 0), ($1, current_date - 20, 999, 9)`, [id]);
    await pg.query(`insert into email_events (dedupe_key, kind, occurred_at, domain_id, bounce_cause) values
      ('a', 'bounce', now(), $1, 'dns'), ('b', 'bounce', now(), $1, 'blocklist'), ('c', 'bounce', now() - interval '30 days', $1, 'dns')`, [id]);
    const f = (await facts()).find((x) => x.name === "facts.com")!;
    expect(f).toMatchObject({ connected: 2, disconnected: 1, capacity: 30, lostCapacity: 15, sent7: 150, replies7: 3, daysSent: 2, dnsBounces: 1, blockBounces: 1, bounces7: 2, daysSinceSent: 0 });
    expect(problemsOf(f).map((p) => p.kind)).toContain("disconnected");
  });

  it("leaves out domains that aren't in use", async () => {
    await add("shelf.com", { status: "in_storage" });
    expect((await facts()).some((x) => x.name === "shelf.com")).toBe(false);
  });

  it("keeps a retired domain only while it's still sending", async () => {
    const id = await add("old.com", { status: "burned", connected: 1 });
    expect((await facts()).some((x) => x.name === "old.com")).toBe(false);
    await pg.query(`insert into domain_daily_stats (domain_id, day, sent) values ($1, current_date, 10)`, [id]);
    expect((await facts()).find((x) => x.name === "old.com")?.sent7).toBe(10);
  });

  it("stores a snooze per domain and problem", async () => {
    await pg.query(`insert into fix_snoozes (domain_name, kind, until) values ('facts.com', 'dns_down', now() + interval '1 day')`);
    await pg.query(`insert into fix_snoozes (domain_name, kind, until) values ('facts.com', 'low_rep', now() + interval '1 day')`);
    await expect(pg.query(`insert into fix_snoozes (domain_name, kind, until) values ('facts.com', 'dns_down', now())`)).rejects.toThrow();
  });
});
