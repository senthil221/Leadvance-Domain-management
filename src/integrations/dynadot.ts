import type postgres from "postgres";
import { cleanNs, createHttp, isoDate, validDomain } from "./http";
import type { RegistrarClient, RegistrarDomain } from "./registrars";

// Dynadot API3 (https://api.dynadot.com/api3.json): the key and command go in
// the query string, so only the command is logged. Every reply is wrapped in
// "<Command>Response" with ResponseCode 0 on success. A nameserver has to be
// registered in the account (add_ns) before set_ns accepts it.
// Regular accounts get one request a second.

type Options = { apiKey: string; sql?: postgres.Sql; dryRun?: boolean; fetchImpl?: typeof fetch; minSpacingMs?: number };

/** The inner object of { "XResponse": { ResponseCode, Status, ... } }. */
export function dynadotBody(json: Record<string, unknown>): Record<string, unknown> {
  const inner = Object.values(json).find((v) => v && typeof v === "object" && !Array.isArray(v));
  return (inner ?? json) as Record<string, unknown>;
}

export function dynadotError(json: Record<string, unknown>): string | null {
  const b = dynadotBody(json);
  const code = b.ResponseCode ?? b.SuccessCode;
  const failed = String(code) === "-1" || b.Status === "error" || typeof b.Error === "string";
  if (!failed) return null;
  return typeof b.Error === "string" && b.Error ? b.Error : "request refused";
}

export function parseDynadotDomain(raw: unknown): RegistrarDomain | null {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = validDomain(d.Name);
  if (!name) return null;
  const renew = typeof d.RenewOption === "string" ? d.RenewOption.toLowerCase() : "";
  const nsSettings = (d.NameServerSettings && typeof d.NameServerSettings === "object" ? d.NameServerSettings : {}) as Record<string, unknown>;
  const servers = Array.isArray(nsSettings.NameServers) ? nsSettings.NameServers.map((s) => (s && typeof s === "object" ? (s as { ServerName?: unknown }).ServerName : s)) : null;
  return {
    name,
    status: typeof d.Status === "string" ? d.Status : null,
    createdAt: isoDate(d.Registration),
    expiresAt: isoDate(d.Expiration),
    autoRenew: renew.includes("auto") ? true : renew ? false : null,
    apiAccess: null,
    nameservers: servers ? cleanNs(servers) : null,
  };
}

export function createDynadot({ apiKey, sql, dryRun = true, fetchImpl, minSpacingMs = 1100 }: Options): RegistrarClient {
  const base = "https://api.dynadot.com/api3.json";
  const http = createHttp({ service: "dynadot", baseUrl: base, sql, dryRun, fetchImpl, minSpacingMs, timeoutMs: 120_000 });
  const call = <T = Record<string, unknown>>(command: string, params: Record<string, string> = {}, write = false) => {
    const q = new URLSearchParams({ key: apiKey, command, ...params });
    const shown = params.domain ? `?command=${command}&domain=${params.domain}` : `?command=${command}`;
    return http.request<T>({ path: shown, url: `${base}?${q}`, write }, dynadotError);
  };

  return {
    provider: "dynadot",
    dryRun,
    async listAll() {
      const r = await call("list_domain");
      const b = r ? dynadotBody(r) : {};
      const list = [b.MainDomains, b.DomainInfoList, b.Domains].find(Array.isArray) as unknown[] | undefined;
      return (list ?? []).map((x) => parseDynadotDomain((x as { DomainInfo?: unknown })?.DomainInfo ?? x)).filter((d): d is RegistrarDomain => d !== null);
    },
    async getNs(domain) {
      const r = await call("get_ns", { domain });
      const content = (r ? dynadotBody(r).NsContent : null) as Record<string, unknown> | null;
      if (!content || typeof content !== "object") return [];
      return cleanNs(Object.entries(content).filter(([k]) => /^host\d+$/i.test(k)).sort(([a], [b]) => Number(a.slice(4)) - Number(b.slice(4))).map(([, v]) => v));
    },
    async updateNs(domain, ns) {
      if (dryRun) {
        await call("set_ns", { domain }, true);
        return { pending: false };
      }
      // Register each host first; "already added" errors are expected.
      for (const host of ns) await call("add_ns", { host }).catch(() => null);
      await call("set_ns", { domain, ...Object.fromEntries(ns.slice(0, 13).map((h, i) => [`ns${i}`, h])) }, true);
      return { pending: false };
    },
  };
}
