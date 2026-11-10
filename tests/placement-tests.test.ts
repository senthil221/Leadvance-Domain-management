import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PlacementError, createPlacementBatch, runPlacementTests, type BatchInput } from "../src/jobs/placement-tests";
import {
  bodyHtml, leadFor, nextSaturday, parseStatRow, pickInboxes, pickSeeds, placementVerdict, unknownVariables, type SeedChoice, type Tally,
} from "../src/lib/placement-tests";
import { loadMigrations } from "../scripts/migrations";
import { syncCampaigns } from "../src/jobs/smartlead-sync";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const seed = (email: string, lastReplyAt = "2026-11-01T00:00:00.000Z"): SeedChoice => ({ email, domain: email.split("@")[1], name: null, lastReplyAt });

describe("placement test rules", () => {
  it("names a seed from its auto-reply, else its address, else 'there'", () => {
    expect(leadFor({ email: "jane.doe@acme-tools.com", name: null })).toEqual({ email: "jane.doe@acme-tools.com", first_name: "Jane", last_name: "Doe", company_name: "Acme Tools" });
    expect(leadFor({ email: "x9@acme.com", name: "Peter Gibbons" })).toMatchObject({ first_name: "Peter", last_name: "Gibbons" });
    expect(leadFor({ email: "info@acme.com", name: null }).first_name).toBe("there");
    expect(leadFor({ email: "ops@acme.com", name: "Ops Team" }).first_name).toBe("there");
  });

  it("sends from the domain's usual sender first, then the best reputation", () => {
    const picked = pickInboxes([
      { accountId: 1, email: "a@d.com", senderName: "Steve K", reputation: 100 },
      { accountId: 2, email: "b@d.com", senderName: "Amelia Wren", reputation: 90 },
      { accountId: 3, email: "c@d.com", senderName: "Amelia Wren", reputation: 99 },
      { accountId: 4, email: "e@d.com", senderName: "Amelia Wren", reputation: 80 },
    ], 2);
    expect(picked.map((i) => i.accountId)).toEqual([3, 2]);
  });

  it("gives each campaign different companies, never the same seed to one domain twice, and at most 3 a week", () => {
    const seeds = ["a@one.com", "b@one.com", "c@two.com", "d@three.com", "e@four.com"].map((e) => seed(e));
    const { picks, short } = pickSeeds(seeds, [], [
      { key: "x|sales", domainId: "x", count: 2 }, { key: "x|neutral", domainId: "x", count: 2 },
    ], NOW);
    const all = [...picks.get("x|sales")!, ...picks.get("x|neutral")!].map((s) => s.email);
    expect(new Set(all).size).toBe(4);
    for (const k of ["x|sales", "x|neutral"]) expect(new Set(picks.get(k)!.map((s) => s.domain)).size).toBe(2);
    expect(short).toEqual([]);

    // Used three times this week: rested. Sent by domain y last week: not again from y.
    const history = [
      ...[1, 2, 3].map((d) => ({ email: "a@one.com", domainId: `z${d}`, sentAt: "2026-11-08T00:00:00Z" })),
      { email: "c@two.com", domainId: "y", sentAt: "2026-10-25T00:00:00Z" },
    ];
    const r = pickSeeds(seeds, history, [{ key: "y", domainId: "y", count: 5 }], NOW);
    expect(r.picks.get("y")!.map((s) => s.email).sort()).toEqual(["b@one.com", "d@three.com", "e@four.com"]);
    expect(r.short).toEqual([{ key: "y", missing: 2 }]);
  });

  it("reads the auto-replies against the control", () => {
    const t = (sent: number, replied: number, bounced = 0): Tally => ({ total: sent, sent, replied, bounced });
    const control = { sales: t(10, 8), neutral: t(10, 9) };
    expect(placementVerdict({ sales: t(10, 7), neutral: t(10, 8) }, control, true)).toBe("lands");
    expect(placementVerdict({ sales: t(10, 1), neutral: t(10, 8) }, control, true)).toBe("copy");
    expect(placementVerdict({ sales: t(10, 1), neutral: t(10, 2) }, control, true)).toBe("burned");
    expect(placementVerdict({ sales: t(10, 7), neutral: t(10, 2) }, control, true)).toBe("mixed");
    expect(placementVerdict({ sales: t(10, 7), neutral: t(10, 8) }, control, false)).toBe("waiting");
    // Bounces aren't delivered: 6 sent with 3 bounced is too few to judge.
    expect(placementVerdict({ sales: t(6, 3, 3), neutral: t(10, 8) }, control, true)).toBe("too_few");
    expect(placementVerdict({ sales: t(10, 1), neutral: t(10, 1) }, { sales: t(10, 2), neutral: t(10, 9) }, true)).toBe("control_failed");
    expect(placementVerdict({ sales: t(10, 1), neutral: t(10, 1) }, null, true)).toBe("control");
  });

  it("keeps HTML, turns plain text into it, and spots variables a seed can't fill", () => {
    expect(bodyHtml("Hi {{first_name}},\n\nLunch?")).toBe("Hi {{first_name}},<br><br>Lunch?");
    expect(bodyHtml("<p>Hi</p>")).toBe("<p>Hi</p>");
    expect(unknownVariables("Hi {{first_name}} at {{company_name}}, saw {{custom_city}} and {{ Title }}")).toEqual(["custom_city", "title"]);
  });

  it("reads Smartlead's per-lead statistics", () => {
    expect(parseStatRow({ lead_email: "A@x.com", sent_time: "2026-11-15T09:05:00.000Z", reply_time: null, is_bounced: false }))
      .toEqual({ email: "a@x.com", sentAt: "2026-11-15T09:05:00.000Z", repliedAt: null, bounced: false });
    expect(parseStatRow({ lead_email: "b@x.com", sent_time: "2026-11-15T09:05:00Z", reply_time: "2026-11-15T09:06:00Z", is_bounced: "true" })?.bounced).toBe(true);
    expect(parseStatRow({ sent_time: "x" })).toBeNull();
  });

  it("finds next Saturday 09:00 in the timezone", () => {
    expect(nextSaturday("America/New_York", new Date("2026-11-10T12:00:00Z"))).toBe("2026-11-14T14:00:00.000Z");
    expect(nextSaturday("UTC", new Date("2026-11-14T08:00:00Z"))).toBe("2026-11-14T09:00:00.000Z");
    expect(nextSaturday("UTC", new Date("2026-11-14T10:00:00Z"))).toBe("2026-11-21T09:00:00.000Z");
  });
});

