import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Smartlead } from "../src/integrations/smartlead";
import { parseAccount } from "../src/integrations/smartlead-parse";
import { processInboxChanges, runDuePlans, runPlan } from "../src/jobs/inbox-settings";
import { checkNameservers } from "../src/jobs/nameservers";
import { clientsFromTags } from "../src/jobs/smartlead-sync";
import { distribute, seeded } from "../src/lib/distribute";
import { createSmartleadApp, jwtProblem, readBlacklist, readTags, type SmartleadApp } from "../src/integrations/smartlead-app";
import { syncBlacklists } from "../src/jobs/blacklist";
import { loadMigrations } from "../scripts/migrations";

describe("distribute", () => {
  it("keeps every inbox in range and the total exact", () => {
    for (let seed = 1; seed < 40; seed++) {
      const r = distribute(27, 400, 10, 20, seeded(seed));
      expect(r.values).toHaveLength(27);
      expect(r.values.reduce((a, b) => a + b, 0)).toBe(400);
      expect(Math.min(...r.values)).toBeGreaterThanOrEqual(10);
      expect(Math.max(...r.values)).toBeLessThanOrEqual(20);
      expect(r.clamped).toBe(false);
    }
  });

  it("varies the split from day to day", () => {
    const a = distribute(10, 150, 10, 20, seeded(1)).values.join();
    const b = distribute(10, 150, 10, 20, seeded(2)).values.join();
    expect(a).not.toBe(b);
  });

  it("clamps a total the inboxes can't carry", () => {
    expect(distribute(5, 1000, 10, 20, seeded(3))).toMatchObject({ total: 100, clamped: true });
    expect(distribute(5, 10, 10, 20, seeded(3))).toMatchObject({ total: 50, clamped: true });
  });
});

describe("parseAccount", () => {
  it("reads tags, gap and warmup range from the public API shape", () => {
    const a = parseAccount({
      id: 7, from_email: "Amy@Send.com", message_per_day: 15, minTimeToWaitInMins: 15, daily_sent_count: 4, campaign_count: 2, type: "outlook",
      tags: [{ tag_id: 1, tag_name: "Kapable", tag_color: "#fff" }],
      warmup_details: { status: "ACTIVE", warmup_min_count: 7, warmup_max_count: 9, max_email_per_day: 9, reply_rate: 70, warmup_reputation: "96%" },
    });
    expect(a).toMatchObject({ email: "amy@send.com", tags: ["Kapable"], minWaitMins: 15, dailySent: 4, campaignCount: 2, providerType: "OUTLOOK",
      warmupEnabled: true, warmupMin: 7, warmupPerDay: 9, warmupReplyRate: 70, warmupReputation: 96 });
  });
});

const PORT = 54397;
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

let domainId: string;
const fakeSmartlead = (over: Partial<Smartlead> = {}) =>
  ({ dryRun: false, updateSending: vi.fn(async () => ({})), updateWarmup: vi.fn(async () => ({})), ...over }) as unknown as Smartlead;

beforeEach(async () => {
  await sql`truncate inbox_setting_changes, sending_plans, inboxes, domain_status_history, domains, clients cascade`;
  [{ id: domainId }] = await sql`insert into domains (name, status) values ('send.com', 'active') returning id`;
  await sql`insert into inboxes (domain_id, email, status, smartlead_account_id, daily_limit, min_wait_mins, warmup_enabled, warmup_per_day, smartlead_tags)
    select ${domainId}, 'u' || g || '@send.com', 'connected', 100 + g, 15, 20, true, 9, array['Kapable'] from generate_series(1, 6) g`;
});

