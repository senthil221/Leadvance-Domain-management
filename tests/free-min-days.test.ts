import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadMigrations } from "../scripts/migrations";
import { FREE_MIN_DAYS } from "../src/lib/expiring";

// A free domain needs more than 60 days left: Free domains, the replace window
// and starting a replacement all go by free_min_days() in the database.

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  for (const m of loadMigrations()) await db.exec(m.sql);
});
afterAll(async () => db.close());
beforeEach(async () => {
  await db.exec("truncate domains cascade; truncate replacement_batches cascade;");
});

/** Adds a domain expiring `days` from today (null for no known date). */
const add = async (name: string, days: number | null, status = "in_storage") => {
  const { rows } = await db.query<{ id: string }>(
    "insert into domains (name, status, expires_at) values ($1, $2, case when $3::int is null then null else current_date + $3::int end) returning id",
    [name, status, days]);
  return rows[0].id;
};
const free = async () =>
  (await db.query<{ name: string }>("select name from domains d where domain_is_free(d) order by name")).rows.map((r) => r.name);
const start = (oldId: string, newId: string) =>
  db.query("select start_replacement(array[$1]::uuid[], array[$2]::uuid[], 'expiring', null, 'test')", [oldId, newId]);

describe("free domains need more than 60 days left", () => {
  it("says 60 in the database and in the app", async () => {
    const { rows } = await db.query<{ n: number }>("select free_min_days() as n");
    expect(rows[0].n).toBe(FREE_MIN_DAYS);
  });

  it("counts a domain as free only with more than 60 days to go, or no known date", async () => {
    await add("expired.com", -2);
    await add("days30.com", 30);
    await add("days60.com", 60);
    await add("days61.com", 61);
    await add("year.com", 365);
    await add("nodate.com", null);
    expect(await free()).toEqual(["days61.com", "nodate.com", "year.com"]);
  });

  it("won't start a replacement onto a domain that runs out within 60 days", async () => {
    const old = await add("old.com", 200, "active");
    const soon = await add("soon.info", 45);
    await expect(start(old, soon)).rejects.toThrow(/soon\.info expires on .* within 60 days/);
    expect((await db.query<{ status: string }>("select status from domains where id = $1", [soon])).rows[0].status).toBe("in_storage");

    const later = await add("later.info", 127);
    await start(old, later);
    expect((await db.query<{ status: string }>("select status from domains where id = $1", [later])).rows[0].status).toBe("provisioning");
  });

  it("still lets a domain with no known date be picked", async () => {
    const old = await add("old2.com", 200, "active");
    const unknown = await add("unknown.com", null);
    await start(old, unknown);
    expect((await db.query<{ status: string }>("select status from domains where id = $1", [unknown])).rows[0].status).toBe("provisioning");
  });
});
