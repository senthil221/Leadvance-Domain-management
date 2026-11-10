import type postgres from "postgres";
import type { RdapClient } from "../integrations/rdap";

type Sql = postgres.Sql;

/** How gently to ask one registry server: the gap between questions, and a rest after it asked us to slow down. */
export type HostPace = { gapMs: number; restUntil: number; strikes: number };

// Kept for the life of the process (the worker), so a server that asked us to
// slow down rests across runs and is asked more gently afterwards.
const PACES = new Map<string, HostPace>();

const MAX_GAP_MS = 10_000;
const MAX_REST_MS = 30 * 60_000;

/**
 * Asks the registry about the domains checked longest ago (never checked
 * first) and keeps what it says on each domain: found or not, registrar of
 * record, expiry and status. Domains are queued by the server that answers for
 * them and the servers are taken in turn, each with its own gap between
 * questions, so a slow or strict one doesn't hold up the rest. A server that
 * asks us to slow down rests (a minute, doubling each time it asks again, up to
 * half an hour, or as long as it says) and is asked at twice the gap after.
 * A domain is asked again after a week; one the registry couldn't answer for,
 * after a day. A run stops after 75 seconds, since the worker runs its jobs one
 * after another.
 */
export async function checkRegistry(
  sql: Sql,
  rdap: RdapClient,
  opts: { limit?: number; pool?: number; gapMs?: number; maxMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; paces?: Map<string, HostPace> } = {},
) {
  const {
    limit = 400, pool = 2000, gapMs = 500, maxMs = 75_000,
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), paces = PACES,
  } = opts;
  const due = await sql<{ id: string; name: string; total: number }[]>`
    select id, name, count(*) over ()::int as total from domains
    where archived_at is null and (registry_checked_at is null or registry_checked_at < now() - interval '7 days')
    order by registry_checked_at nulls first, name limit ${pool}`;
  const started = now();
  const pace = (host: string) => {
    let p = paces.get(host);
    if (!p) paces.set(host, (p = { gapMs, restUntil: 0, strikes: 0 }));
    return p;
  };

  // One queue per server, oldest-checked first within each. "" holds the
  // domains no server was found for; the lookup says why.
  const hosts = new Map<string, string>();
  const queues = new Map<string, { id: string; name: string }[]>();
  for (const d of due) {
    const tld = (d.name.split(".").pop() ?? "").toLowerCase();
    if (!hosts.has(tld)) hosts.set(tld, (await rdap.hostFor(tld).catch(() => null)) ?? "");
    const host = hosts.get(tld)!;
    const q = queues.get(host);
    if (q) q.push(d);
    else queues.set(host, [d]);
  }
  let waiting = 0;
  for (const [host, q] of queues) {
    if (host && pace(host).restUntil > now()) {
      waiting += q.length;
      queues.delete(host);
    }
  }

  const lastAt = new Map<string, number>();
  let asked = 0, checked = 0, found = 0, missing = 0, failed = 0;
  while (queues.size && asked < limit && now() - started < maxMs) {
    // The server we may ask soonest.
    let host = "", at = Infinity;
    for (const h of queues.keys()) {
      const t = h && lastAt.has(h) ? lastAt.get(h)! + pace(h).gapMs : -Infinity;
      if (t < at) [host, at] = [h, t];
    }
    if (at - now() > 0) await sleep(at - now());
    const q = queues.get(host)!;
    const d = q.shift()!;
    if (!q.length) queues.delete(host);
    if (host) lastAt.set(host, now());
    asked++;

    let r: Awaited<ReturnType<RdapClient["lookup"]>>;
    try {
      r = await rdap.lookup(d.name);
    } catch (e) {
      r = { found: null, error: e instanceof Error ? e.message : String(e), host: host || null };
    }
    if (r.found === null && r.throttled) {
      const h = r.host ?? host;
      if (h) {
        const p = pace(h);
        p.strikes++;
        p.gapMs = Math.min(Math.max(p.gapMs * 2, 1000), MAX_GAP_MS);
        p.restUntil = now() + Math.max((r.retryAfterSec ?? 0) * 1000, Math.min(60_000 * 2 ** (p.strikes - 1), MAX_REST_MS));
      }
      waiting += 1 + (queues.get(h)?.length ?? 0);
      queues.delete(h);
      continue;
    }
    if (host) pace(host).strikes = 0;
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

  const resting = [...new Set(hosts.values())].filter((h) => h && (paces.get(h)?.restUntil ?? 0) > now())
    .map((h) => `${h} asked us to slow down, resting ${Math.ceil((paces.get(h)!.restUntil - now()) / 60_000)}m`);
  return { due: due[0]?.total ?? 0, checked, found, missing, failed, waiting, ...(resting.length ? { note: resting.join("; ") } : {}) };
}
