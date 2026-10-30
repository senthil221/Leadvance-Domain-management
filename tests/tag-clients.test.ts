import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientSource, clientsFromMappedTags, clientsFromSenders, clientsFromTags } from "../src/jobs/smartlead-sync";
import { markOf, normTag, parseTagPairs } from "../src/lib/tag-map";
import { senderOverview, tagOverview } from "../src/lib/tag-list";
import { loadMigrations } from "../scripts/migrations";

describe("parseTagPairs", () => {
  it("reads pairs in the shape they were pasted", () => {
    const text = `Frederick Ungureit", "WiBotic",
  "Prateek Batra", "Beebee",
  "Braden Mineer" , "Bridge Hiring" ,
Amelia Wren\tQualifi
Neil Cornelius -> B2bdrive
just one
a, b, c`;
    const r = parseTagPairs(text);
    expect(r.pairs).toEqual([
      { tag: "Frederick Ungureit", client: "WiBotic" },
      { tag: "Prateek Batra", client: "Beebee" },
      { tag: "Braden Mineer", client: "Bridge Hiring" },
      { tag: "Amelia Wren", client: "Qualifi" },
      { tag: "Neil Cornelius", client: "B2bdrive" },
    ]);
    expect(r.bad).toEqual(["just one", "a, b, c"]);
  });

  it("matches tags regardless of case and spacing", () => {
    expect(normTag("  Edward   DeAngelis ")).toBe(normTag("edward deangelis"));
  });

  it("knows the marks that go to Smartlead, typed in any case", () => {
    expect(markOf(" disconnected ")).toBe("Disconnected");
    expect(markOf("low  reputation")).toBe("Low reputation");
    expect(markOf("Remove")).toBeNull();
  });
});

const PORT = 54396;
let pg: PGlite;
let server: PGLiteSocketServer;
let sql: postgres.Sql;

beforeAll(async () => {
  pg = await PGlite.create();
  for (const m of loadMigrations()) await pg.exec(m.sql);
  server = new PGLiteSocketServer({ db: pg, port: PORT, host: "127.0.0.1" });
  await server.start();
  sql = postgres({ host: "127.0.0.1", port: PORT, database: "postgres", username: "postgres", max: 1, ssl: false, connection: { options: "" }, transform: postgres.camel });
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await server?.stop();
  await pg?.close();
});

async function client(name: string) {
  const [c] = await sql`insert into clients (name) values (${name}) returning id`;
  return c.id as string;
}
async function domain(name: string, clientId: string | null = null) {
  const [d] = await sql`insert into domains (name, status, client_id) values (${name}, 'active', ${clientId}) returning id`;
  return d.id as string;
}
async function inbox(domainId: string, email: string, tags: string[], sender: string | null = null) {
  await sql`insert into inboxes (domain_id, email, status, smartlead_tags, sender_name) values (${domainId}, ${email}, 'connected', ${tags}, ${sender})`;
}
const clientOf = async (name: string) => (await sql`select c.name from domains d join clients c on c.id = d.client_id where d.name = ${name}`)[0]?.name ?? null;

