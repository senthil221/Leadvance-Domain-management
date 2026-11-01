import { Resolver } from "node:dns/promises";
import type postgres from "postgres";
import type { Hypertide } from "../integrations/hypertide";
import type { Porkbun } from "../integrations/porkbun";
import { API_REGISTRARS } from "../lib/registrar-providers";
import { accountName, applyNameservers, registrarFor, type RegistrarAccount, type RegistrarScope } from "../integrations/registrars";

// Nameserver changes queued from the app (Set up dialog). Each request gets
// its pair (from Hypertide's reservation for that domain, or as typed), then
// domains at a connected registrar are switched and read back; the rest get
// "manual" with the pair to copy. Shared by the worker and the app.

type Sql = postgres.Sql;
export type NsContext = { porkbun: Porkbun | null; registrars?: RegistrarAccount[]; hypertide: Hypertide | null };

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
    returning r.id, r.source, r.target, d.id as domainid, d.name, v.name as registrar, d.registrar_account_id as accountid, d.registrar_api_access as apiaccess`;
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
    const pick = registrarFor(ctx, r.registrar as string | null, r.accountid as string | null);
    if (!pick.account || (pick.account.provider === "porkbun" && r.apiaccess === false)) {
      const why = !pick.account
        ? (r.registrar && API_REGISTRARS.has(r.registrar) ? `${pick.why}; set these by hand` : `Set these at ${r.registrar ?? "the registrar"}`)
        : "API access is off for this domain at Porkbun; set these by hand";
      await finish(sql, id, "manual", why, ns);
      count("manual");
      continue;
    }
    const at = accountName(ctx, pick.account);
    try {
      const res = await applyNameservers(pick.account, name, ns);
      if (res.outcome === "dry_run") {
        await finish(sql, id, "dry_run", `Dry run: ${at} wasn't changed`, ns);
        count("dry_run");
        continue;
      }
      if (res.outcome === "done" || res.outcome === "pending") {
        await sql`update domains set nameservers = ${res.outcome === "done" ? res.now : ns}, nameservers_checked_at = now() where id = ${r.domainid}`;
        await finish(sql, id, "done", res.outcome === "pending" ? `${at} accepted the change; it can take a few minutes to show` : null, ns);
        count("done");
      } else {
        await finish(sql, id, "failed", `${at} accepted the change but still reports ${res.now.join(", ") || "no nameservers"}`, ns);
        count("failed");
      }
    } catch (e) {
      await finish(sql, id, "failed", e instanceof Error ? e.message : String(e), ns);
      count("failed");
    }
  }
  return { requests: claimed.length, ...tally };
}

export type Registry = { ns: string[]; registered: string | null };
export type Records = { spf: boolean; dkim: boolean; dmarc: boolean; mx: boolean };

/**
 * Nameservers, DNS records and registration date for every domain still in
 * use, oldest check first.
 * - Public DNS answers for healthy domains at any registrar. When it can't
 *   (SERVFAIL: the registry points at nameservers that don't serve the zone),
 *   the registry's own record (RDAP) says where it points, and the domain is
 *   flagged as not answering. The registrar's API is the last resort.
 * - Answering domains get their SPF, DKIM, DMARC and MX records checked.
 * - Domains whose registrar gave no purchase date get one from RDAP (domain age).
 */
