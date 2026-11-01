import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDynadot, parseDynadotDomain } from "../src/integrations/dynadot";
import { loadRegistrars, registrarFor, type RegistrarAccount, type RegistrarClient } from "../src/integrations/registrars";
import { createSpaceship, parseSpaceshipDomain } from "../src/integrations/spaceship";
import { createUnstoppable, parseUnstoppableDomain } from "../src/integrations/unstoppable";
import { processNameserverRequests } from "../src/jobs/nameservers";
import { syncAllRegistrars } from "../src/jobs/registrar-sync";
import { open, seal } from "../src/lib/secret-box";
import { loadMigrations } from "../scripts/migrations";

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = [string, RequestInit];

describe("secret box", () => {
  it("round-trips and never stores the plain key", () => {
    const sealed = seal({ apiKey: "ud_mcp_secret123" });
    expect(sealed).not.toContain("secret123");
    expect(open(sealed)).toEqual({ apiKey: "ud_mcp_secret123" });
    expect(seal({ a: "1" })).not.toBe(seal({ a: "1" }));
  });
});

describe("Spaceship", () => {
  it("parses list items with their nameservers", () => {
    expect(parseSpaceshipDomain({
      name: "Sendwell.com", registrationDate: "2026-01-02T03:04:05Z", expirationDate: "2027-01-02T03:04:05Z",
      autoRenew: true, lifecycleStatus: "registered", nameservers: { provider: "basic", hosts: ["Launch1.spaceship.net.", "launch2.spaceship.net"] },
    })).toEqual({
      name: "sendwell.com", status: "registered", createdAt: new Date("2026-01-02T03:04:05Z"), expiresAt: new Date("2027-01-02T03:04:05Z"),
      autoRenew: true, apiAccess: null, nameservers: ["launch1.spaceship.net", "launch2.spaceship.net"],
    });
  });

  it("pages with take/skip, sends both key headers, and writes custom nameservers", async () => {
    const calls: Call[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      if (init.method === "PUT") return ok({ provider: "custom", hosts: ["a.ns.com", "b.ns.com"] });
      const skip = Number(new URL(url).searchParams.get("skip"));
      return ok({ items: Array.from({ length: skip === 0 ? 100 : 3 }, (_, i) => ({ name: `d${skip + i}.com` })), total: 103 });
    }) as unknown as typeof fetch;
    const sp = createSpaceship({ apiKey: "k", apiSecret: "s", dryRun: false, fetchImpl, minSpacingMs: 0 });
    expect(await sp.listAll()).toHaveLength(103);
    expect((calls[0][1].headers as Record<string, string>)["X-API-Secret"]).toBe("s");
    await sp.updateNs("d1.com", ["a.ns.com", "b.ns.com"]);
    const put = calls.find(([, i]) => i.method === "PUT")!;
    expect(put[0]).toBe("https://spaceship.dev/api/v1/domains/d1.com/nameservers");
    expect(JSON.parse(String(put[1].body))).toEqual({ provider: "custom", hosts: ["a.ns.com", "b.ns.com"] });
  });

  it("doesn't write in dry run", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await createSpaceship({ apiKey: "k", apiSecret: "s", dryRun: true, fetchImpl, minSpacingMs: 0 }).updateNs("x.com", ["a.b.com"]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Dynadot", () => {
  it("parses millisecond dates and the renew option", () => {
    const d = parseDynadotDomain({ Name: "Coldmail.io", Expiration: "1798761600000", Registration: "1767225600000", RenewOption: "auto-renew", Status: "active" });
    expect(d).toMatchObject({ name: "coldmail.io", status: "active", autoRenew: true, expiresAt: new Date(1798761600000), createdAt: new Date(1767225600000) });
  });

  it("keeps the key out of the log path, reads get_ns hosts in order, and adds hosts before set_ns", async () => {
    const urls: URL[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      const u = new URL(url);
      urls.push(u);
      switch (u.searchParams.get("command")) {
        case "list_domain": return ok({ ListDomainInfoResponse: { ResponseCode: 0, Status: "success", MainDomains: [{ Name: "a.com" }, { Name: "b.com" }] } });
        case "get_ns": return ok({ GetNsResponse: { ResponseCode: 0, Status: "success", NsContent: { Host1: "NS2.x.com", Host0: "ns1.x.com" } } });
        case "add_ns": return ok({ AddNsResponse: { ResponseCode: -1, Status: "error", Error: "name server already exists" } });
        default: return ok({ SetNsResponse: { ResponseCode: 0, Status: "success" } });
      }
    }) as unknown as typeof fetch;
    const dd = createDynadot({ apiKey: "KEY123", dryRun: false, fetchImpl, minSpacingMs: 0 });
    expect((await dd.listAll()).map((d) => d.name)).toEqual(["a.com", "b.com"]);
    expect(await dd.getNs("a.com")).toEqual(["ns1.x.com", "ns2.x.com"]);
    await dd.updateNs("a.com", ["ns1.x.com", "ns2.x.com"]);
    const set = urls.find((u) => u.searchParams.get("command") === "set_ns")!;
    expect(set.searchParams.get("ns0")).toBe("ns1.x.com");
    expect(set.searchParams.get("ns1")).toBe("ns2.x.com");
    expect(urls.filter((u) => u.searchParams.get("command") === "add_ns")).toHaveLength(2);
  });

  it("turns ResponseCode -1 into an error", async () => {
    const fetchImpl = vi.fn(async () => ok({ ListDomainInfoResponse: { ResponseCode: "-1", Status: "error", Error: "invalid key" } })) as unknown as typeof fetch;
    await expect(createDynadot({ apiKey: "bad", dryRun: false, fetchImpl, minSpacingMs: 0 }).listAll()).rejects.toThrow(/invalid key/);
  });
});