describe("clientsFromMappedTags", () => {
  it("puts a domain under the client its mapped tags point to, several tags to one client", async () => {
    const beebee = await client("Beebee");
    const qualifi = await client("Qualifi");
    await sql`insert into client_tags (tag, display, client_id) values ('prateek batra', 'Prateek Batra', ${beebee}), ('raghav bansal', 'Raghav Bansal', ${beebee}), ('amelia wren', 'Amelia Wren', ${qualifi})`;

    const a = await domain("a.com");
    await inbox(a, "x@a.com", ["Prateek Batra"]);
    await inbox(a, "y@a.com", ["Raghav  Bansal"]);
    const b = await domain("b.com");
    await inbox(b, "x@b.com", ["amelia wren", "New"]);
    const c = await domain("c.com");
    await inbox(c, "x@c.com", ["Unmapped Person"]);

    expect(await clientsFromMappedTags(sql)).toEqual({ domainsMapped: 2 });
    expect(await clientOf("a.com")).toBe("Beebee");
    expect(await clientOf("b.com")).toBe("Qualifi");
    expect(await clientOf("c.com")).toBeNull();
  });

  it("keeps an existing client unless asked to overwrite, and the majority tag wins", async () => {
    const beebee = (await sql`select id from clients where name = 'Beebee'`)[0].id as string;
    const other = await client("Other");
    const d = await domain("d.com", other);
    await inbox(d, "1@d.com", ["Prateek Batra"]);
    await inbox(d, "2@d.com", ["Raghav Bansal"]);
    await inbox(d, "3@d.com", ["Amelia Wren"]);

    expect(await clientsFromMappedTags(sql)).toEqual({ domainsMapped: 0 });
    expect(await clientOf("d.com")).toBe("Other");
    expect(await clientsFromMappedTags(sql, true)).toEqual({ domainsMapped: 1 });
    expect(await clientOf("d.com")).toBe("Beebee");
    expect(beebee).toBeTruthy();
  });

  it("lists tags with their client, unmapped first, without the New and Replaced marks", async () => {
    const rows = await tagOverview(sql);
    expect(rows[0]).toMatchObject({ tag: "Unmapped Person", clientId: null, domains: 1, inboxes: 1 });
    expect(rows.some((r) => ["new", "replaced"].includes(r.key))).toBe(false);
    const prateek = rows.find((r) => r.key === "prateek batra");
    expect(prateek).toMatchObject({ clientName: "Beebee", domains: 2 });
    // Both spellings of one tag count together.
    expect(rows.find((r) => r.key === "raghav bansal")?.inboxes).toBe(2);
  });

  it("defaults to tags and reads the switch from settings", async () => {
    expect(await clientSource(sql)).toBe("tags");
    await sql`update settings set value = '"mapped"'::jsonb where key = 'client_source'`;
    expect(await clientSource(sql)).toBe("mapped");
  });
});

describe("clientsFromSenders", () => {
  it("puts domains no tag decides under the client most sender names point to, and leaves tagged ones alone", async () => {
    const qualifi = (await sql`select id from clients where name = 'Qualifi'`)[0].id as string;
    const straxo = await client("Straxo");
    await sql`insert into client_senders (sender, display, client_id) values ('sophia lark', 'Sophia Lark', ${qualifi}), ('george vellios', 'George Vellios', ${straxo})`;

    // Two senders, Sophia Lark has more inboxes: Qualifi, even over the client it had.
    const e = await domain("e.com", straxo);
    await inbox(e, "1@e.com", [], "Sophia  Lark");
    await inbox(e, "2@e.com", [], "sophia lark");
    await inbox(e, "3@e.com", [], "George Vellios");
    // A mapped tag decides this one, whatever the sender.
    const f = await domain("f.com");
    await inbox(f, "1@f.com", ["Prateek Batra"], "Sophia Lark");
    // A tag naming a client decides too.
    const g = await domain("g.com");
    await inbox(g, "1@g.com", ["Straxo"], "Sophia Lark");
    // An unmapped sender changes nothing.
    const h = await domain("h.com");
    await inbox(h, "1@h.com", [], "Nobody Mapped");

    expect(await clientsFromSenders(sql)).toEqual({ domainsFromSenders: 1 });
    expect(await clientOf("e.com")).toBe("Qualifi");
    expect(await clientOf("f.com")).toBeNull();
    expect(await clientOf("g.com")).toBeNull();
    expect(await clientOf("h.com")).toBeNull();
    // Running again moves nothing.
    expect(await clientsFromSenders(sql)).toEqual({ domainsFromSenders: 0 });
  });

  it("lists sender names with their client and the clients their domains are under", async () => {
    const rows = await senderOverview(sql);
    expect(rows.find((r) => r.key === "sophia lark")).toMatchObject({ clientName: "Qualifi", domains: 3, inboxes: 4 });
    expect(rows.find((r) => r.key === "sophia lark")?.current).toEqual(["Qualifi"]);
    expect(rows.find((r) => r.key === "nobody mapped")).toMatchObject({ clientId: null, domains: 1 });
  });
});

describe("clientsFromTags", () => {
  it("never makes a client of a mark", async () => {
    const d = await domain("marked.com");
    await inbox(d, "x@marked.com", ["Disconnected", "Cancelled", "Watch"]);
    await clientsFromTags(sql);
    expect(await sql`select name from clients where lower(name) in ('disconnected', 'cancelled', 'watch')`).toHaveLength(0);
    expect(await clientOf("marked.com")).toBeNull();
  });
});
