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
 * Current nameservers for every domain still in use, oldest check first.
 * Public DNS answers for healthy domains at any registrar. When it can't
 * (SERVFAIL: the registry points at nameservers that don't serve the zone),
 * the registry's own record (RDAP) says where the domain points, and the
 * domain is flagged as not answering. Porkbun's API is the last resort.
 */
export async function checkNameservers(sql: Sql, porkbun: Porkbun | null, batch = 150, lookup = dnsLookup, registry = rdapLookup) {
  const due = await sql`
    select d.id, d.name, v.name as registrar, d.registrar_api_access as apiaccess
    from domains d left join vendors v on v.id = d.registrar_id
    where d.status not in ('burned', 'resting')
    order by d.nameservers_checked_at nulls first, d.name
    limit ${batch}`;
  let checked = 0, empty = 0, notAnswering = 0, failed = 0;
  const queue = [...due];
  const worker = async () => {
    for (let d = queue.shift(); d; d = queue.shift()) {
      const name = d.name as string;
      let ns: string[] | null = null;
      let answering: boolean | null = null;
      try {
        ns = await lookup(name);
        answering = ns.length > 0;
      } catch {
        ns = await registry(name).catch(() => null);
        if (ns?.length) answering = false;
        else if (porkbun && d.registrar === "Porkbun" && d.apiaccess !== false) ns = await porkbun.getNs(name).catch(() => null);
      }
      if (ns === null) failed++;
      else if (answering === false) notAnswering++;
      else if (!ns.length) empty++;
      else checked++;
      await sql`update domains set nameservers = coalesce(${ns}::text[], nameservers),
          nameservers_answering = coalesce(${answering}::boolean, nameservers_answering), nameservers_checked_at = now()
        where id = ${d.id}`;
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { checked, notAnswering, empty, failed };
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

// IANA's list of RDAP servers per TLD, fetched once per process.
let rdapServers: Promise<Map<string, string>> | null = null;
function rdapBase(tld: string) {
  rdapServers ??= fetch("https://data.iana.org/rdap/dns.json", { signal: AbortSignal.timeout(10_000) })
    .then((r) => r.json())
    .then((j: { services: [string[], string[]][] }) => {
      const m = new Map<string, string>();
      for (const [tlds, urls] of j.services) for (const t of tlds) m.set(t, urls[0]);
      return m;
    })
    .catch((e) => { rdapServers = null; throw e; });
  return rdapServers.then((m) => m.get(tld) ?? null);
}

/** The nameservers the registry delegates to, or [] if its RDAP lists none. */
async function rdapLookup(name: string): Promise<string[]> {
  const base = await rdapBase(name.slice(name.lastIndexOf(".") + 1));
  if (!base) throw new Error("no RDAP server for this TLD");
  const res = await fetch(`${base.replace(/\/?$/, "/")}domain/${name}`, { headers: { accept: "application/rdap+json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`RDAP HTTP ${res.status}`);
  const j = (await res.json()) as { nameservers?: { ldhName?: string }[] };
  return (j.nameservers ?? []).map((n) => String(n.ldhName ?? "").toLowerCase().replace(/\.$/, "")).filter(Boolean).sort();
}