const PORT = 54392;
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

/** A Smartlead that remembers what it was asked and serves statistics from `stats`. */
function fakeSmartlead({ dryRun = false } = {}) {
  let next = 900;
  const calls: [string, ...unknown[]][] = [];
  const stats = new Map<number, unknown[]>();
  const sl = {
    dryRun,
    createCampaign: async (name: string) => { calls.push(["create", name]); return { ok: true, id: ++next, name }; },
    getCampaign: async (id: number) => { calls.push(["get", id]); return { id, track_settings: ["DONT_TRACK_EMAIL_OPEN"], send_as_plain_text: true, stop_lead_settings: "CLICK_ON_A_LINK" }; },
    updateCampaignSettings: async (id: number, s: unknown) => { calls.push(["settings", id, s]); },
    updateCampaignSchedule: async (id: number, s: unknown) => { calls.push(["schedule", id, s]); },
    saveSequences: async (id: number, s: unknown) => { calls.push(["sequence", id, s]); },
    addAccountsToCampaign: async (id: number, a: number[]) => { calls.push(["accounts", id, a]); },
    addLeads: async (id: number, leads: unknown[]) => { calls.push(["leads", id, leads]); return { ok: true, upload_count: leads.length }; },
    setCampaignStatus: async (id: number, status: string) => { calls.push(["status", id, status]); },
    campaignStatistics: async (id: number, offset: number) => ({ data: offset ? [] : stats.get(id) ?? [] }),
  };
  return { sl: sl as never, calls, stats };
}

const fresh = new Date(Date.now() - 3 * 86_400_000).toISOString();

