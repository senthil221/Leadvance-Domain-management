import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMigrations } from "../scripts/migrations";

// The page queries agree with the rest of the app: every page reads a domain's
// Hypertide order through domain_hypertide_order (0039), the same pick
// domain_standing makes, and every Replace button asks domain_being_replaced
// (0040), the check start_replacement makes. The queries run for real, on the
// app's camel-case client, against PGlite over a socket.

const PORT = 54395;
vi.mock("server-only", () => ({}));
vi.mock("../src/lib/db", async () => {
  const postgres = (await import("postgres")).default;
  const url = "postgres://postgres@127.0.0.1:54395/postgres";
  return {
    sql: postgres(url, { max: 1, onnotice: () => {}, transform: postgres.camel }),
    jobSql: postgres(url, { max: 1, onnotice: () => {} }),
  };
});

const { sql } = await import("../src/lib/db");
const { getDomainDetail, listDomains, listInboxes } = await import("../src/lib/queries");

let pg: PGlite;
let server: PGLiteSocketServer;
let seq = 0;

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
  await sql`truncate replacement_items, replacement_batches, hypertide_orders, icemail_mailboxes, icemail_domains, icemail_accounts, inboxes, domain_status_history, domains cascade`;
});

/** An active domain with one connected inbox, at a provider. */
async function domain(name: string, provider: "Hypertide" | "Icemail" | null = "Hypertide") {
  const [d] = await sql<{ id: string }[]>`
    insert into domains (name, status, inbox_provider_id)
    values (${name}, 'active', (select id from vendors where name = ${provider}))
    returning id`;
  await sql`insert into inboxes (domain_id, email, status) values (${d.id}, ${`u${++seq}@${name}`}, 'connected')`;
  return d.id;
}

/** An order seen `daysAgo` days ago; byName leaves domain_id empty, as for an order placed before the domain was added. */
async function order(name: string, status: string, o: { daysAgo?: number; gone?: boolean; payment?: string; byName?: boolean } = {}) {
  await sql`
    insert into hypertide_orders (id, domain_name, domain_id, status, payment_status, last_seen_at, gone_at)
    values (${`o${++seq}`}, ${name}, ${o.byName ? null : sql`(select id from domains where name = ${name})`}, ${status}, ${o.payment ?? "Paid"},
      now() - make_interval(days => ${o.daysAgo ?? 0}), ${o.gone ? sql`now()` : null})`;
}

const pick = async (id: string) =>
  (await sql<{ status: string | null; goneAt: Date | null }[]>`select status, gone_at from domain_hypertide_order where domain_id = ${id}`)[0] ?? null;
const standingOf = async (id: string) => (await sql<{ orderState: string | null }[]>`select order_state from domain_standing where domain_id = ${id}`)[0].orderState;
const row = async (id: string) => (await listDomains()).find((d) => d.id === id)!;
const inbox = async (id: string) => (await listInboxes()).find((i) => i.domainId === id)!;

