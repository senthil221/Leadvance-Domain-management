import type postgres from "postgres";
import { cleanNs, createHttp, isoDate, validDomain } from "./http";
import type { RegistrarClient, RegistrarDomain } from "./registrars";

// Unstoppable Domains User API (https://api.unstoppabledomains.com/mcp/v1):
// every call is a POST to /actions/<name> with a Bearer key. The portfolio
// lists the account's DNS (ICANN) domains; nameserver changes are queued
// and finish within minutes, so a read-back right after can still show the
// old pair.

type Options = { apiKey: string; sql?: postgres.Sql; dryRun?: boolean; fetchImpl?: typeof fetch; minSpacingMs?: number };

export function parseUnstoppableDomain(raw: unknown): RegistrarDomain | null {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = validDomain(d.name);
  if (!name) return null;
  const renewal = (d.autoRenewal && typeof d.autoRenewal === "object" ? d.autoRenewal : null) as { status?: unknown } | null;
  return {
    name,
    status: d.transferStatus === "pending" ? "transfer pending" : null,
    createdAt: isoDate(d.purchasedAt),
    expiresAt: isoDate(d.expiresAt),
    autoRenew: renewal ? renewal.status === "active" : null,
    apiAccess: null,
    nameservers: null,
  };
}

export function createUnstoppable({ apiKey, sql, dryRun = true, fetchImpl, minSpacingMs = 400 }: Options): RegistrarClient {
  const http = createHttp({ service: "unstoppable", baseUrl: "https://api.unstoppabledomains.com/mcp/v1/actions", sql, dryRun, fetchImpl, minSpacingMs });
  const headers = { Authorization: `Bearer ${apiKey.replace(/^bearer\s+/i, "")}` };
  const action = <T>(name: string, body: Record<string, unknown>, write = false) => http.request<T>({ method: "POST", path: `/${name}`, headers, body, write });

  return {
    provider: "unstoppable",
    dryRun,
    async listAll() {
      const out: RegistrarDomain[] = [];
      for (let page = 1; page <= 1000; page++) {
        const r = await action<{ domains?: unknown[]; pagination?: { hasMore?: boolean } }>("ud_portfolio_list", { page, pageSize: 100, registryType: "dns", orderBy: "name", orderDirection: "asc" });
        const list = Array.isArray(r?.domains) ? r.domains : [];
        for (const raw of list) {
          const d = parseUnstoppableDomain(raw);
          if (d) out.push(d);
        }
        if (!r?.pagination?.hasMore || !list.length) break;
      }
      return out;
    },
    async getNs(domain) {
      const r = await action<{ nameservers?: unknown[] }>("ud_dns_nameservers_list", { domain });
      return cleanNs(r?.nameservers ?? []);
    },
    async updateNs(domain, ns) {
      const r = await action<{ results?: { domain?: string; success?: boolean; error?: string }[] }>(
        "ud_dns_nameservers_set_custom", { domains: [{ name: domain, nameservers: ns }] }, true);
      if (r === null) return { pending: false }; // dry run
      const res = r.results?.find((x) => x.domain?.toLowerCase() === domain) ?? r.results?.[0];
      if (!res?.success) throw new Error(`Unstoppable refused the nameservers for ${domain}: ${res?.error ?? "no result"}`);
      return { pending: true };
    },
  };
}
