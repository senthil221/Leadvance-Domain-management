import { randomUUID } from "node:crypto";
import type postgres from "postgres";

// Porkbun API v3 (https://api.porkbun.com/api/json/v3). Keys go in the JSON
// body. Errors carry a stable `code`. Writes send an Idempotency-Key so a
// retry can never apply twice, and in dry-run mode are logged, not sent.

export class PorkbunError extends Error {
  constructor(message: string, public code: string | null, public status: number | null) {
    super(message);
  }
}

type Options = {
  apiKey: string;
  secretKey: string;
  sql?: postgres.Sql;
  dryRun?: boolean;
  baseUrl?: string;
  minSpacingMs?: number;
  fetchImpl?: typeof fetch;
};

export type PorkbunDomain = {
  name: string;
  status: string | null;
  createdAt: Date | null;
  expiresAt: Date | null;
  autoRenew: boolean | null;
  apiAccess: boolean | null;
};

// Porkbun dates are "YYYY-MM-DD HH:MM:SS" in UTC.
const pbDate = (v: unknown) => {
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v.trim().replace(" ", "T") + (v.includes("Z") ? "" : "Z"));
  return Number.isNaN(d.getTime()) ? null : d;
};
const flag = (v: unknown) => (v === 1 || v === "1" || v === true ? true : v === 0 || v === "0" || v === false ? false : null);

export function parsePorkbunDomain(raw: unknown): PorkbunDomain | null {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = typeof d.domain === "string" ? d.domain.trim().toLowerCase() : "";
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)) return null;
  return {
    name,
    status: typeof d.status === "string" ? d.status : null,
    createdAt: pbDate(d.createDate),
    expiresAt: pbDate(d.expireDate),
    autoRenew: flag(d.autoRenew),
    apiAccess: flag(d.apiAccess),
  };
}

/** Nameservers compared as a set, case- and trailing-dot-insensitive. */
export function sameNameservers(a: string[], b: string[]) {
  const norm = (xs: string[]) => [...new Set(xs.map((x) => x.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean))].sort();
  const x = norm(a), y = norm(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

export function createPorkbun({ apiKey, secretKey, sql, dryRun = true, baseUrl = "https://api.porkbun.com/api/json/v3", minSpacingMs = 500, fetchImpl = fetch }: Options) {
  let nextSlot = 0;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function log(path: string, status: number | null, started: number, error: string | null, dry = false) {
    if (!sql) return;
    try {
      await sql`insert into api_calls (service, method, path, status, duration_ms, error, dry_run)
        values ('porkbun', 'POST', ${path}, ${status}, ${Date.now() - started}, ${error}, ${dry})`;
    } catch { /* logging must never break a sync */ }
  }

  async function call<T extends Record<string, unknown>>(path: string, body: Record<string, unknown> = {}, opts: { write?: boolean } = {}): Promise<T> {
    const started = Date.now();
    if (opts.write && dryRun) {
      await log(path, null, started, null, true);
      return { status: "SUCCESS", dryRun: true } as unknown as T;
    }
    const idempotencyKey = opts.write ? randomUUID() : undefined;
    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      if (now < nextSlot) await wait(nextSlot - now);
      nextSlot = Math.max(now, nextSlot) + minSpacingMs;

      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
          body: JSON.stringify({ ...body, apikey: apiKey, secretapikey: secretKey }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        if (attempt < 3) { await wait(1000 * 2 ** attempt); continue; }
        const msg = e instanceof Error ? e.message : String(e);
        await log(path, null, started, msg);
        throw new PorkbunError(`Porkbun unreachable: ${msg}`, null, null);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      let json: Record<string, unknown> = {};
      try { json = (await res.json()) as Record<string, unknown>; } catch { /* non-JSON error page */ }
      if (!res.ok || json.status !== "SUCCESS") {
        const code = typeof json.code === "string" ? json.code : null;
        const msg = typeof json.message === "string" ? json.message : res.statusText || "request failed";
        await log(path, res.status, started, `${code ?? ""} ${msg}`.trim());
        throw new PorkbunError(`Porkbun ${path} failed${code ? ` (${code})` : ""}: ${msg}`, code, res.status);
      }
      await log(path, res.status, started, null);
      return json as T;
    }
  }

  return {
    dryRun,
    ping: () => call<{ credentialsValid?: boolean; account?: string; scopes?: string[] }>("/ping"),

    /** Every domain in the account, 1,000 per page. */
    async listAll() {
      const out: PorkbunDomain[] = [];
      for (let start = 0; start < 100_000; start += 1000) {
        const r = await call<{ domains?: unknown[] }>("/domain/listAll", { start });
        const page = Array.isArray(r.domains) ? r.domains : [];
        for (const raw of page) {
          const d = parsePorkbunDomain(raw);
          if (d) out.push(d);
        }
        if (page.length < 1000) break;
      }
      return out;
    },

    getNs: async (domain: string) => {
      const r = await call<{ ns?: unknown }>(`/domain/getNs/${encodeURIComponent(domain)}`);
      return Array.isArray(r.ns) ? r.ns.filter((x): x is string => typeof x === "string") : [];
    },

    updateNs: (domain: string, ns: string[]) =>
      call<{ dryRun?: boolean; warnings?: string[] }>(`/domain/updateNs/${encodeURIComponent(domain)}`, { ns }, { write: true }),
  };
}

export type Porkbun = ReturnType<typeof createPorkbun>;
