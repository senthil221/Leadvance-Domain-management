import net from "node:net";
import { isRealTld, isTenantName } from "../lib/audit";

// The public registry's record of a domain, over RDAP: does it exist, who is
// the registrar of record, when does it expire, and its EPP status (redemption
// period, pending delete…). Read only and keyless. IANA's bootstrap file says
// which server answers for each TLD; a TLD with none (.co, .io, .us) is asked
// over WHOIS instead, at the server IANA names for it.

export type RegistryRecord =
  | { found: true; registrar: string | null; expiresAt: string | null; status: string[] }
  | { found: false }
  | { found: null; error: string };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

/** The registrar's name from an RDAP entity: its vCard "fn", else its handle. */
function entityName(e: Json): string | null {
  const card = Array.isArray(e.vcardArray) ? e.vcardArray[1] : null;
  if (Array.isArray(card)) {
    for (const prop of card) {
      if (Array.isArray(prop) && prop[0] === "fn" && typeof prop[3] === "string" && prop[3].trim()) return prop[3].trim();
    }
  }
  return typeof e.handle === "string" && e.handle.trim() ? e.handle.trim() : null;
}

/** A 200 answer from an RDAP domain lookup. */
export function parseRdapDomain(json: unknown): RegistryRecord {
  const d = obj(json);
  const events = Array.isArray(d.events) ? d.events.map(obj) : [];
  const exp = events.find((e) => e.eventAction === "expiration")?.eventDate;
  const expiresAt = typeof exp === "string" && !Number.isNaN(Date.parse(exp)) ? new Date(exp).toISOString().slice(0, 10) : null;
  const entities = Array.isArray(d.entities) ? d.entities.map(obj) : [];
  const reg = entities.find((e) => Array.isArray(e.roles) && e.roles.includes("registrar"));
  const status = (Array.isArray(d.status) ? d.status : []).filter((s): s is string => typeof s === "string").map((s) => s.trim().toLowerCase());
  return { found: true, registrar: reg ? entityName(reg) : null, expiresAt, status };
}

/** IANA's bootstrap: TLD → the base URL of its RDAP server. */
export function parseBootstrap(json: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const services = Array.isArray(obj(json).services) ? (obj(json).services as unknown[]) : [];
  for (const s of services) {
    if (!Array.isArray(s) || !Array.isArray(s[0]) || !Array.isArray(s[1])) continue;
    const url = (s[1] as unknown[]).find((u): u is string => typeof u === "string" && u.startsWith("https://")) ?? (s[1] as unknown[]).find((u): u is string => typeof u === "string");
    if (!url) continue;
    for (const tld of s[0] as unknown[]) if (typeof tld === "string") out.set(tld.toLowerCase(), url.endsWith("/") ? url : `${url}/`);
  }
  return out;
}

/** "clientTransferProhibited https://icann.org/epp#…" → "client transfer prohibited", as RDAP writes it. */
const eppWords = (code: string) => code.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

/** A WHOIS answer from a registry. */
export function parseWhois(text: string): RegistryRecord {
  if (/no match|not found|does not exist|no data found|no entries found|^status:\s*(free|available)/im.test(text)) return { found: false };
  const line = (re: RegExp) => text.split(/\r?\n/).map((l) => l.match(re)?.[1]?.trim()).find(Boolean) ?? null;
  const registrar = line(/^\s*(?:Registrar|Sponsoring Registrar):\s*(.+)$/i);
  const exp = line(/^\s*(?:Registry Expiry Date|Registrar Registration Expiration Date|Expiry Date|Expiration Date):\s*(\S+)/i);
  const status = text.split(/\r?\n/).map((l) => l.match(/^\s*Domain Status:\s*(\S+)/i)?.[1]).filter((x): x is string => !!x).map(eppWords);
  if (!registrar && !exp) return { found: null, error: "the WHOIS answer had no registrar or expiry" };
  return { found: true, registrar, expiresAt: exp && !Number.isNaN(Date.parse(exp)) ? new Date(exp).toISOString().slice(0, 10) : null, status };
}


