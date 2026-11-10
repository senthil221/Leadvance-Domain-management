import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMigrations } from "../scripts/migrations";
import { createRdap, isBeingDeleted, parseBootstrap, parseRdapDomain, parseWhois, type RdapClient } from "../src/integrations/rdap";
import type { RegistrarAccount, RegistrarClient } from "../src/integrations/registrars";
import { syncRegistrarDomains } from "../src/jobs/registrar-sync";
import { checkRegistry } from "../src/jobs/registry-check";
import { auditIssues, issueText, registrarKey, type AuditRow } from "../src/lib/audit";

describe("RDAP answers", () => {
  it("falls back to WHOIS for a TLD without RDAP, at the server IANA names", async () => {
    const fetchImpl = (async () => Response.json({ services: [[["com"], ["https://rdap.example/"]]] })) as unknown as typeof fetch;
    const whoisImpl = vi.fn(async (host: string, query: string) => host === "whois.iana.org" ? "domain: CO\nwhois:        whois.registry.co\n"
      : query === "gone.co" ? "The queried object does not exist: DOMAIN NOT FOUND\n"
      : "Registry Expiry Date: 2027-02-24T23:59:59.0Z\r\nRegistrar: MarkMonitor, Inc.\r\nDomain Status: clientTransferProhibited https://icann.org/epp#clientTransferProhibited\r\nDomain Status: redemptionPeriod https://icann.org/epp#redemptionPeriod\r\n");
    const rdap = createRdap({ fetchImpl, whoisImpl });
    expect(await rdap.hostFor("co")).toBe("whois.registry.co");
    expect(await rdap.lookup("brand.co")).toEqual({ found: true, registrar: "MarkMonitor, Inc.", expiresAt: "2027-02-24", status: ["client transfer prohibited", "redemption period"], host: "whois.registry.co" });
    expect(await rdap.lookup("gone.co")).toEqual({ found: false, host: "whois.registry.co" });
    expect(whoisImpl.mock.calls.filter((c) => c[0] === "whois.iana.org")).toHaveLength(1);
    expect(parseWhois("% rate limited\n")).toMatchObject({ found: null });
  });

  it("reads the registrar, expiry and status, and the bootstrap's servers", () => {
    const r = parseRdapDomain({
      ldhName: "ATLASBROOK.COM",
      status: ["client delete prohibited", "Redemption Period"],
      events: [{ eventAction: "registration", eventDate: "2025-02-06T11:52:35Z" }, { eventAction: "expiration", eventDate: "2027-02-06T11:52:35Z" }],
      entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Unstoppable Domains Inc."]]] }],
    });
    expect(r).toEqual({ found: true, registrar: "Unstoppable Domains Inc.", expiresAt: "2027-02-06", status: ["client delete prohibited", "redemption period"] });
    expect(isBeingDeleted((r as { status: string[] }).status)).toBe(true);
    const map = parseBootstrap({ services: [[["com", "net"], ["https://rdap.verisign.com/com/v1/"]], [["info"], ["http://x/", "https://rdap.identitydigital.services/rdap"]]] });
    expect(map.get("net")).toBe("https://rdap.verisign.com/com/v1/");
    expect(map.get("info")).toBe("https://rdap.identitydigital.services/rdap/");
  });

  it("looks a name up at its TLD's server: 404 is no record, 429 is slow down", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("iana")) return Response.json({ services: [[["com"], ["https://rdap.example/"]]] });
      if (u.endsWith("/gone.com")) return new Response("", { status: 404 });
      if (u.endsWith("/busy.com")) return new Response("", { status: 429 });
      return Response.json({ events: [{ eventAction: "expiration", eventDate: "2027-01-01T00:00:00Z" }], entities: [] });
    }) as unknown as typeof fetch;
    const rdap = createRdap({ fetchImpl });
    expect(await rdap.lookup("gone.com")).toEqual({ found: false, host: "rdap.example" });
    expect(await rdap.lookup("busy.com")).toMatchObject({ found: null, throttled: true });
    expect(await rdap.lookup("here.com")).toMatchObject({ found: true, expiresAt: "2027-01-01" });
    expect(await rdap.lookup("x.com-old")).toMatchObject({ found: null, error: "Not a domain name: .com-old isn't a real ending" });
    // The bootstrap is read once.
    expect((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => String(c[0]).includes("iana"))).toHaveLength(1);
  });
});

