import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sheetFeed } from "../src/lib/sheet-capacity";
import { loadMigrations } from "../scripts/migrations";

const PORT = 54399;
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

async function domain(name: string, client: string, status: string, tags: string[] = []) {
  const [c] = await sql`insert into clients (name) values (${client}) on conflict (name) do update set name = excluded.name returning id`;
  const [d] = await sql`insert into domains (name, status, client_id, tags) values (${name}, ${status}, ${c.id}, ${tags}) returning id`;
  return d.id as string;
}
async function inbox(domainId: string, email: string, limit: number | null, tags: string[], status = "connected") {
  await sql`insert into inboxes (domain_id, email, status, daily_limit, smartlead_tags) values (${domainId}, ${email}, ${status}, ${limit}, ${tags})`;
}

describe("sheetFeed", () => {
  it("counts connected inboxes on active domains per client and tag, one row per limit", async () => {
    const a = await domain("alpha.com", "Kapable", "active");
    const b = await domain("beta.com", "Kapable", "active");
    await inbox(a, "a1@alpha.com", 7, ["Kapable"]);
    await inbox(a, "a2@alpha.com", 7, ["Kapable"]);
    await inbox(b, "b1@beta.com", 5, ["Kapable"]);
    await inbox(b, "b2@beta.com", 7, ["Kapable"], "disconnected");
    await inbox(b, "b3@beta.com", 0, ["Kapable"]);

    const feed = await sheetFeed(sql);
    // The biggest group first, whole limits, and accounts x limit adds up to the real volume (19).
    expect(feed.rows).toEqual([
      { client: "Kapable", tag: "Kapable", accounts: 2, limit: 7, domains: 1 },
      { client: "Kapable", tag: "Kapable", accounts: 1, limit: 5, domains: 1 },
    ]);
    expect(feed.rows.reduce((a, r) => a + r.accounts * r.limit, 0)).toBe(19);
    expect(feed.clients).toContain("Kapable");
  });

  it("leaves out new, warming and replaced domains, and drops New and Replaced as tags", async () => {
    const fresh = await domain("fresh.com", "Mvinix", "warming", ["New"]);
    await inbox(fresh, "f1@fresh.com", 7, ["Mvinix", "New"]);
    const grace = await domain("old.com", "Mvinix", "draining", ["Replaced"]);
    await inbox(grace, "o1@old.com", 7, ["Mvinix", "Replaced"]);
    const tagged = await domain("tagged.com", "Mvinix", "active", ["New"]);
    await inbox(tagged, "t1@tagged.com", 7, ["Mvinix"]);
    const live = await domain("live.com", "Mvinix", "active");
    await inbox(live, "l1@live.com", 9, ["Mvinix", "New"]);

    const feed = await sheetFeed(sql);
    const row = feed.rows.find((r) => r.client === "Mvinix");
    expect(row).toMatchObject({ tag: "Mvinix", accounts: 1, limit: 9, domains: 1 });
  });

  it("leaves out warmup: a warmup client or a warmup tag", async () => {
    const w = await domain("harrow.com", "New Warmup", "active");
    await inbox(w, "w1@harrow.com", 5, ["Kapable", "New Warmup"]);
    const k = await domain("gamma.com", "Warmers", "active");
    await inbox(k, "g1@gamma.com", 7, ["Warmers", "Warmup"]);
    await inbox(k, "g2@gamma.com", 7, ["Warmers"]);

    const feed = await sheetFeed(sql);
    expect(feed.rows.some((r) => r.client === "New Warmup")).toBe(false);
    expect(feed.rows.find((r) => r.client === "Warmers")).toMatchObject({ accounts: 1, limit: 7 });
    expect(feed.rows.some((r) => r.tag.toLowerCase().includes("warmup"))).toBe(false);
  });

  it("lists clients with nothing active so the sheet can zero them", async () => {
    await domain("idle.com", "Quiet", "warming");
    const feed = await sheetFeed(sql);
    expect(feed.rows.some((r) => r.client === "Quiet")).toBe(false);
    expect(feed.clients).toContain("Quiet");
  });

  it("keeps an untagged inbox under an empty tag", async () => {
    const d = await domain("plain.com", "Untagged", "active");
    await inbox(d, "p1@plain.com", 4, []);
    const feed = await sheetFeed(sql);
    expect(feed.rows.find((r) => r.client === "Untagged")).toMatchObject({ tag: "", accounts: 1, limit: 4 });
  });
});
