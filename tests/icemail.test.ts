import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createIcemail, parseIcemailMailbox } from "../src/integrations/icemail";
import { loadIcemailAccounts, syncAllIcemail, type IcemailAccount } from "../src/jobs/icemail-sync";
import { seal } from "../src/lib/secret-box";
import { loadMigrations } from "../scripts/migrations";

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const mailbox = (i: number, domain = "sendwell.com", extra: Record<string, unknown> = {}) => ({
  id: `mb${i}`, first_name: "John", last_name: "Doe", username: `John${i}@${domain}`, password: "Plaintext!1",
  type: "GOOGLE", status: "ACTIVE", active: true, master_inbox: i === 0,
  domains: { domain_id: `dm-${domain}`, domain }, next_billing_date: "2026-11-05T10:00:00.000Z", cost: "4.9", billing_cycle: "MONTHLY", ...extra,
});
const domain = (name: string, extra: Record<string, unknown> = {}) => ({
  domain_id: `dm-${name}`, domain: name, status: "ACTIVE", created_at: "2026-10-01T00:00:00.000Z", expires_at: "2027-10-01T00:00:00.000Z",
  import: true, mailbox_count: 3, dmarc: true, spf: true, dkim: true, mx_records: true, active: true, workspace_type: "GOOGLE", prewarmed: false, blacklisted: false, ...extra,
});

describe("Icemail client", () => {
  it("keeps only the fields it needs (never the password)", () => {
    const m = parseIcemailMailbox(mailbox(1));
    expect(m).toMatchObject({ id: "mb1", email: "john1@sendwell.com", domain: "sendwell.com", cost: 4.9, billingCycle: "MONTHLY", nextBillingOn: "2026-11-05" });
    expect(JSON.stringify(m)).not.toContain("Plaintext");
    expect(parseIcemailMailbox({ id: "x", username: "not an email" })).toBeNull();
  });

  it("sends the key in x-api-key and pages 50 at a time until total_count", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      urls.push(url);
      expect((init.headers as Record<string, string>)["x-api-key"]).toBe("ice_key");
      const page = Number(new URL(url).searchParams.get("page"));
      const n = page === 1 ? 50 : 7;
      return ok({ success: true, data: { mailboxes: Array.from({ length: n }, (_, i) => mailbox((page - 1) * 50 + i)), total_count: 57, page, limit: 50 } });
    }) as unknown as typeof fetch;
    const im = createIcemail({ apiKey: "ice_key", fetchImpl, minSpacingMs: 0 });
    expect(await im.listMailboxes()).toHaveLength(57);
    expect(urls).toEqual(["https://app.icemail.ai/api/v1/mailbox?page=1&limit=50", "https://app.icemail.ai/api/v1/mailbox?page=2&limit=50"]);
  });

  it("turns a bad key into an error", async () => {
    const fetchImpl = vi.fn(async () => ok({ success: false, message: "Invalid API key" }, 403)) as unknown as typeof fetch;
    await expect(createIcemail({ apiKey: "bad", fetchImpl, minSpacingMs: 0 }).workspace()).rejects.toThrow(/Invalid API key/);
  });
});

describe("Icemail sync", () => {
  const PORT = 54398;
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
    await sql`truncate domains, icemail_accounts cascade`;
  });

  const fakeClient = (domains: unknown[], mailboxes: unknown[]) => {
    const fetchImpl = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/workspace")) return ok({ success: true, data: [{ id: "ws_1", name: "B2bdrive" }] });
      if (path.endsWith("/wallet")) return ok({ success: true, data: { balance: 125.5, currency: "USD" } });
      if (path.endsWith("/domain")) return ok({ success: true, data: { domains, total_count: domains.length } });
      return ok({ success: true, data: { mailboxes, total_count: mailboxes.length } });
    }) as unknown as typeof fetch;
    return createIcemail({ apiKey: "k", fetchImpl, minSpacingMs: 0 });
  };

  it("links mailboxes to Smartlead inboxes, marks Icemail domains and takes them out of storage", async () => {
    const [acc] = await sql`insert into icemail_accounts (label, credentials, webhook_token, created_by)
      values ('Main', ${seal({ apiKey: "k" })}, ${"a".repeat(48)}, 'me') returning id`;
    // sendwell.com is already sending in Smartlead; fresh.io sits in storage.
    const [sw] = await sql`insert into domains (name, status) values ('sendwell.com', 'in_storage') returning id`;
    await sql`select transition_domain(${sw.id}, 'provisioning', 'test', 'test')`;
    await sql`insert into domains (name) values ('fresh.io')`;
    await sql`insert into inboxes (domain_id, email, status) values (${sw.id}, 'john0@sendwell.com', 'connected'), (${sw.id}, 'john1@sendwell.com', 'connected')`;

    const account: IcemailAccount = {
      id: acc.id, label: "Main",
      client: fakeClient(
        [domain("sendwell.com"), domain("fresh.io", { dkim: false }), domain("new-one.com")],
        [mailbox(0), mailbox(1), mailbox(2, "sendwell.com", { cost: "60", billing_cycle: "YEARLY" }), mailbox(3, "fresh.io")],
      ),
    };
    const r = await syncAllIcemail(sql, [account]);
    expect(r).toMatchObject({ workspaces: 1, domains: 3, mailboxes: 4, linked: 2 });

    const rows = await sql`select d.name, d.status::text, v.name as provider from domains d left join vendors v on v.id = d.inbox_provider_id order by d.name`;
    expect(rows.map((x) => [x.name, x.status, x.provider])).toEqual([
      ["fresh.io", "provisioning", "Icemail"],
      ["new-one.com", "in_storage", "Icemail"], // no mailboxes: still free
      ["sendwell.com", "provisioning", "Icemail"],
    ]);
    const [cost] = await sql`select sum(case when billing_cycle = 'YEARLY' then cost / 12 else cost end)::float8 as monthly
      from icemail_mailboxes where domain_id = ${sw.id} and gone_at is null`;
    expect(cost.monthly).toBeCloseTo(4.9 * 2 + 5);
    expect(JSON.stringify(await sql`select * from icemail_mailboxes`)).not.toContain("Plaintext");
    const [a] = await sql`select workspace_name, wallet_balance::float8 as wallet, last_ok, mailbox_count from icemail_accounts`;
    expect(a).toEqual({ workspace_name: "B2bdrive", wallet: 125.5, last_ok: true, mailbox_count: 4 });

    // Deleted at Icemail: marked gone, not removed.
    account.client = fakeClient([domain("sendwell.com")], [mailbox(0)]);
    await syncAllIcemail(sql, [account]);
    const live = await sql`select id from icemail_mailboxes where gone_at is null order by id`;
    expect(live.map((x) => x.id)).toEqual(["mb0"]);
    expect((await sql`select count(*)::int as n from icemail_domains where gone_at is not null`)[0].n).toBe(2);
  });

  it("loads saved keys and records a failing workspace", async () => {
    await sql`insert into icemail_accounts (label, credentials, webhook_token, created_by)
      values ('Broken', 'v1.bad.bad.bad', ${"b".repeat(48)}, 'me')`;
    const { accounts, broken } = await loadIcemailAccounts(sql);
    expect(accounts).toHaveLength(0);
    expect(broken).toHaveLength(1);
    await expect(syncAllIcemail(sql, accounts, broken)).rejects.toThrow();
    const [row] = await sql`select last_ok from icemail_accounts`;
    expect(row.last_ok).toBe(false);
  });
});
