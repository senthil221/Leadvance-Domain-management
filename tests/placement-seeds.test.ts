import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { syncPlacementSeeds, type MxLookup } from "../src/jobs/placement-seeds";
import { mxProvider, seedReason, seedStatus } from "../src/lib/placement-seeds";
import { loadMigrations } from "../scripts/migrations";

describe("which auto-replies make a seed", () => {
  it("takes the ones saying the person has left or the mailbox isn't read", () => {
    expect(seedReason("Thank you for your email. Jane Doe is no longer with Acme Corp. Your email will not be forwarded.")).toEqual({
      forwards: false, excerpt: "Jane Doe is no longer with Acme Corp. Your email will not be forwarded.",
    });
    expect(seedReason("This mailbox is no longer monitored.")?.forwards).toBe(false);
    expect(seedReason("Bob has left the company. Please contact sales@acme.com.")?.forwards).toBe(false);
    expect(seedReason("I have retired as of June.")).not.toBeNull();
  });

  it("marks the ones that pass the mail to someone", () => {
    expect(seedReason("Jane is no longer with the firm. Your message has been forwarded to her manager.")?.forwards).toBe(true);
    expect(seedReason("I no longer work at Acme. This inbox is monitored by our office team.")?.forwards).toBe(true);
    expect(seedReason("I'm no longer with Acme, my new email is jane@new.com")?.forwards).toBe(true);
    expect(seedReason("The person is no longer with Promier. Please note that this email is actively monitored.")?.forwards).toBe(true);
    expect(seedReason("This email is no longer active but is being monitored periodically.")?.forwards).toBe(true);
    expect(seedReason("Melissa is no longer with BGCWPA. Your email is being forward to the appropriate person.")?.forwards).toBe(true);
    expect(seedReason("Julie is no longer with the company. Your message has been received and forwarded.")?.forwards).toBe(true);
    // Saying it isn't monitored or forwarded doesn't count.
    expect(seedReason("Please note that this inbox is no longer being monitored.")?.forwards).toBe(false);
    expect(seedReason("I am no longer with Clean-Seas, and this email address is unmonitored.")?.forwards).toBe(false);
    expect(seedReason("This account is not being actively monitored, and messages are not forwarded. Sam is no longer with us.")?.forwards).toBe(false);
  });

  it("leaves out a colleague writing about someone who left: a person reads that address", () => {
    expect(seedReason("Adele no longer works for French Truck Coffee. Please remove her email. Myndi Savoy, Director of HR")).toBeNull();
    expect(seedReason("Veronica no longer works at AdvisorLaw - please take her off of your mailing list. Best, Kerry")).toBeNull();
  });

  it("leaves out out-of-office and ordinary replies", () => {
    expect(seedReason("I am out of the office and will be back on Monday.")).toBeNull();
    expect(seedReason("No longer with the team until Friday, I'll be back Monday.")).toBeNull();
    expect(seedReason("Sounds good, call me Tuesday.")).toBeNull();
    expect(seedReason("She has left a voicemail for you.")).toBeNull();
    expect(seedReason("I have left the office for the weekend. If you need immediate attention, please call.")).toBeNull();
    expect(seedReason(null)).toBeNull();
  });
});

describe("who receives a company's mail", () => {
  it("reads the provider from the preferred MX host", () => {
    expect(mxProvider([{ exchange: "alt1.aspmx.l.google.com", priority: 5 }, { exchange: "aspmx.l.google.com", priority: 1 }]))
      .toEqual({ provider: "google", name: "Google", host: "aspmx.l.google.com" });
    expect(mxProvider([{ exchange: "smtp.google.com.", priority: 1 }]).provider).toBe("google");
    expect(mxProvider([{ exchange: "acme-com.mail.protection.outlook.com", priority: 0 }])).toMatchObject({ provider: "outlook", name: "Microsoft 365" });
    expect(mxProvider([{ exchange: "us-smtp-inbound-1.mimecast.com", priority: 10 }])).toMatchObject({ provider: "gateway", name: "Mimecast" });
    expect(mxProvider([{ exchange: "mx0a-001.pphosted.com", priority: 10 }])).toMatchObject({ provider: "gateway", name: "Proofpoint" });
    expect(mxProvider([{ exchange: "mail.acme-hosting.net", priority: 10 }])).toEqual({ provider: "other", name: "acme-hosting.net", host: "mail.acme-hosting.net" });
    expect(mxProvider([])).toEqual({ provider: "none", name: null, host: null });
  });
});