describe("inbox setting changes", () => {
  it("merges waiting changes per inbox, sends both sending fields and updates the local copy", async () => {
    const [ib] = await sql`select id from inboxes where email = 'u1@send.com'`;
    await sql`insert into inbox_setting_changes (inbox_id, changes, actor) values (${ib.id}, '{"daily_limit": 12}', 'me')`;
    await sql`insert into inbox_setting_changes (inbox_id, changes, actor) values (${ib.id}, '{"warmup_per_day": 5, "daily_limit": 13}', 'me')`;
    const sl = fakeSmartlead();
    const r = await processInboxChanges(sql, sl);
    expect(r).toMatchObject({ changes: 2, inboxes: 1, done: 1 });
    expect(sl.updateSending).toHaveBeenCalledWith(101, { max_email_per_day: 13, time_to_wait_in_mins: 20 });
    expect(sl.updateWarmup).toHaveBeenCalledWith(101, { warmup_enabled: true, total_warmup_per_day: 5 });
    const [after] = await sql`select daily_limit, warmup_per_day from inboxes where id = ${ib.id}`;
    expect(after).toEqual({ daily_limit: 13, warmup_per_day: 5 });
  });

  it("understands changes read back with camel-case keys", async () => {
    const [ib] = await sql`select id from inboxes where email = 'u1@send.com'`;
    await sql`insert into inbox_setting_changes (inbox_id, changes, actor) values (${ib.id}, '{"dailyLimit": 11, "minWaitMins": 40}', 'me')`;
    const sl = fakeSmartlead();
    expect(await processInboxChanges(sql, sl)).toMatchObject({ done: 1 });
    expect(sl.updateSending).toHaveBeenCalledWith(101, { max_email_per_day: 11, time_to_wait_in_mins: 40 });
  });

  it("leaves inboxes untouched in dry run", async () => {
    const [ib] = await sql`select id from inboxes where email = 'u1@send.com'`;
    await sql`insert into inbox_setting_changes (inbox_id, changes, actor) values (${ib.id}, '{"daily_limit": 3}', 'me')`;
    await processInboxChanges(sql, fakeSmartlead({ dryRun: true }));
    expect((await sql`select daily_limit from inboxes where id = ${ib.id}`)[0].daily_limit).toBe(15);
    expect((await sql`select status from inbox_setting_changes`)[0].status).toBe("dry_run");
  });

  it("records Smartlead's error", async () => {
    const [ib] = await sql`select id from inboxes where email = 'u1@send.com'`;
    await sql`insert into inbox_setting_changes (inbox_id, changes, actor) values (${ib.id}, '{"daily_limit": 3}', 'me')`;
    await processInboxChanges(sql, fakeSmartlead({ updateSending: vi.fn(async () => { throw new Error("HTTP 400 bad"); }) }));
    expect((await sql`select status, error from inbox_setting_changes`)[0]).toEqual({ status: "failed", error: "HTTP 400 bad" });
  });
});

describe("sending plans", () => {
  it("queues a split that adds up to the plan's total", async () => {
    const [p] = await sql`insert into sending_plans (name, mode, total_min, total_max, inbox_min, inbox_max, domain_ids, created_by)
      values ('Mix', 'shuffle', 80, 80, 10, 18, array[${domainId}]::uuid[], 'me')
      returning id, name, mode, total_min as totalmin, total_max as totalmax, inbox_min as inboxmin, inbox_max as inboxmax, client_id as client, domain_ids as domains`;
    const r = await runPlan(sql, p as never, "me", seeded(5));
    expect(r).toMatchObject({ total: 80, inboxes: 6, clamped: false });
    const rows = await sql`select (changes->>'daily_limit')::int as n from inbox_setting_changes`;
    expect(rows.reduce((a, x) => a + x.n, 0)).toBe(80);
  });

  it("runs once a day after its hour, in the stats timezone", async () => {
    await sql`insert into sending_plans (name, mode, total_min, total_max, inbox_min, inbox_max, domain_ids, run_hour, created_by)
      values ('Mix', 'random_total', 60, 90, 10, 18, array[${domainId}]::uuid[], 6, 'me')`;
    const early = new Date("2026-10-21T00:00:00Z"); // 05:30 in Kolkata
    expect((await runDuePlans(sql, "Asia/Kolkata", early)).plansRun).toBe(0);
    const later = new Date("2026-10-21T01:00:00Z"); // 06:30
    expect((await runDuePlans(sql, "Asia/Kolkata", later)).plansRun).toBe(1);
    expect((await runDuePlans(sql, "Asia/Kolkata", new Date("2026-10-21T10:00:00Z"))).plansRun).toBe(0);
    const total = (await sql`select sum((changes->>'daily_limit')::int)::int as n from inbox_setting_changes`)[0].n;
    expect(total).toBeGreaterThanOrEqual(60);
    expect(total).toBeLessThanOrEqual(90);
  });
});