const base: AuditRow = {
  id: "1", name: "a.com", tld: "com", status: "in_storage", clientName: null, clientHue: null,
  registrar: "Unstoppable Domains", registrarAccount: "Main", expiresAt: new Date("2027-02-06"), unregistered: false, gone: false,
  accountListedAt: null, registrarSeenAt: null, inUse: null, inboxCount: 0,
  registryCheckedAt: new Date(), registryFound: true, registryExpiresAt: new Date("2027-02-06"), registryRegistrar: "Unstoppable Domains Inc.",
  registryStatus: ["client transfer prohibited"], registryError: null, archivedAt: null, archivedReason: null, archivedBy: null,
};
const issues = (over: Partial<AuditRow>) => auditIssues({ ...base, ...over }, "2026-11-11");

describe("audit rules", () => {
  it("finds nothing wrong with a registered domain that matches", () => {
    expect(issues({})).toEqual([]);
    expect(registrarKey("Spaceship, Inc.")).toBe("spaceship");
    expect(registrarKey("Dynadot Inc")).toBe(registrarKey("Dynadot"));
  });

  it("tells the unwanted kinds apart", () => {
    expect(issues({ unregistered: true, expiresAt: null, registryFound: false })).toEqual(["unregistered"]);
    expect(issues({ registryFound: false })).toEqual(["unregistered"]);
    expect(issues({ gone: true })).toEqual(["gone"]);
    expect(issues({ gone: true, registryFound: false })).toEqual(["gone", "dropped"]);
    expect(issues({ registrar: null, registrarAccount: null, registryFound: false })).toEqual(["dropped"]);
    expect(issues({ registryStatus: ["redemption period"], expiresAt: new Date("2026-10-01") })).toContain("deleting");
    expect(issues({ expiresAt: new Date("2026-10-01"), registryExpiresAt: new Date("2026-10-01") })).toEqual(["expired_unused"]);
    expect(issues({ expiresAt: new Date("2026-10-01"), registryExpiresAt: new Date("2026-10-01"), inUse: "52 inboxes on it" })).toEqual(["expired_in_use"]);
    expect(issues({ archivedAt: new Date(), gone: true })).toEqual([]);
    expect(issues({ name: "a.com-old", tld: "com-old", gone: true })).toEqual(["bad_name"]);
  });

  it("flags a registrar we don't have, a transfer, and an expiry that doesn't match", () => {
    expect(issues({ registrar: null, registrarAccount: null, registryRegistrar: "NameSilo, LLC" })).toEqual(["other_registrar"]);
    expect(issues({ registryRegistrar: "Dynadot Inc" })).toEqual(["registrar_differs"]);
    expect(issues({ registryExpiresAt: new Date("2028-02-06") })).toEqual(["expiry_differs"]);
    expect(issueText("expiry_differs", { ...base, registryExpiresAt: new Date("2028-02-06") })).toBe("Registry: 6 Feb 2028; Unstoppable Domains · Main: 6 Feb 2027");
  });
});