describe("Unstoppable Domains", () => {
  it("parses portfolio items", () => {
    expect(parseUnstoppableDomain({ name: "Reachout.com", purchasedAt: "2026-02-01T00:00:00Z", expiresAt: "2027-02-01T00:00:00Z", autoRenewal: { status: "active" } }))
      .toMatchObject({ name: "reachout.com", autoRenew: true, expiresAt: new Date("2027-02-01T00:00:00Z") });
  });

  it("pages until hasMore is false and reports queued nameserver changes as pending", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ud_mcp_k");
      if (url.endsWith("/ud_portfolio_list")) return ok({ domains: [{ name: `p${body.page}.com` }], pagination: { hasMore: body.page < 3 } });
      return ok({ results: [{ domain: "p1.com", success: true, operationId: "op1" }], successCount: 1, failureCount: 0 });
    }) as unknown as typeof fetch;
    const ud = createUnstoppable({ apiKey: "ud_mcp_k", dryRun: false, fetchImpl, minSpacingMs: 0 });
    expect((await ud.listAll()).map((d) => d.name)).toEqual(["p1.com", "p2.com", "p3.com"]);
    expect(await ud.updateNs("p1.com", ["a.ns.com", "b.ns.com"])).toEqual({ pending: true });
    expect(bodies.at(-1)).toEqual({ domains: [{ name: "p1.com", nameservers: ["a.ns.com", "b.ns.com"] }] });
  });

  it("fails when Unstoppable refuses the domain", async () => {
    const fetchImpl = vi.fn(async () => ok({ results: [{ domain: "p1.com", success: false, error: "domain locked" }] })) as unknown as typeof fetch;
    await expect(createUnstoppable({ apiKey: "ud_x", dryRun: false, fetchImpl, minSpacingMs: 0 }).updateNs("p1.com", ["a.b.com"])).rejects.toThrow(/domain locked/);
  });
});