export async function checkNameservers(
  sql: Sql, scope: RegistrarScope | Porkbun | null, batch = 150,
  lookup = dnsLookup, registry: (name: string) => Promise<Registry> = rdapLookup, records: (name: string, esps: string[]) => Promise<Records> = recordsLookup,
) {
  const due = await sql`
    select d.id, d.name, v.name as registrar, d.registrar_account_id as accountid, d.registrar_api_access as apiaccess,
      (d.purchased_at is null and d.registered_at is null) as needsage,
      coalesce((select array_agg(distinct i.provider_type) from inboxes i where i.domain_id = d.id and i.provider_type is not null), '{}') as esps
    from domains d left join vendors v on v.id = d.registrar_id
    where d.status not in ('burned', 'resting')
    order by d.nameservers_checked_at nulls first, d.name
    limit ${batch}`;
  // Older callers pass the .env Porkbun on its own.
  const accounts: RegistrarScope = scope && "getNs" in scope ? { porkbun: scope } : (scope ?? {});
  let checked = 0, notAnswering = 0, empty = 0, failed = 0, dnsMissing = 0;
  const queue = [...due];
  const worker = async () => {
    for (let d = queue.shift(); d; d = queue.shift()) {
      const name = d.name as string;
      let ns: string[] | null = null;
      let answering: boolean | null = null;
      let reg: Registry | null = null;
      try {
        ns = await lookup(name);
        answering = ns.length > 0;
      } catch {
        reg = await registry(name).catch(() => null);
        ns = reg?.ns ?? null;
        if (ns?.length) answering = false;
        else {
          const { account } = registrarFor(accounts, d.registrar as string | null, d.accountid as string | null);
          if (account && !(account.provider === "porkbun" && d.apiaccess === false)) ns = await account.client.getNs(name).catch(() => null);
        }
      }
      if (d.needsage && !reg) reg = await registry(name).catch(() => null);
      const rec = answering ? await records(name, d.esps as string[]).catch(() => null) : null;

      if (ns === null) failed++;
      else if (answering === false) notAnswering++;
      else if (!ns.length) empty++;
      else checked++;
      if (rec && !(rec.spf && rec.dkim && rec.dmarc && rec.mx)) dnsMissing++;

      await sql`update domains set
          nameservers = coalesce(${ns}::text[], nameservers),
          nameservers_answering = coalesce(${answering}::boolean, nameservers_answering),
          nameservers_checked_at = now(),
          registered_at = coalesce(${reg?.registered ?? null}::date, registered_at),
          dns_spf = case when ${rec !== null} then ${rec?.spf ?? null}::boolean else dns_spf end,
          dns_dkim = case when ${rec !== null} then ${rec?.dkim ?? null}::boolean else dns_dkim end,
          dns_dmarc = case when ${rec !== null} then ${rec?.dmarc ?? null}::boolean else dns_dmarc end,
          dns_mx = case when ${rec !== null} then ${rec?.mx ?? null}::boolean else dns_mx end,
          dns_checked_at = case when ${rec !== null} then now() else dns_checked_at end
        where id = ${d.id}`;
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { checked, notAnswering, empty, failed, dnsMissing };
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

const txt = (name: string) => resolver.resolveTxt(name).then((r) => r.map((parts) => parts.join("")), () => [] as string[]);

// DKIM keys live under a selector the mail host picks: Microsoft 365 uses
// selector1/selector2, Google "google"; the rest are common defaults.
const SELECTORS: Record<string, string[]> = { OUTLOOK: ["selector1", "selector2"], GMAIL: ["google"], GOOGLE: ["google"] };
const FALLBACK_SELECTORS = ["selector1", "selector2", "google", "default", "s1", "s2", "k1", "dkim", "mail"];

async function hasDkim(name: string, esps: string[]) {
  const selectors = [...new Set([...esps.flatMap((e) => SELECTORS[e] ?? []), ...FALLBACK_SELECTORS])];
  for (const s of selectors) {
    const host = `${s}._domainkey.${name}`;
    if (await resolver.resolveCname(host).then((r) => r.length > 0, () => false)) return true;
    if ((await txt(host)).some((t) => /p=/i.test(t))) return true;
  }
  return false;
}

/** Whether the records cold email needs are published. */
export async function recordsLookup(name: string, esps: string[] = []): Promise<Records> {
  const [root, dmarc, mx, dkim] = await Promise.all([
    txt(name),
    txt(`_dmarc.${name}`),
    resolver.resolveMx(name).then((r) => r.length > 0, () => false),
    hasDkim(name, esps),
  ]);
  return {
    spf: root.some((t) => /^v=spf1\b/i.test(t.trim())),
    dmarc: dmarc.some((t) => /^v=dmarc1\b/i.test(t.trim())),
    mx,
    dkim,
  };
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

/** The registry's record: delegated nameservers and registration date. */
async function rdapLookup(name: string): Promise<Registry> {
  const base = await rdapBase(name.slice(name.lastIndexOf(".") + 1));
  if (!base) throw new Error("no RDAP server for this TLD");
  const res = await fetch(`${base.replace(/\/?$/, "/")}domain/${name}`, { headers: { accept: "application/rdap+json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`RDAP HTTP ${res.status}`);
  const j = (await res.json()) as { nameservers?: { ldhName?: string }[]; events?: { eventAction?: string; eventDate?: string }[] };
  const reg = (j.events ?? []).find((e) => e.eventAction === "registration")?.eventDate;
  return {
    ns: (j.nameservers ?? []).map((n) => String(n.ldhName ?? "").toLowerCase().replace(/\.$/, "")).filter(Boolean).sort(),
    registered: reg && !Number.isNaN(Date.parse(reg)) ? reg.slice(0, 10) : null,
  };
}