async function setup() {
  for (const t of ["placement_batches", "placement_seeds", "placement_seed_domains", "inboxes", "domains", "clients", "email_events", "untracked_replies"]) {
    await sql.unsafe(`delete from ${t}`);
  }
  const [client] = await sql<{ id: string }[]>`insert into clients (name) values ('Qualifi') returning id`;
  const domains: Record<string, string> = {};
  let account = 100;
  for (const name of ["tested.com", "control.com"]) {
    const [d] = await sql<{ id: string }[]>`insert into domains (name, status, client_id) values (${name}, 'active', ${client.id}) returning id`;
    domains[name] = d.id;
    for (const local of ["amelia", "a.wren", "wren"]) {
      await sql`insert into inboxes (domain_id, email, sender_name, smartlead_account_id, status, warmup_reputation)
        values (${d.id}, ${`${local}@${name}`}, 'Amelia Wren', ${++account}, 'connected', 98)`;
    }
  }
  // 14 Google seeds at 14 companies, plus one at Microsoft that is never used.
  for (let i = 1; i <= 14; i++) {
    await sql`insert into placement_seeds (email, domain, source, first_reply_at, last_reply_at) values (${`p${i}@co${i}.com`}, ${`co${i}.com`}, 'reply', ${fresh}, ${fresh})`;
    await sql`insert into placement_seed_domains (domain, provider, checked_at) values (${`co${i}.com`}, 'google', now())`;
  }
  await sql`insert into placement_seeds (email, domain, source, first_reply_at, last_reply_at) values ('ms@msft.com', 'msft.com', 'reply', ${fresh}, ${fresh})`;
  await sql`insert into placement_seed_domains (domain, provider, checked_at) values ('msft.com', 'outlook', now())`;
  return domains;
}

const input = (d: Record<string, string>, over: Partial<BatchInput> = {}): BatchInput => ({
  groups: [{ domainIds: [d["tested.com"]], controlDomainId: d["control.com"], sales: { subject: "For {{company_name}}", body: "<p>Hi {{first_name}}</p>", sourceCampaignId: 555 } }],
  neutral: { subject: "Lunch on Thursday?", body: "Hi {{first_name}},\nLunch?" },
  seedsPerCampaign: 6, inboxesPerDomain: 2, startsAt: "2026-11-14T14:00:00.000Z", createdBy: "me@b2bdrive.net", ...over,
});