describe("what a seed can be used for", () => {
  const NOW = Date.parse("2026-11-10T12:00:00Z");
  const seed = (over: Partial<Parameters<typeof seedStatus>[0]> = {}) => ({
    forwards: false, lastReplyAt: "2026-11-01T00:00:00.000Z", personRepliedAt: null, bouncedAt: null, provider: "google" as const, ...over,
  });
  it("counts only fresh Google seeds as ready", () => {
    expect(seedStatus(seed(), NOW)).toBe("ready");
    expect(seedStatus(seed({ lastReplyAt: "2026-08-01T00:00:00.000Z" }), NOW)).toBe("recheck");
    expect(seedStatus(seed({ provider: "outlook" }), NOW)).toBe("outlook");
    expect(seedStatus(seed({ provider: "gateway" }), NOW)).toBe("other");
    expect(seedStatus(seed({ provider: null }), NOW)).toBe("unknown");
  });
  it("excludes the ones a person answered from, that bounced since, forward, or have no mail server", () => {
    expect(seedStatus(seed({ personRepliedAt: "2026-11-05T00:00:00.000Z" }), NOW)).toBe("person");
    expect(seedStatus(seed({ bouncedAt: "2026-11-05T00:00:00.000Z" }), NOW)).toBe("bounced");
    expect(seedStatus(seed({ bouncedAt: "2026-10-01T00:00:00.000Z" }), NOW)).toBe("ready");
    expect(seedStatus(seed({ forwards: true }), NOW)).toBe("forwards");
    expect(seedStatus(seed({ provider: "none" }), NOW)).toBe("no_mx");
  });
});

const PORT = 54393;
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

let n = 0;
const event = (kind: "reply" | "bounce", lead: string, at: string, preview: string | null, replyClass: string | null) =>
  sql`insert into email_events (dedupe_key, kind, occurred_at, lead_email, preview, reply_class, campaign_name)
    values (${`k${++n}`}, ${kind}, ${at}, ${lead}, ${preview}, ${replyClass}, 'For Acme')`;
const MX: Record<string, { exchange: string; priority: number }[]> = {
  "acme.com": [{ exchange: "aspmx.l.google.com", priority: 1 }],
  "globex.com": [{ exchange: "globex-com.mail.protection.outlook.com", priority: 0 }],
};
const lookupMx: MxLookup = async (domain) => {
  if (MX[domain]) return MX[domain];
  if (domain === "flaky.com") throw Object.assign(new Error("queryMx ETIMEOUT flaky.com"), { code: "ETIMEOUT" });
  throw Object.assign(new Error(`queryMx ENOTFOUND ${domain}`), { code: "ENOTFOUND" });
};
const since = new Date("2026-01-01T00:00:00Z");
const seeds = async () =>
  sql<{ email: string; auto_replies: number; forwards: boolean; person: boolean; bounced: boolean; provider: string | null; source: string }[]>`
    select s.email, s.auto_replies, s.forwards, s.person_replied_at is not null as person, s.bounced_at is not null as bounced, d.provider, s.source
    from placement_seeds s left join placement_seed_domains d on d.domain = s.domain order by s.email`;