describe("domain audit in the database", () => {
  const PORT = 54391;
  let pg: PGlite;
  let server: PGLiteSocketServer;
  let sql: postgres.Sql;
  let accountId: string;

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
  beforeEach(async () => {
    await sql`truncate domains, registrar_accounts, hypertide_orders cascade`;
    [{ id: accountId }] = await sql`insert into registrar_accounts (provider, label, credentials, created_by) values ('unstoppable', 'Main', 'x', 'me') returning id`;
  });

  const account = (names: string[]): RegistrarAccount => ({
    id: accountId, provider: "unstoppable", vendor: "Unstoppable Domains", label: "Main",
    client: {
      provider: "unstoppable", dryRun: false, getNs: async () => [], updateNs: async () => ({ pending: false }),
      listAll: async () => names.map((name) => ({ name, status: null, createdAt: null, expiresAt: new Date("2028-01-01"), autoRenew: null, apiAccess: null, nameservers: null })),
    } satisfies RegistrarClient,
  });
  const gone = async () => (await sql`select name from domains d where domain_gone_from_registrar(d) order by name`).map((r) => r.name);

  it("counts a domain the account's whole list no longer has as gone, but not from a list cut short", async () => {
    expect(await syncRegistrarDomains(sql, account(["a.com", "b.com", "c.com", "d.com"]))).toMatchObject({ added: 4, gone: 0 });
    expect(await gone()).toEqual([]);
    expect(await syncRegistrarDomains(sql, account(["a.com", "b.com", "c.com"]))).toMatchObject({ gone: 1 });
    expect(await gone()).toEqual(["d.com"]);
    // One of four is under half: taken as cut short, so nothing more is judged gone.
    await syncRegistrarDomains(sql, account(["a.com"]));
    expect(await gone()).toEqual(["d.com"]);
    // Back on the list: no longer gone.
    await syncRegistrarDomains(sql, account(["a.com", "b.com", "c.com", "d.com"]));
    expect(await gone()).toEqual([]);
  });

  it("archives only what nothing uses, keeps it archived through the sync, and leaves it out of the free pool", async () => {
    await syncRegistrarDomains(sql, account(["idle.com", "sending.com", "ordered.com", "setup.com"]));
    const id = async (n: string) => (await sql`select id from domains where name = ${n}`)[0].id as string;
    await sql`insert into inboxes (domain_id, email, status) values (${await id("sending.com")}, 'a@sending.com', 'connected')`;
    await sql`insert into hypertide_orders (id, domain_name, domain_id, status) values ('o1', 'ordered.com', ${await id("ordered.com")}, 'In progress')`;
    await sql`update domains set status = 'provisioning' where name = 'setup.com'`;
    expect((await sql`select name from domains d where domain_is_free(d) order by name`).map((r) => r.name)).toContain("idle.com");

    const ids = await Promise.all(["idle.com", "sending.com", "ordered.com", "setup.com"].map(id));
    const out = await sql`select name, archived, why from archive_domains(${ids}::uuid[], 'Not registered', 'me') order by name`;
    expect(out.map((r) => [r.name, r.archived, r.why])).toEqual([
      ["idle.com", true, null],
      ["ordered.com", false, "a live Hypertide order"],
      ["sending.com", false, "1 inboxes on it"],
      ["setup.com", false, "being set up"],
    ]);
    expect((await sql`select name from domains d where domain_is_free(d)`).map((r) => r.name)).not.toContain("idle.com");
    await syncRegistrarDomains(sql, account(["idle.com", "sending.com", "ordered.com", "setup.com"]));
    const [idle] = await sql`select archived_at, archived_reason, archived_by from domains where name = 'idle.com'`;
    expect(idle.archived_at).not.toBeNull();
    expect(idle).toMatchObject({ archived_reason: "Not registered", archived_by: "me" });
    expect((await sql`select archived, why from archive_domains(${[ids[0]]}::uuid[], '', 'me')`)[0]).toEqual({ archived: false, why: "already archived" });
  });

  it("asks the registry about the oldest-checked domains and keeps what it says", async () => {
    await sql`insert into domains (name, status) values ('here.com', 'in_storage'), ('gone.com', 'in_storage'), ('busy.info', 'in_storage'), ('odd.zz', 'in_storage'), ('fresh.com', 'in_storage')`;
    await sql`update domains set registry_checked_at = now() where name = 'fresh.com'`;
    const rdap: RdapClient = {
      hostFor: async (tld) => (tld === "zz" ? null : `rdap.${tld}`),
      lookup: async (name) => name === "here.com" ? { found: true, registrar: "Dynadot Inc", expiresAt: "2027-03-01", status: ["redemption period"], host: "rdap.com" }
        : name === "gone.com" ? { found: false, host: "rdap.com" }
        : name === "busy.info" ? { found: null, error: "slow down", host: "rdap.info", throttled: true }
        : { found: null, error: ".zz has no RDAP server", host: null },
    };
    const r = await checkRegistry(sql, rdap, { gapMs: 0 });
    expect(r).toEqual({ due: 4, checked: 3, found: 1, missing: 1, failed: 1, skipped: 1 });
    const rows = Object.fromEntries((await sql`select name, registry_found, registry_registrar, to_char(registry_expires_at, 'YYYY-MM-DD') as exp, registry_status, registry_error,
        registry_checked_at is not null as asked, registry_checked_at < now() - interval '5 days' as retry_soon from domains`).map((x) => [x.name, x]));
    expect(rows["here.com"]).toMatchObject({ registry_found: true, registry_registrar: "Dynadot Inc", exp: "2027-03-01", registry_status: ["redemption period"], registry_error: null });
    expect(rows["gone.com"]).toMatchObject({ registry_found: false, asked: true });
    expect(rows["busy.info"]).toMatchObject({ asked: false });
    expect(rows["odd.zz"]).toMatchObject({ registry_found: null, registry_error: ".zz has no RDAP server", retry_soon: true });

    // A domain the registry has no record of is never free and can't be a replacement.
    await sql`insert into domains (name, status) values ('old.com', 'active')`;
    await expect(sql`select start_replacement(array[(select id from domains where name = 'old.com')], array[(select id from domains where name = 'gone.com')], 'other', null, 'me')`)
      .rejects.toThrow(/gone\.com isn't registered: the registry has no record/);
    expect((await sql`select name from domains d where domain_is_free(d)`).map((x) => x.name)).not.toContain("gone.com");
  });
});