describe("a placement test from start to finish", () => {
  let d: Record<string, string>;
  beforeEach(async () => { d = await setup(); });

  it("plans the batch: two campaigns for the domain and its control, Google seeds only, none twice for one domain", async () => {
    const r = await createPlacementBatch(sql, input(d));
    expect(r).toMatchObject({ campaigns: 4, emails: 24, short: 0 });
    const rows = await sql<{ role: string; variant: string; name: string; accounts: number; seeds: string[] }[]>`
      select pd.role, pc.variant, pc.name, cardinality(pc.account_ids) as accounts, array_agg(ps.seed_email order by ps.seed_email) as seeds
      from placement_campaigns pc join placement_domains pd on pd.id = pc.placement_domain_id join placement_sends ps on ps.campaign_id = pc.id
      group by 1, 2, 3, 4 order by 1 desc, 2`;
    expect(rows.map((x) => [x.role, x.variant, x.accounts, x.seeds.length])).toEqual([
      ["test", "neutral", 2, 6], ["test", "sales", 2, 6], ["control", "neutral", 2, 6], ["control", "sales", 2, 6],
    ]);
    expect(rows[1].name).toMatch(/^Placement · tested\.com · Sales · \d{4}-\d{2}-\d{2}$/);
    expect(rows.flatMap((x) => x.seeds)).not.toContain("ms@msft.com");
    // The domain's two campaigns don't share a seed.
    expect(rows[0].seeds.filter((s) => rows[1].seeds.includes(s))).toEqual([]);
    // Both domains are now in a running test.
    await expect(createPlacementBatch(sql, input(d))).rejects.toThrow(/Already in a running test/);
  });

  it("sends to fewer seeds when short, and refuses below 6 a campaign", async () => {
    // 12 asked, 14 seeds: the domain's two campaigns split them, 7 each.
    expect(await createPlacementBatch(sql, input(d, { seedsPerCampaign: 12 }))).toMatchObject({ emails: 28, short: 4 });
    d = await setup();
    await sql`delete from placement_seeds where email not in ('p1@co1.com', 'p2@co2.com', 'p3@co3.com', 'p4@co4.com', 'p5@co5.com')`;
    await expect(createPlacementBatch(sql, input(d))).rejects.toBeInstanceOf(PlacementError);
  });

  it("builds and starts each campaign, reads the auto-replies, and stops it 48 hours after its last email", async () => {
    await createPlacementBatch(sql, input(d));
    const { sl, calls, stats } = fakeSmartlead();
    let now = new Date("2026-11-14T13:00:00Z");
    const r1 = await runPlacementTests(sql, sl, { timezone: "America/New_York", now: () => now });
    expect(r1).toMatchObject({ built: 4, failed: 0 });
    const kinds = calls.map((c) => c[0]);
    expect(kinds.filter((k) => k === "create")).toHaveLength(4);
    expect(kinds.filter((k) => k === "status")).toHaveLength(4);
    // Settings come from the client's campaign; a reply always stops the lead.
    const settings = calls.find((c) => c[0] === "settings")![2] as Record<string, unknown>;
    expect(settings).toEqual({ track_settings: ["DONT_TRACK_EMAIL_OPEN"], send_as_plain_text: true, stop_lead_settings: "REPLY_TO_AN_EMAIL", follow_up_percentage: 100 });
    expect((calls.find((c) => c[0] === "schedule")![2] as Record<string, unknown>).schedule_start_time).toBe("2026-11-14T14:00:00.000Z");
    const seq = calls.find((c) => c[0] === "sequence" && JSON.stringify(c[2]).includes("Lunch"))![2] as { email_body: string }[];
    expect(seq[0].email_body).toBe("Hi {{first_name}},<br>Lunch?");

    // Smartlead says who was sent and who replied.
    const camps = await sql<{ id: string; smartlead_campaign_id: string; role: string; variant: string }[]>`
      select pc.id, pc.smartlead_campaign_id, pd.role, pc.variant from placement_campaigns pc join placement_domains pd on pd.id = pc.placement_domain_id`;
    for (const c of camps) {
      const sends = await sql<{ seed_email: string }[]>`select seed_email from placement_sends where campaign_id = ${c.id} order by seed_email`;
      // The control lands 5 of 6; the tested domain's real copy 1 of 6, its note 5 of 6: a copy problem.
      const replies = c.role === "control" || c.variant === "neutral" ? 5 : 1;
      stats.set(Number(c.smartlead_campaign_id), sends.map((s, i) => ({
        lead_email: s.seed_email, sent_time: "2026-11-14T15:00:00Z", reply_time: i < replies ? "2026-11-14T15:02:00Z" : null, is_bounced: false,
      })));
    }
    now = new Date("2026-11-14T16:00:00Z");
    const r2 = await runPlacementTests(sql, sl, { now: () => now });
    expect(r2).toMatchObject({ polled: 4, closed: 0 });
    const [counts] = await sql<{ sent: number; replied: number }[]>`select count(sent_at)::int as sent, count(replied_at)::int as replied from placement_sends`;
    expect(counts).toEqual({ sent: 24, replied: 16 });

    // 48 hours after the last email: stopped, and the seeds that answered are fresher.
    now = new Date("2026-11-16T16:00:00Z");
    const r3 = await runPlacementTests(sql, sl, { now: () => now });
    expect(r3).toMatchObject({ closed: 4, finished: 1 });
    expect(calls.filter((c) => c[0] === "status" && c[2] === "STOPPED")).toHaveLength(4);
    const [b] = await sql`select status from placement_batches`;
    expect(b.status).toBe("done");
    const [fresher] = await sql<{ n: number }[]>`select count(*)::int as n from placement_seeds where last_reply_at::date = '2026-11-14'`;
    expect(fresher.n).toBeGreaterThan(0);
  });

  it("counts an auto-reply Smartlead couldn't tie to the lead when it comes in as an untracked reply", async () => {
    await createPlacementBatch(sql, input(d));
    const { sl, stats } = fakeSmartlead();
    const now = new Date("2026-11-14T13:00:00Z");
    await runPlacementTests(sql, sl, { now: () => now });
    const [c] = await sql<{ id: string; smartlead_campaign_id: string; account_ids: string[] }[]>`
      select pc.id, pc.smartlead_campaign_id, pc.account_ids from placement_campaigns pc join placement_domains pd on pd.id = pc.placement_domain_id
      where pd.role = 'test' and pc.variant = 'sales'`;
    const [s] = await sql<{ seed_email: string }[]>`select seed_email from placement_sends where campaign_id = ${c.id} limit 1`;
    stats.set(Number(c.smartlead_campaign_id), [{ lead_email: s.seed_email, sent_time: "2026-11-14T15:00:00Z", reply_time: null, is_bounced: false }]);
    await sql`insert into untracked_replies (id, account_id, subject, sender_email, body, received_at)
      values ('u1', ${c.account_ids[0]}, 'Automatic reply: For Co', ${`former+noreply@${s.seed_email.split("@")[1]}`}, 'No longer with the company.', '2026-11-14T15:01:00Z')`;
    await runPlacementTests(sql, sl, { now: () => new Date("2026-11-14T16:00:00Z") });
    const [row] = await sql`select replied_at, reply_source from placement_sends where campaign_id = ${c.id} and seed_email = ${s.seed_email}`;
    expect(row.reply_source).toBe("untracked");
  });

  it("still builds when the client campaign it copies settings from is gone from Smartlead", async () => {
    await createPlacementBatch(sql, input(d));
    const { sl, calls } = fakeSmartlead();
    (sl as unknown as Record<string, unknown>).getCampaign = async () => { throw new Error("Smartlead GET /campaigns/555 failed (HTTP 404)"); };
    expect(await runPlacementTests(sql, sl, { now: () => new Date("2026-11-14T13:00:00Z") })).toMatchObject({ built: 4, failed: 0 });
    expect((calls.find((c) => c[0] === "settings")![2] as Record<string, unknown>).stop_lead_settings).toBe("REPLY_TO_AN_EMAIL");
  });

  it("does nothing in Smartlead's dry-run mode, and stops what it created when a test is cancelled", async () => {
    await createPlacementBatch(sql, input(d));
    const dry = fakeSmartlead({ dryRun: true });
    expect(await runPlacementTests(sql, dry.sl)).toMatchObject({ failed: 4, built: 0 });
    expect(dry.calls).toEqual([]);

    await setup();
    d = (await sql<{ id: string; name: string }[]>`select id, name from domains`).reduce((m, r) => ({ ...m, [r.name]: r.id }), {} as Record<string, string>);
    const r = await createPlacementBatch(sql, input(d));
    const live = fakeSmartlead();
    await runPlacementTests(sql, live.sl);
    await sql`update placement_batches set status = 'cancelled' where id = ${r.batchId}`;
    expect(await runPlacementTests(sql, live.sl)).toMatchObject({ cancelled: 4 });
    expect(live.calls.filter((c) => c[0] === "status" && c[2] === "STOPPED")).toHaveLength(4);
  });
});

