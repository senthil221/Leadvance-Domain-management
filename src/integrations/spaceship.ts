import type postgres from "postgres";
import { cleanNs, createHttp, isoDate, validDomain } from "./http";
import type { RegistrarClient, RegistrarDomain } from "./registrars";

// Spaceship API v1 (https://spaceship.dev/api/v1). Key and secret go in the
// X-API-Key / X-API-Secret headers. Domain lists carry nameservers, so the
// sync gets them for free. Nameserver writes are limited to 5 per domain
// per 5 minutes, which a replacement never comes near.

type Options = { apiKey: string; apiSecret: string; sql?: postgres.Sql; dryRun?: boolean; fetchImpl?: typeof fetch; minSpacingMs?: number };

export function parseSpaceshipDomain(raw: unknown): RegistrarDomain | null {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = validDomain(d.name);
  if (!name) return null;
  const ns = (d.nameservers && typeof d.nameservers === "object" ? d.nameservers : {}) as { hosts?: unknown };
  return {
    name,
    status: typeof d.lifecycleStatus === "string" ? d.lifecycleStatus : null,
    createdAt: isoDate(d.registrationDate),
    expiresAt: isoDate(d.expirationDate),
    autoRenew: typeof d.autoRenew === "boolean" ? d.autoRenew : null,
    apiAccess: null,
    nameservers: Array.isArray(ns.hosts) ? cleanNs(ns.hosts) : null,
  };
}

export function createSpaceship({ apiKey, apiSecret, sql, dryRun = true, fetchImpl, minSpacingMs = 1100 }: Options): RegistrarClient {
  // 300 requests per 5 minutes per user: one a second stays well inside it.
  const http = createHttp({ service: "spaceship", baseUrl: "https://spaceship.dev/api/v1", sql, dryRun, fetchImpl, minSpacingMs });
  const headers = { "X-API-Key": apiKey, "X-API-Secret": apiSecret };

  return {
    provider: "spaceship",
    dryRun,
    async listAll() {
      const out: RegistrarDomain[] = [];
      for (let skip = 0; skip < 100_000; skip += 100) {
        const r = await http.request<{ items?: unknown[]; total?: number }>({ path: `/domains?take=100&skip=${skip}&orderBy=name`, headers });
        const page = Array.isArray(r?.items) ? r.items : [];
        for (const raw of page) {
          const d = parseSpaceshipDomain(raw);
          if (d) out.push(d);
        }
        if (page.length < 100 || (typeof r?.total === "number" && skip + 100 >= r.total)) break;
      }
      return out;
    },
    async getNs(domain) {
      const r = await http.request<{ nameservers?: { hosts?: unknown[] } }>({ path: `/domains/${encodeURIComponent(domain)}`, headers });
      return cleanNs(r?.nameservers?.hosts ?? []);
    },
    async updateNs(domain, ns) {
      await http.request({ method: "PUT", path: `/domains/${encodeURIComponent(domain)}/nameservers`, headers, body: { provider: "custom", hosts: ns }, write: true });
      return { pending: false };
    },
  };
}
