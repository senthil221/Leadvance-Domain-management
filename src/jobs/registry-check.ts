import type postgres from "postgres";
import type { RdapClient } from "../integrations/rdap";

type Sql = postgres.Sql;

/**
 * Asks the registry about the domains checked longest ago (never checked
 * first), a batch per run, and keeps what it says on each domain: found or not,
 * registrar of record, expiry and status. Each registry server gets one question
 * at a time with a gap between, and one that asks us to slow down is left alone
 * until the next run. A domain is asked again after a week; one the registry
 * couldn't answer for, after a day. A run stops after 75 seconds, since the
 * worker runs its jobs one after another.
 */
export async function checkRegistry(sql: Sql, rdap: RdapClient, opts: { limit?: number; gapMs?: number; maxMs?: number; sleep?: (ms: number) => Promise<void> } = {}) {
  const { limit = 120, gapMs = 500, maxMs = 75_000, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)) } = opts;
  const due = await sql<{ id: string; name: string }[]>`
    select id, name from domains
    where archived_at is null and (registry_checked_at is null or registry_checked_at < now() - interval '7 days')
    order by registry_checked_at nulls first, name limit ${limit}`;
  const started = Date.now();
  const lastAt = new Map<string, number>();
  const slowed = new Set<string>();
  let checked = 0, found = 0, missing = 0, failed = 0, skipped = 0;

  for (const d of due) {
    if (Date.now() - started > maxMs) break;
    const tld = d.name.split(".").pop() ?? "";
    let host: string | null = null;
    try {
      host = await rdap.hostFor(tld);
    } catch {
      // The lookup below reports it.
    }
    if (host && slowed.has(host)) { skipped++; continue; }
    if (host) {
      const wait = (lastAt.get(host) ?? 0) + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt.set(host, Date.now());
    }

    let r: Awaited<ReturnType<RdapClient["lookup"]>>;
    try {
      r = await rdap.lookup(d.name);
    } catch (e) {
      r = { found: null, error: e instanceof Error ? e.message : String(e), host };
    }
    if (r.found === null && r.throttled) {
      if (r.host) slowed.add(r.host);
      skipped++;
      continue;
    }
    checked++;
    if (r.found === true) {
      found++;
      await sql`update domains set registry_checked_at = now(), registry_found = true, registry_expires_at = ${r.expiresAt}::date,
          registry_registrar = ${r.registrar}, registry_status = ${r.status}::text[], registry_error = null
        where id = ${d.id}`;
    } else if (r.found === false) {
      missing++;
      await sql`update domains set registry_checked_at = now(), registry_found = false, registry_expires_at = null,
          registry_registrar = null, registry_status = '{}', registry_error = null
        where id = ${d.id}`;
    } else if (r.error.startsWith("Not a domain name")) {
      // Nothing to ask; the audit lists it. Looked at again in a week.
      failed++;
      await sql`update domains set registry_checked_at = now(), registry_found = null, registry_error = ${r.error} where id = ${d.id}`;
    } else {
      failed++;
      // What it said before stands; ask again in a day.
      await sql`update domains set registry_checked_at = now() - interval '6 days', registry_error = ${r.error.slice(0, 300)} where id = ${d.id}`;
    }
  }
  return { due: due.length, checked, found, missing, failed, skipped };
}