describe("campaigns deleted in Smartlead", () => {
  it("are marked deleted and lose their inboxes, unless the list looks cut short", async () => {
    const d = await setup();
    await sql`delete from campaigns`;
    const [inbox] = await sql<{ id: string }[]>`select id from inboxes where domain_id = ${d["tested.com"]} limit 1`;
    for (const id of [1, 2, 3]) {
      await sql`insert into campaigns (id, name, status) values (${id}, ${`C${id}`}, 'ACTIVE')`;
      await sql`insert into campaign_inboxes (campaign_id, inbox_id) values (${id}, ${inbox.id})`;
    }
    const sl = (list: number[]) => ({
      listCampaigns: async () => list.map((id) => ({ id, name: `C${id}`, status: "ACTIVE" })),
      campaignEmailAccounts: async () => [],
    }) as never;

    // Only one of three came back: too few to trust, nothing is touched.
    expect(await syncCampaigns(sql, sl([1]))).toMatchObject({ deleted: 0 });
    // Campaign 3 is gone from Smartlead.
    expect(await syncCampaigns(sql, sl([1, 2]))).toMatchObject({ deleted: 1 });
    const rows = await sql<{ id: string; status: string; links: number }[]>`
      select c.id, c.status, (select count(*)::int from campaign_inboxes ci where ci.campaign_id = c.id) as links from campaigns c order by c.id`;
    expect(rows.map((r) => [Number(r.id), r.status])).toEqual([[1, "ACTIVE"], [2, "ACTIVE"], [3, "DELETED"]]);
    expect(rows[2].links).toBe(0);
  });
});
