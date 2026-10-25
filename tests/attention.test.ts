import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attentionDomainCount } from "../src/lib/attention";
import { loadMigrations } from "../scripts/migrations";

const PORT = 54398;
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

async function domain(name: string, status = "active", extra: Record<string, unknown> = {}) {
  const [d] = await sql`insert into domains (name, status) values (${name}, ${status}) returning id`;
  if (Object.keys(extra).length) await sql`update domains set ${sql(extra)} where id = ${d.id}`;
  return d.id as string;
}
async function inbox(domainId: string, email: string, extra: Record<string, unknown> = {}) {
  await sql`insert into inboxes ${sql({ domain_id: domainId, email, status: "connected", warmup_enabled: true, warmup_reputation: 98, ...extra })}`;
}

describe("attentionDomainCount", () => {
  it("counts only domains with something wrong", async () => {
    const clean = await domain("clean.com", "active", { dns_spf: true, dns_dkim: true, dns_dmarc: true, dns_mx: true, nameservers_answering: true });
    await inbox(clean, "a@clean.com");
    expect(await attentionDomainCount(sql)).toBe(0);

    const lowRep = await domain("lowrep.com");
    await inbox(lowRep, "a@lowrep.com", { warmup_reputation: 85 });
    expect(await attentionDomainCount(sql)).toBe(1);

    const down = await domain("down.com");
    await inbox(down, "a@down.com", { status: "disconnected" });
    const off = await domain("off.com");
    await inbox(off, "a@off.com", { warmup_enabled: false });
    const blocked = await domain("blocked.com");
    await inbox(blocked, "a@blocked.com", { warmup_status: "BLOCKED" });
    const dns = await domain("dns.com", "active", { dns_dmarc: false });
    await inbox(dns, "a@dns.com");
    const listed = await domain("listed.com", "active", { blacklist_domain_count: 1 });
    await inbox(listed, "a@listed.com");
    expect(await attentionDomainCount(sql)).toBe(6);
  });

  it("leaves out domains that are not active or warming, or have no inboxes", async () => {
    const before = await attentionDomainCount(sql);
    const old = await domain("old.com", "draining");
    await inbox(old, "a@old.com", { warmup_reputation: 50 });
    await domain("empty.com", "active", { dns_spf: false });
    const gone = await domain("gone.com");
    await inbox(gone, "a@gone.com", { status: "removed", warmup_reputation: 50 });
    expect(await attentionDomainCount(sql)).toBe(before);
  });
});