const fakeClient = (provider: RegistrarClient["provider"], names: string[], over: Partial<RegistrarClient> = {}): RegistrarClient => ({
  provider, dryRun: false,
  listAll: async () => names.map((name) => ({ name, status: null, createdAt: null, expiresAt: new Date("2027-05-01T00:00:00Z"), autoRenew: true, apiAccess: null, nameservers: null })),
  getNs: vi.fn(async () => ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"]),
  updateNs: vi.fn(async () => ({ pending: false })),
  ...over,
});

describe("registrarFor", () => {
  const ud1: RegistrarAccount = { id: "u1", provider: "unstoppable", vendor: "Unstoppable Domains", label: "Main", client: fakeClient("unstoppable", []) };
  const ud2: RegistrarAccount = { ...ud1, id: "u2", label: "Account 2" };
  it("uses the domain's own account, or the registrar's only one", () => {
    expect(registrarFor({ registrars: [ud1, ud2] }, "Unstoppable Domains", "u2").account?.label).toBe("Account 2");
    expect(registrarFor({ registrars: [ud1] }, "Unstoppable Domains", null).account?.id).toBe("u1");
  });
  it("explains when it can't pick", () => {
    expect(registrarFor({ registrars: [ud1, ud2] }, "Unstoppable Domains", null).why).toMatch(/2 accounts/);
    expect(registrarFor({ registrars: [] }, "Dynadot", null).why).toMatch(/isn't connected/);
    expect(registrarFor({ registrars: [] }, "GoDaddy", null).why).toMatch(/can't change nameservers at GoDaddy/);
  });
});

describe("registrar accounts in the database", () => {
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
  beforeEach(async () => {
    await sql`truncate nameserver_requests, domains, registrar_accounts cascade`;
  });

  it("imports each account's domains, remembers the account, and records failures per account", async () => {
    const [a1] = await sql`insert into registrar_accounts (provider, label, credentials, created_by) values ('unstoppable', 'Main', ${seal({ apiKey: "ud_1" })}, 'me') returning id`;
    const [a2] = await sql`insert into registrar_accounts (provider, label, credentials, created_by) values ('unstoppable', 'Account 2', ${seal({ apiKey: "ud_2" })}, 'me') returning id`;
    const [dd] = await sql`insert into registrar_accounts (provider, label, credentials, created_by) values ('dynadot', 'Main', ${seal({ apiKey: "dd" })}, 'me') returning id`;
    const { accounts } = await loadRegistrars(sql, { dryRun: true, porkbun: null });
    expect(accounts.map((a) => a.vendor)).toEqual(["Dynadot", "Unstoppable Domains", "Unstoppable Domains"]);

    const byId = new Map(accounts.map((a) => [a.id, a]));
    byId.get(a1.id)!.client = fakeClient("unstoppable", ["one.com", "two.com"]);
    byId.get(a2.id)!.client = fakeClient("unstoppable", ["three.com"]);
    byId.get(dd.id)!.client = fakeClient("dynadot", [], { listAll: async () => { throw new Error("invalid key"); } });
    const r = await syncAllRegistrars(sql, accounts);
    expect(r).toMatchObject({ accounts: 3, domains: 3, added: 3, failed: 1 });

    const rows = await sql`select d.name, v.name as vendor, d.registrar_account_id as acc, d.status, d.expires_at from domains d join vendors v on v.id = d.registrar_id order by d.name`;
    expect(rows.map((x) => [x.name, x.vendor, x.acc, x.status])).toEqual([
      ["one.com", "Unstoppable Domains", a1.id, "in_storage"],
      ["three.com", "Unstoppable Domains", a2.id, "in_storage"],
      ["two.com", "Unstoppable Domains", a1.id, "in_storage"],
    ]);
    const [bad] = await sql`select last_ok, last_error from registrar_accounts where id = ${dd.id}`;
    expect(bad).toMatchObject({ last_ok: false, last_error: "invalid key" });

    // The nameserver change for three.com goes to the second account.
    await sql`insert into nameserver_requests (domain_id, source, target, actor) select id, 'custom', ${["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"]}, 'me' from domains where name = 'three.com'`;
    const out = await processNameserverRequests(sql, { porkbun: null, registrars: accounts, hypertide: null });
    expect(out).toMatchObject({ done: 1 });
    expect(byId.get(a2.id)!.client.updateNs).toHaveBeenCalledWith("three.com", ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"]);
    expect(byId.get(a1.id)!.client.updateNs).not.toHaveBeenCalled();
  });
});