describe("clients from Smartlead tags", () => {
  it("creates a client per tag and gives untagged domains their client", async () => {
    const r = await clientsFromTags(sql);
    expect(r).toEqual({ clientsFromTags: 1, domainsTagged: 1 });
    const [d] = await sql`select c.name from domains d join clients c on c.id = d.client_id where d.id = ${domainId}`;
    expect(d.name).toBe("Kapable");
    expect(await clientsFromTags(sql)).toEqual({ clientsFromTags: 0, domainsTagged: 0 });
  });
});

describe("nameserver lookups", () => {
  it("stores what DNS reports and keeps the old value when the lookup fails", async () => {
    await sql`insert into domains (name, nameservers) values ('broken.com', array['old.ns.com'])`;
    const lookup = vi.fn(async (name: string) => {
      if (name === "broken.com") throw new Error("SERVFAIL");
      return ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"];
    });
    const allGood = async () => ({ spf: true, dkim: true, dmarc: true, mx: true });
    const r = await checkNameservers(sql, null, 10, lookup, async () => { throw new Error("no RDAP"); }, allGood);
    expect(r).toEqual({ checked: 1, notAnswering: 0, empty: 0, failed: 1, dnsMissing: 0 });
    expect((await sql`select nameservers from domains where name = 'send.com'`)[0].nameservers).toEqual(["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"]);
    expect((await sql`select nameservers from domains where name = 'broken.com'`)[0].nameservers).toEqual(["old.ns.com"]);
  });

  it("asks the registry when DNS fails and flags the domain as not answering", async () => {
    const lookup = vi.fn(async () => { throw Object.assign(new Error("SERVFAIL"), { code: "ESERVFAIL" }); });
    const records = vi.fn(async () => ({ spf: true, dkim: true, dmarc: true, mx: true }));
    const r = await checkNameservers(sql, null, 10, lookup, async () => ({ ns: ["ns1.dnsimple.com", "ns2.dnsimple-edge.net"], registered: null }), records);
    expect(records).not.toHaveBeenCalled();
    expect(r).toMatchObject({ notAnswering: 1 });
    const [d] = await sql`select nameservers, nameservers_answering from domains where name = 'send.com'`;
    expect(d).toEqual({ nameservers: ["ns1.dnsimple.com", "ns2.dnsimple-edge.net"], nameservers_answering: false });
  });

  it("records missing DNS records and the registration date for domain age", async () => {
    const lookup = vi.fn(async () => ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"]);
    const registry = vi.fn(async () => ({ ns: [], registered: "2025-03-04" }));
    const records = vi.fn(async () => ({ spf: true, dkim: false, dmarc: true, mx: true }));
    const r = await checkNameservers(sql, null, 10, lookup, registry, records);
    expect(r).toMatchObject({ checked: 1, dnsMissing: 1 });
    const [d] = await sql`select dns_spf, dns_dkim, dns_dmarc, dns_mx, to_char(registered_at, 'YYYY-MM-DD') as reg from domains where name = 'send.com'`;
    expect(d).toEqual({ dns_spf: true, dns_dkim: false, dns_dmarc: true, dns_mx: true, reg: "2025-03-04" });
  });
});

describe("Smartlead token features", () => {
  const token = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
  it("explains a broken or expired token without showing it", () => {
    expect(jwtProblem("abc")).toMatch(/incomplete/);
    expect(jwtProblem(token(1_000), 2_000_000)).toMatch(/expired on 1970-01-01/);
    expect(jwtProblem(token(Date.now() / 1000 + 3600))).toBeNull();
  });

  it("reads a campaign's blacklist scan", () => {
    const r = readBlacklist([
      { domain: { domain: "Send.com", blacklisted: [{ name: "Spamhaus DBL" }], summary: { totalTests: 90 } }, ip: { ip: "1.2.3.4", blacklisted: [] } },
      { domain: { domain: "clean.com", blacklisted: [] }, ip: { blacklisted: [{ name: "Barracuda" }] } },
    ]);
    expect(r).toEqual([
      { domain: "send.com", ip: "1.2.3.4", domainCount: 1, ipCount: 0, listings: [{ kind: "domain", list: "Spamhaus DBL" }] },
      { domain: "clean.com", ip: null, domainCount: 0, ipCount: 1, listings: [{ kind: "ip", list: "Barracuda" }] },
    ]);
  });

  it("stores blacklist status per domain from the campaigns still sending", async () => {
    await sql`insert into campaigns (id, name, status) values (1, 'A', 'ACTIVE'), (2, 'B', 'COMPLETED')`;
    const app = { dryRun: false, blacklist: vi.fn(async () => [{ domain: "send.com", ip: null, domainCount: 2, ipCount: 1, listings: [] }]) } as unknown as SmartleadApp;
    const r = await syncBlacklists(sql, app);
    expect(r).toEqual({ campaigns: 1, domains: 1, listed: 1, failed: 0 });
    expect(app.blacklist).toHaveBeenCalledWith(1);
    const [d] = await sql`select blacklist_domain_count as dc, blacklist_ip_count as ic from domains where name = 'send.com'`;
    expect(d).toEqual({ dc: 2, ic: 1 });
    await sql`truncate campaigns cascade`;
  });
});

describe("Smartlead tags and bulk config", () => {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const jwt = `x.${payload}.y`;

  it("reads the workspace tag list and drops duplicates and blanks", () => {
    expect(readTags({ data: [{ id: 3, name: " Kapable ", color: "#FCE1B1" }, { id: 3, name: "Kapable" }, { id: 0, name: "x" }, { id: 4, name: "" }, { id: 5, name: "warmup" }] }))
      .toEqual([{ id: 3, name: "Kapable", color: "#FCE1B1" }, { id: 5, name: "warmup", color: "#B1FCFA" }]);
  });

  it("sends bulk config in chunks of 250 with Smartlead's own payload shape", async () => {
    const bodies: { url: string; body: { emailAccountIds: number[]; updateData: Record<string, unknown> } }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      bodies.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const app = createSmartleadApp({ jwt, dryRun: false, fetchImpl });
    const ids = Array.from({ length: 260 }, (_, i) => i + 1);
    expect(await app.bulkConfig(ids, { tags: [3, 5] })).toBe(260);
    expect(bodies.map((b) => b.body.emailAccountIds.length)).toEqual([250, 10]);
    expect(bodies[0].url).toBe("https://server.smartlead.ai/api/email-account/bulk-update-email-account-config");
    expect(bodies[0].body.updateData).toEqual({ dailyReplyLimit: null, tags: [3, 5] });
  });

  it("writes nothing in dry run", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const app = createSmartleadApp({ jwt, dryRun: true, fetchImpl });
    await app.bulkConfig([1, 2], { status: "ACTIVE" });
    expect(await app.createTag("New")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("warmup never turned on", () => {
  it("reads warmup_details: null as warmup off", () => {
    expect(parseAccount({ id: 7, from_email: "a@b.com", warmup_details: null })?.warmupEnabled).toBe(false);
    expect(parseAccount({ id: 7, from_email: "a@b.com" })?.warmupEnabled).toBeNull();
  });
});

describe("warmup tag", () => {
  it("reads Smartlead's warmup_key_id", () => {
    expect(parseAccount({ id: 7, from_email: "a@b.com", warmup_details: { status: "ACTIVE", warmup_key_id: "along-stood" } })?.warmupTag).toBe("along-stood");
  });
});
