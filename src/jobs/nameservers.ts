import { Resolver } from "node:dns/promises";
import type postgres from "postgres";
import type { Hypertide } from "../integrations/hypertide";
import { sameNameservers, type Porkbun } from "../integrations/porkbun";

// Nameserver changes queued from the app (Set up dialog). Each request gets
// its pair (from Hypertide's reservation for that domain, or as typed), then
// Porkbun domains are switched and read back; other registrars get "manual"
// with the pair to copy. Shared by the worker and the app.

type Sql = postgres.Sql;
export type NsContext = { porkbun: Porkbun | null; hypertide: Hypertide | null };

async function finish(sql: Sql, id: string, status: string, message: string | null, target?: string[]) {
  await sql`update nameserver_requests set status = ${status}, message = ${message}, finished_at = now(),
      target = coalesce(${target ?? null}::text[], target)
    where id = ${id}`;
}

export async function processNameserverRequests(sql: Sql, ctx: NsContext, limit = 100) {
  // Claimed in one statement, so the worker and the app never double up.
  const claimed = await sql`
    update nameserver_requests r set status = 'running'
    from domains d left join vendors v on v.id = d.registrar_id
    where r.id in (select id from nameserver_requests where status = 'pending' order by created_at limit ${limit} for update skip locked)
      and d.id = r.domain_id
    returning r.id, r.source, r.target, d.id as domainid, d.name, v.name as registrar, d.registrar_api_access as apiaccess`;
  if (!claimed.length) return { requests: 0 };

  // One Hypertide call reserves (or returns) the pair for up to 100 domains.
  const pairs = new Map<string, string[]>();
  let htError: string | null = null;
  const wanted = claimed.filter((r) => r.source === "hypertide").map((r) => r.name as string);
  if (wanted.length && ctx.hypertide) {
    try {
      for (let i = 0; i < wanted.length; i += 100) {
        for (const [k, v] of await ctx.hypertide.previewNameservers(wanted.slice(i, i + 100))) pairs.set(k, v);
      }
    } catch (e) {
      htError = e instanceof Error ? e.message : String(e);
    }
  }
  let fallback: string[] = [];
  if (wanted.length && !ctx.hypertide) {
    const [row] = await sql`select value from settings where key = 'hypertide_nameservers'`;
    fallback = Array.isArray(row?.value) ? (row.value as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  }

  const tally: Record<string, number> = {};
  const count = (s: string) => { tally[s] = (tally[s] ?? 0) + 1; };
  for (const r of claimed) {
    const id = r.id as string, name = r.name as string;
    let ns: string[] = r.source === "custom" ? ((r.target as string[] | null) ?? []) : pairs.get(name) ?? fallback;
    ns = ns.map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!ns.length) {
      const why = r.source !== "hypertide" ? "No nameservers given"
        : htError ? htError
        : ctx.hypertide ? "Hypertide returned no pair for this domain"
        : "Hypertide isn't connected and no nameservers are set in Settings → Lifecycle";
      await finish(sql, id, "failed", why);
      count("failed");
      continue;
    }
    const isPorkbun = r.registrar === "Porkbun";
    if (!isPorkbun || !ctx.porkbun || r.apiaccess === false) {
      const why = !isPorkbun ? `Set these at ${r.registrar ?? "the registrar"}` : !ctx.porkbun ? "Porkbun isn't connected; set these by hand" : "API access is off for this domain at Porkbun; set these by hand";
      await finish(sql, id, "manual", why, ns);
      count("manual");
      continue;
    }
    try {
      await ctx.porkbun.updateNs(name, ns);
      if (ctx.porkbun.dryRun) {
        await finish(sql, id, "dry_run", "Dry run: Porkbun wasn't changed", ns);
        count("dry_run");
        continue;
      }
      const now = await ctx.porkbun.getNs(name);
      await sql`update domains set nameservers = ${now}, nameservers_checked_at = now() where id = ${r.domainid}`;
      if (sameNameservers(now, ns)) {
        await finish(sql, id, "done", null, ns);
        count("done");
      } else {
        await finish(sql, id, "failed", `Porkbun accepted the change but still reports ${now.join(", ") || "no nameservers"}`, ns);
        count("failed");
      }
    } catch (e) {
      await finish(sql, id, "failed", e instanceof Error ? e.message : String(e), ns);
      count("failed");
    }
  }
  return { requests: claimed.length, ...tally };
}

/**
 * Current nameservers from public DNS, for every domain still in use, oldest
 * check first. Works at any registrar and needs no API access. Porkbun's API
 * is only asked when DNS can't answer and the domain allows it.
 */
export async function checkNameservers(sql: Sql, porkbun: Porkbun | null, batch = 150, lookup = dnsLookup) {
  const due = await sql`
    select d.id, d.name, v.name as registrar, d.registrar_api_access as apiaccess
    from domains d left join vendors v on v.id = d.registrar_id
    where d.status not in ('burned', 'resting')
    order by d.nameservers_checked_at nulls first, d.name
    limit ${batch}`;
  let checked = 0, empty = 0, failed = 0;
  const queue = [...due];
  const worker = async () => {
    for (let d = queue.shift(); d; d = queue.shift()) {
      let ns: string[] | null = null;
      try {
        ns = await lookup(d.name as string);
      } catch {
        if (porkbun && d.registrar === "Porkbun" && d.apiaccess !== false) ns = await porkbun.getNs(d.name as string).catch(() => null);
      }
      if (ns === null) failed++;
      else if (!ns.length) empty++;
      else checked++;
      await sql`update domains set nameservers = coalesce(${ns}::text[], nameservers), nameservers_checked_at = now() where id = ${d.id}`;
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { checked, empty, failed };
}

const resolver = new Resolver({ timeout: 4000, tries: 2 });
resolver.setServers(["1.1.1.1", "8.8.8.8"]);

/** NS records, lowercased and sorted; [] when the domain has none (or doesn't resolve). */
async function dnsLookup(name: string): Promise<string[]> {
  try {
    return (await resolver.resolveNs(name)).map((n) => n.toLowerCase().replace(/\.$/, "")).sort();
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENODATA" || code === "ENOTFOUND") return [];
    throw e;
  }
}
