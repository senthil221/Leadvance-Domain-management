import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMigrations } from "../scripts/migrations";
import { isReplacementTld, REPLACEMENT_TLDS } from "../src/lib/tlds";

// Replacements use only .com, .co, .info, .pro, .org and .net, and the replace
// window offers the oldest free domains first. The query runs for real, on the
// app's camel-case client, against PGlite over a socket.

const PORT = 54394;
vi.mock("server-only", () => ({}));
vi.mock("../src/lib/db", async () => {
  const postgres = (await import("postgres")).default;
  const url = "postgres://postgres@127.0.0.1:54394/postgres";
  return {
    sql: postgres(url, { max: 1, onnotice: () => {}, transform: postgres.camel }),
    jobSql: postgres(url, { max: 1, onnotice: () => {} }),
  };
});

const { sql } = await import("../src/lib/db");
const { listStorageCandidates } = await import("../src/lib/queries");

let pg: PGlite;
let server: PGLiteSocketServer;

beforeAll(async () => {
  pg = await PGlite.create();
  for (const m of loadMigrations()) await pg.exec(m.sql);
  server = new PGLiteSocketServer({ db: pg, port: PORT, host: "127.0.0.1" });
  await server.start();
}, 60_000);

afterAll(async () => {
  await sql.end();
  await server.stop();
  await pg.close();
});

beforeEach(async () => {
  await sql`truncate domain_status_history, domains cascade`;
});

/** A domain in storage, bought `daysAgo` days ago (or registered then, when the purchase date isn't known). */
async function stored(name: string, daysAgo: number | null, o: { registeredOnly?: boolean } = {}) {
  const when = daysAgo === null ? null : sql`current_date - ${daysAgo}::int`;
  await sql`
    insert into domains (name, status, registrar_id, purchased_at, registered_at)
    values (${name}, 'in_storage', (select id from vendors where name = 'Porkbun'),
      ${o.registeredOnly ? null : when}, ${o.registeredOnly ? when : null})`;
}

describe("replacement endings", () => {
  it("knows the six endings, whatever the case", () => {
    expect([...REPLACEMENT_TLDS].sort()).toEqual(["co", "com", "info", "net", "org", "pro"]);
    expect(isReplacementTld("com")).toBe(true);
    expect(isReplacementTld("PRO")).toBe(true);
    expect(isReplacementTld("link")).toBe(false);
    expect(isReplacementTld("xyz")).toBe(false);
    expect(isReplacementTld(null)).toBe(false);
  });
});

describe("free domains offered in the replace window", () => {
  it("leaves out every other ending", async () => {
    for (const t of ["com", "co", "info", "pro", "org", "net", "link", "xyz", "io"]) await stored(`pick-${t}.${t}`, 100);
    const names = (await listStorageCandidates()).map((c) => c.name);
    expect(names.sort()).toEqual(["pick-co.co", "pick-com.com", "pick-info.info", "pick-net.net", "pick-org.org", "pick-pro.pro"]);
  });

  it("puts the oldest first, counting from registration when the purchase date isn't known, and unknown ages last", async () => {
    await stored("young.com", 20);
    await stored("unknown.com", null);
    await stored("old.info", 400);
    await stored("registered.net", 250, { registeredOnly: true });
    const list = await listStorageCandidates();
    expect(list.map((c) => c.name)).toEqual(["old.info", "registered.net", "young.com", "unknown.com"]);
    expect(list.find((c) => c.name === "registered.net")?.bornAt).toBeInstanceOf(Date);
    expect(list.find((c) => c.name === "unknown.com")?.bornAt).toBeNull();
  });
});

describe("auto-pick in the replace window", () => {
  it("takes free domains, same ending first, and never one still set up elsewhere", async () => {
    const { autoAssign } = await import("../src/components/domains/ReplaceDialog");
    await stored("leftover.com", 300);
    await sql`update domains set nameservers = '{ns1.cloudflare.com,ns2.cloudflare.com}' where name = 'leftover.com'`;
    await stored("rested.com", 250);
    await sql`update domains set last_used_on = current_date - 200 where name = 'rested.com'`;
    await stored("fresh.info", 200);
    await stored("fresh.com", 100);
    await stored("fresh2.info", 90);
    const list = await listStorageCandidates();
    const by = Object.fromEntries(list.map((c) => [c.name, c]));
    expect(by["leftover.com"]).toMatchObject({ free: false, setUpElsewhere: ["ns1.cloudflare.com", "ns2.cloudflare.com"] });
    expect(by["rested.com"]).toMatchObject({ free: false, setUpElsewhere: null });
    expect(by["fresh.info"]).toMatchObject({ free: true, setUpElsewhere: null });

    const t = (id: string, tld: string) => ({ id, name: `${id}.${tld}`, tld, clientName: null, clientHue: null });
    const names = (a: Record<string, string>) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, list.find((c) => c.id === v)!.name]));
    // A .com gets the free .com, the next .com a free .info (not the rested .com), and the used one comes last.
    expect(names(autoAssign([t("a", "com"), t("b", "com"), t("c", "com"), t("d", "com")], list)))
      .toEqual({ a: "fresh.com", b: "fresh.info", c: "fresh2.info", d: "rested.com" });
    // Nothing left but the leftover: it isn't picked.
    expect(names(autoAssign([t("a", "com"), t("b", "com"), t("c", "com"), t("d", "com"), t("e", "com")], list)).e).toBeUndefined();
  });
});