describe("the Hypertide order a domain goes by", () => {
  it("prefers a Done order to a cancelled one Hypertide listed more recently", async () => {
    const id = await domain("donewins.com");
    await order("donewins.com", "Done", { daysAgo: 3 });
    await order("donewins.com", "NPC", { daysAgo: 0 });
    expect((await pick(id))?.status).toBe("Done");
    expect(await standingOf(id)).toBe("active");
    // The Domains page and the domain sheet used to show the newest live order: NPC.
    expect(await row(id)).toMatchObject({ htOrderStatus: "Done", htPayment: "Paid" });
    expect((await getDomainDetail(id))?.domain).toMatchObject({ htOrderStatus: "Done" });
    expect(await inbox(id)).toMatchObject({ domainOrder: "active", domainOrderStatus: "Done" });
  });

  it("prefers an order still listed to one Hypertide dropped, and shows nothing once every order is gone", async () => {
    const id = await domain("livewins.com");
    await order("livewins.com", "Done", { gone: true });
    await order("livewins.com", "In progress", { daysAgo: 2 });
    expect((await pick(id))?.status).toBe("In progress");
    expect(await row(id)).toMatchObject({ htOrderStatus: "In progress" });
    expect(await inbox(id)).toMatchObject({ domainOrder: "pending", domainOrderStatus: "In progress" });

    await sql`update hypertide_orders set gone_at = now() where domain_name = 'livewins.com'`;
    expect((await pick(id))?.goneAt).not.toBeNull();
    expect(await standingOf(id)).toBe("gone");
    expect(await row(id)).toMatchObject({ htOrderStatus: null, htPayment: null });
    expect((await getDomainDetail(id))?.domain).toMatchObject({ htOrderStatus: null });
    // Inboxes used to call this "No order"; it now says what domain_standing says.
    expect(await inbox(id)).toMatchObject({ domainOrder: "gone", domainOrderStatus: null });
  });

  it("counts an order by name when it isn't linked to the domain yet", async () => {
    const id = await domain("byname.com");
    await order("byname.com", "Done", { byName: true, payment: "Unpaid" });
    expect((await pick(id))?.status).toBe("Done");
    expect(await row(id)).toMatchObject({ htOrderStatus: "Done", htPayment: "Unpaid" });
  });

  it("reads a cancelled order the same everywhere, whichever word Hypertide used", async () => {
    for (const word of ["NPC", "Cancelled"]) {
      const name = `cancel-${word.toLowerCase()}.com`;
      const id = await domain(name);
      await order(name, word);
      expect(await standingOf(id)).toBe("cancelled");
      expect(await row(id)).toMatchObject({ htOrderStatus: word });
      expect(await inbox(id)).toMatchObject({ domainOrder: "cancelled", domainOrderStatus: word });
    }
  });
});

describe("the order state on Inboxes", () => {
  it("is domain_standing's for every kind of domain", async () => {
    const [acct] = await sql<{ id: string }[]>`
      insert into icemail_accounts (label, credentials, webhook_token, created_by)
      values ('Main', 'x', ${"t".repeat(32)}, 'test') returning id`;
    const ids = {
      htMissing: await domain("htmissing.com"),
      icActive: await domain("icactive.com", "Icemail"),
      icGone: await domain("icgone.com", "Icemail"),
      tenant: await domain("acme.onmicrosoft.com"),
      noProvider: await domain("noprovider.com", null),
    };
    await order("someoneelse.com", "Done");
    await sql`insert into icemail_domains (id, account_id, domain_name, domain_id, active) values
      ('ic1', ${acct.id}, 'icactive.com', ${ids.icActive}, true),
      ('ic2', ${acct.id}, 'icgone.com', ${ids.icGone}, true)`;
    await sql`update icemail_domains set gone_at = now() where id = 'ic2'`;

    const want = { htMissing: "missing", icActive: "active", icGone: "gone", tenant: null, noProvider: null };
    for (const [k, id] of Object.entries(ids)) {
      const got = await inbox(id);
      expect([k, got.domainOrder]).toEqual([k, want[k as keyof typeof want]]);
      expect([k, got.domainOrder]).toEqual([k, await standingOf(id)]);
    }
    expect((await inbox(ids.noProvider)).domainProvider).toBeNull();
    expect((await inbox(ids.icActive)).domainProvider).toBe("Icemail");
  });
});

describe("whether Replace is offered", () => {
  it("is off on every page only while the domain's replacement is running", async () => {
    const old = await domain("oldone.com");
    const [fresh] = await sql<{ id: string }[]>`insert into domains (name) values ('freshone.com') returning id`;
    const flags = async () => ({
      domains: (await row(old)).beingReplaced,
      sheet: (await getDomainDetail(old))?.domain.beingReplaced,
      inboxes: (await inbox(old)).domainBeingReplaced,
    });
    expect(await flags()).toEqual({ domains: false, sheet: false, inboxes: false });

    const [b] = await sql<{ id: string }[]>`select start_replacement(array[${old}]::uuid[], array[${fresh.id}]::uuid[], 'other', null, 'test') as id`;
    expect(await flags()).toEqual({ domains: true, sheet: true, inboxes: true });
    // The domain coming in isn't being replaced itself.
    expect((await row(fresh.id)).beingReplaced).toBe(false);

    // Finished (say the old domain was put back to active afterwards): it can be replaced again.
    await sql`update replacement_items set completed_at = now() where batch_id = ${b.id}`;
    expect(await flags()).toEqual({ domains: false, sheet: false, inboxes: false });
  });
});