function whois(host: string, query: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(43, host);
    let out = "";
    s.setTimeout(timeoutMs, () => { s.destroy(); reject(new Error("timed out")); });
    s.on("connect", () => s.write(`${query}\r\n`));
    s.on("data", (d) => { out += d; if (out.length > 200_000) s.destroy(); });
    s.on("end", () => resolve(out));
    s.on("close", () => resolve(out));
    s.on("error", reject);
  });
}

/** A WHOIS server saying we asked too often. */
const WHOIS_LIMITED = /rate limit|limit exceeded|too many (?:requests|queries)|query quota|exceeded the (?:maximum|allowed)/i;

const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";

export type RdapClient = {
  /** The server that answers for a TLD (RDAP, else WHOIS), or null when there's none. */
  hostFor(tld: string): Promise<string | null>;
  lookup(name: string): Promise<RegistryRecord & { host: string | null; throttled?: boolean; retryAfterSec?: number }>;
};

type WhoisFn = (host: string, query: string, timeoutMs: number) => Promise<string>;

export function createRdap({ fetchImpl = fetch, timeoutMs = 15_000, whoisImpl = whois }: { fetchImpl?: typeof fetch; timeoutMs?: number; whoisImpl?: WhoisFn } = {}): RdapClient {
  let servers: Map<string, string> | null = null;
  let loadedAt = 0;
  const serverFor = async (tld: string) => {
    if (!servers || Date.now() - loadedAt > 24 * 3600_000) {
      const res = await fetchImpl(BOOTSTRAP_URL, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`IANA's RDAP list answered ${res.status}`);
      servers = parseBootstrap(await res.json());
      loadedAt = Date.now();
    }
    return servers.get(tld.toLowerCase()) ?? null;
  };
  // A TLD without RDAP: IANA's WHOIS says which server answers for it.
  const whoisHosts = new Map<string, string | null>();
  const whoisFor = async (tld: string) => {
    if (!whoisHosts.has(tld)) {
      const text = await whoisImpl("whois.iana.org", tld, timeoutMs);
      whoisHosts.set(tld, text.match(/^whois:\s*(\S+)/im)?.[1]?.toLowerCase() ?? null);
    }
    return whoisHosts.get(tld) ?? null;
  };
  const hostFor = async (tld: string) => {
    if (!isRealTld(tld)) return null;
    const base = await serverFor(tld);
    return base ? new URL(base).host : whoisFor(tld.toLowerCase());
  };
  return {
    hostFor,
    async lookup(name) {
      const tld = (name.split(".").pop() ?? "").toLowerCase();
      if (!isRealTld(tld)) return { found: null, error: `Not a domain name: .${tld} isn't a real ending`, host: null };
      if (isTenantName(name)) return { found: null, error: "Not a domain name: a Microsoft tenant name, which Microsoft holds", host: null };
      const base = await serverFor(tld);
      if (!base) {
        const host = await whoisFor(tld).catch(() => null);
        if (!host) return { found: null, error: `.${tld} has no RDAP or WHOIS server`, host: null };
        try {
          const text = await whoisImpl(host, name, timeoutMs);
          const r = parseWhois(text);
          // Only an answer with nothing in it counts: the terms of use in a real one can mention limits too.
          if (r.found === null && WHOIS_LIMITED.test(text)) return { found: null, error: `${host} asked us to slow down`, host, throttled: true };
          return { ...r, host };
        } catch (e) {
          return { found: null, error: `${host} didn't answer: ${e instanceof Error ? e.message : String(e)}`, host };
        }
      }
      const host = new URL(base).host;
      let res: Response;
      try {
        res = await fetchImpl(`${base}domain/${encodeURIComponent(name)}`, { headers: { Accept: "application/rdap+json, application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        return { found: null, error: `${host} didn't answer: ${e instanceof Error ? e.message : String(e)}`, host };
      }
      if (res.status === 404) return { found: false, host };
      if (res.status === 429) {
        const wait = Number(res.headers.get("retry-after"));
        return { found: null, error: `${host} asked us to slow down`, host, throttled: true, ...(wait > 0 ? { retryAfterSec: wait } : {}) };
      }
      if (!res.ok) return { found: null, error: `${host} answered ${res.status}`, host };
      try {
        return { ...parseRdapDomain(await res.json()), host };
      } catch {
        return { found: null, error: `${host} sent something that isn't RDAP`, host };
      }
    },
  };
}
