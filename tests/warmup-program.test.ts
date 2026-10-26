import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enrolNewDomains } from "../src/jobs/warmup-program";
import { parseWarmupProgram, warmupProgress } from "../src/lib/warmup-program";
import { loadMigrations } from "../scripts/migrations";

describe("warmupProgress", () => {
  const start = new Date("2026-10-01T10:00:00Z");
  it("counts days from the day of enrolment and flags when the days are up", () => {
    expect(warmupProgress(start, 12, +start + 3_600_000)).toMatchObject({ day: 1, ready: false, left: 11 });
    expect(warmupProgress(start, 12, +start + 5 * 86_400_000)).toMatchObject({ day: 6, ready: false, left: 6 });
    expect(warmupProgress(start, 12, +start + 11 * 86_400_000)).toMatchObject({ day: 12, ready: false, left: 0 });
    expect(warmupProgress(start, 12, +start + 12 * 86_400_000)).toMatchObject({ day: 12, ready: true, pct: 100 });
    expect(warmupProgress(null, 12)).toBeNull();
  });
  it("keeps settings inside sensible bounds", () => {
    expect(parseWarmupProgram({ enabled: true, days: 500, perDay: -3, replyRate: "x" })).toMatchObject({ enabled: true, days: 60, perDay: 1, replyRate: 40 });
    expect(parseWarmupProgram(null).enabled).toBe(false);
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
  sql = postgres({ host: "127.0.0.1", port: PORT, database: "postgres", username: "postgres", max: 1, ssl: false, connection: { options: "" } });
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await server?.stop();
  await pg?.close();
});

async function domain(name: string, tags: string[] = []) {
  const [d] = await sql`insert into domains (name, status, tags) values (${name}, 'warming', ${tags}) returning id`;
  return d.id as string;
}
async function inbox(domainId: string, email: string, daysOld: number, tags: string[] = []) {
  await sql`insert into inboxes (domain_id, email, status, smartlead_account_id, smartlead_tags, smartlead_created_at)
    values (${domainId}, ${email}, 'connected', ${Math.floor(Math.random() * 1e9)}, ${tags}, now() - (${daysOld} || ' days')::interval)`;
}
const save = (v: object) => sql`insert into settings (key, value) values ('warmup_program', ${JSON.stringify(v)}::text::jsonb)
  on conflict (key) do update set value = excluded.value`;

describe("enrolNewDomains", () => {
  it("does nothing until warm-up is switched on in Settings", async () => {
    const fresh = await domain("fresh.com");
    await inbox(fresh, "a@fresh.com", 0);
    expect(await enrolNewDomains(sql)).toMatchObject({ skipped: expect.stringContaining("off") });
  });

  it("enrols only young, untagged domains, once, and queues the warmup values", async () => {
    await save({ enabled: true, days: 12, maxAgeDays: 1, perDay: 25, rampup: 3, replyRate: 35 });
    const old = await domain("old.com");
    await inbox(old, "a@old.com", 100);
    const replacement = await domain("replacement.com", ["New"]);
    await inbox(replacement, "a@replacement.com", 0);
    const client = (await sql`insert into clients (name) values ('Beebee') returning id`)[0].id as string;
    await sql`insert into client_tags (tag, display, client_id) values ('prateek batra', 'Prateek Batra', ${client})`;
    const tagged = await domain("tagged.com");
    await inbox(tagged, "a@tagged.com", 0, ["Prateek Batra"]);
    const fresh2 = await domain("fresh2.com");
    await inbox(fresh2, "a@fresh2.com", 0);
    await inbox(fresh2, "b@fresh2.com", 0);

    const r = await enrolNewDomains(sql);
    expect(r).toMatchObject({ enrolled: 2, inboxes: 3 }); // fresh.com and fresh2.com
    const rows = await sql`select name, warmup_days from domains where warmup_started_at is not null order by name`;
    expect(rows.map((x) => x.name)).toEqual(["fresh.com", "fresh2.com"]);
    expect(rows[0].warmup_days).toBe(12);
    const [c] = await sql`select changes, status, source from inbox_setting_changes limit 1`;
    expect(c).toMatchObject({ changes: { warmup_enabled: true, warmup_per_day: 25, warmup_rampup: 3, warmup_reply_rate: 35 }, status: "pending", source: "warmup-program" });

    expect(await enrolNewDomains(sql)).toMatchObject({ enrolled: 0 });
  });
});