describe("the placement-seeds job", () => {
  beforeEach(async () => {
    await sql`delete from placement_seeds`;
    await sql`delete from placement_seed_domains`;
    await sql`delete from email_events`;
    await sql`delete from untracked_replies`;
  });

  it("collects seeds from campaign and untracked replies and looks up their mail", async () => {
    const left = "Jane is no longer with Acme. Your email won't be forwarded.";
    await event("reply", "jane@acme.com", "2026-11-01T10:00:00Z", left, "auto");
    await event("reply", "jane@acme.com", "2026-11-04T10:00:00Z", left, "auto");
    await event("reply", "bob@globex.com", "2026-11-02T10:00:00Z", "Bob has left the company. Mail is forwarded to his manager.", "auto");
    await event("reply", "sam@acme.com", "2026-11-02T10:00:00Z", "I'm out of office until Monday.", "ooo");
    await event("reply", "me@gmail.com", "2026-11-02T10:00:00Z", "I am no longer with Acme.", "auto");
    await event("reply", "former-employee+noreply@acme.com", "2026-11-02T10:00:00Z", "The person is no longer with Acme.", "auto");
    await event("reply", "real@acme.com", "2026-11-02T10:00:00Z", "I'm no longer with the old team but happy to talk", "human");
    await sql`insert into untracked_replies (id, subject, sender_name, sender_email, body, received_at)
      values ('u1', 'Automatic reply: For Initech', 'Peter Gibbons', 'Peter@Initech.com', 'Peter is no longer employed at Initech. This mailbox is not monitored.', '2026-11-03T09:00:00Z'),
             ('u2', 'Re: For Initech', 'Ann', 'ann@flaky.com', 'Ann no longer works at Flaky.', '2026-11-03T09:00:00Z')`;

    const r = await syncPlacementSeeds(sql, { lookupMx, since });
    expect(r).toMatchObject({ seeds: 4, added: 4, lookedUp: 3, lookupErrors: 1 });
    expect(await seeds()).toEqual([
      { email: "ann@flaky.com", auto_replies: 1, forwards: false, person: false, bounced: false, provider: null, source: "untracked" },
      { email: "bob@globex.com", auto_replies: 1, forwards: true, person: false, bounced: false, provider: "outlook", source: "reply" },
      { email: "jane@acme.com", auto_replies: 2, forwards: false, person: false, bounced: false, provider: "google", source: "reply" },
      { email: "peter@initech.com", auto_replies: 1, forwards: false, person: false, bounced: false, provider: "none", source: "untracked" },
    ]);
    const [peter] = await sql`select name, excerpt from placement_seeds where email = 'peter@initech.com'`;
    expect(peter).toEqual({ name: "Peter Gibbons", excerpt: "Peter is no longer employed at Initech. This mailbox is not monitored." });

    // A second run adds nothing, and the failed lookup waits a day before it's tried again.
    const again = await syncPlacementSeeds(sql, { lookupMx, since });
    expect(again).toMatchObject({ seeds: 4, added: 0, lookedUp: 0, lookupErrors: 0 });
  });

  it("reads a year back and rebuilds the list when the rules have changed since the last run", async () => {
    await event("reply", "jane@acme.com", "2026-11-01T10:00:00Z", "Jane is no longer with Acme.", "auto");
    // Kept by older rules, and not a seed now.
    await sql`insert into placement_seeds (email, domain, source, first_reply_at, last_reply_at) values ('alias2+noreply@acme.com', 'acme.com', 'reply', now(), now())`;
    await sql`insert into job_state (job, last_ok, last_detail) values ('placement-seeds', true, ${sql.json({ scannedTo: new Date().toISOString(), rules: 1 })})
      on conflict (job) do update set last_ok = true, last_detail = excluded.last_detail`;
    const r = await syncPlacementSeeds(sql, { lookupMx });
    expect(r).toMatchObject({ rebuilt: true, seeds: 1, rules: 2 });
    expect((await seeds()).map((s) => s.email)).toEqual(["jane@acme.com"]);
    await sql`delete from job_state where job = 'placement-seeds'`;
  });

  it("drops a seed once a person replies from it or an email to it bounces", async () => {
    const left = "Jane is no longer with Acme.";
    await event("reply", "jane@acme.com", "2026-11-01T10:00:00Z", left, "auto");
    await event("reply", "joe@acme.com", "2026-11-01T10:00:00Z", "Joe no longer works for Acme.", "auto");
    // A bounce before the auto-reply doesn't count.
    await event("bounce", "joe@acme.com", "2026-10-01T10:00:00Z", "550 no such user", null);
    await syncPlacementSeeds(sql, { lookupMx, since });
    expect((await seeds()).map((s) => [s.email, s.person, s.bounced])).toEqual([["jane@acme.com", false, false], ["joe@acme.com", false, true]]);

    await event("reply", "jane@acme.com", "2026-11-06T10:00:00Z", "Who is this? Please stop.", "negative");
    await event("bounce", "joe@acme.com", "2026-11-07T10:00:00Z", "550 no such user", null);
    const r = await syncPlacementSeeds(sql, { lookupMx, since });
    expect(r).toMatchObject({ personReplied: 1, bounced: 1 });
    const rows = await sql<{ email: string; person: Date | null; bounced: Date | null; last: Date }[]>`
      select email, person_replied_at as person, bounced_at as bounced, last_reply_at as last from placement_seeds order by email`;
    expect(rows[0].person?.toISOString()).toBe("2026-11-06T10:00:00.000Z");
    expect(rows[1].bounced!.getTime()).toBeGreaterThan(rows[1].last.getTime());
  });
});
