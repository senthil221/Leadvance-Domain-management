import type postgres from "postgres";

// Smartlead REST client (https://server.smartlead.ai/api/v1, api_key in the
// query string). Spaces calls out, retries 429/5xx with backoff, logs every
// call to api_calls without the key, and in dry-run mode never sends writes.

export class SmartleadError extends Error {
  constructor(message: string, public status: number | null, public path: string) {
    super(message);
  }
}

type Options = {
  apiKey: string;
  sql?: postgres.Sql;
  dryRun?: boolean;
  baseUrl?: string;
  minSpacingMs?: number;
  fetchImpl?: typeof fetch;
};

type Query = Record<string, string | number | boolean | undefined>;

export function createSmartlead({ apiKey, sql, dryRun = true, baseUrl = "https://server.smartlead.ai/api/v1", minSpacingMs = 350, fetchImpl = fetch }: Options) {
  let nextSlot = 0;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function log(method: string, path: string, status: number | null, started: number, error: string | null, dry = false) {
    if (!sql) return;
    try {
      await sql`insert into api_calls (service, method, path, status, duration_ms, error, dry_run)
        values ('smartlead', ${method}, ${path}, ${status}, ${Date.now() - started}, ${error}, ${dry})`;
    } catch { /* logging must never break a sync */ }
  }

  async function request<T = unknown>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) qs.set(k, String(v));
    const shownPath = qs.size ? `${path}?${qs}` : path;
    const started = Date.now();

    if (method !== "GET" && dryRun) {
      await log(method, shownPath, null, started, null, true);
      return { dryRun: true } as T;
    }

    qs.set("api_key", apiKey);
    const url = `${baseUrl}${path}?${qs}`;
    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      if (now < nextSlot) await wait(nextSlot - now);
      nextSlot = Math.max(now, nextSlot) + minSpacingMs;

      let res: Response;
      try {
        res = await fetchImpl(url, {
          method,
          headers: { Accept: "application/json", ...(opts.body ? { "Content-Type": "application/json" } : {}) },
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        if (attempt < 3) { await wait(1000 * 2 ** attempt); continue; }
        const msg = e instanceof Error ? e.message : String(e);
        await log(method, shownPath, null, started, msg);
        throw new SmartleadError(`Smartlead unreachable: ${msg}`, null, path);
      }

      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
        continue;
      }

      const text = await res.text();
      if (!res.ok) {
        const msg = text.slice(0, 300) || res.statusText;
        await log(method, shownPath, res.status, started, msg);
        throw new SmartleadError(`Smartlead ${method} ${path} failed (HTTP ${res.status}): ${msg}`, res.status, path);
      }
      await log(method, shownPath, res.status, started, null);
      try {
        return (text ? JSON.parse(text) : null) as T;
      } catch {
        return text as T;
      }
    }
  }

  return {
    dryRun,
    request,

    /** Every email account, following offset pagination. */
    async listEmailAccounts() {
      const out: unknown[] = [];
      for (let offset = 0; offset < 50_000; offset += 100) {
        const page = await request<unknown>("GET", "/email-accounts/", { query: { offset, limit: 100 } });
        const rows = asArray(page);
        out.push(...rows);
        if (rows.length < 100) break;
      }
      return out;
    },

    listCampaigns: () => request<unknown>("GET", "/campaigns/").then(asArray),
    listClients: () => request<unknown>("GET", "/client/").then(asArray),
    campaignEmailAccounts: (campaignId: number) => request<unknown>("GET", `/campaigns/${campaignId}/email-accounts`).then(asArray),

    /** Smartlead's per-domain sent/reply/bounce numbers for a date range. */
    domainHealth: (startDate: string, endDate: string, timezone: string) =>
      request<unknown>("GET", "/analytics/mailbox/domain-wise-health-metrics", {
        query: { start_date: startDate, end_date: endDate, timezone, full_data: true },
      }),

    // Writes: logged but not sent while dry-run is on.
    updateDailyLimit: (accountId: number, maxEmailPerDay: number) =>
      request("POST", `/email-accounts/${accountId}`, { body: { max_email_per_day: maxEmailPerDay } }),
    updateWarmup: (accountId: number, w: { warmup_enabled: boolean; total_warmup_per_day?: number; daily_rampup?: number }) =>
      request("POST", `/email-accounts/${accountId}/warmup`, { body: w }),
    addAccountsToCampaign: (campaignId: number, accountIds: number[]) =>
      request("POST", `/campaigns/${campaignId}/email-accounts`, { body: { email_account_ids: accountIds } }),
  };
}

export type Smartlead = ReturnType<typeof createSmartlead>;

// Smartlead wraps lists inconsistently: a bare array, or { data: [...] }, or
// { email_accounts: [...] }. Take the first array we find near the top.
export function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    for (const key of ["data", "result", "results", "email_accounts", "campaigns", "clients", "items", "rows"]) {
      const inner = (v as Record<string, unknown>)[key];
      if (Array.isArray(inner)) return inner;
      if (inner && typeof inner === "object") {
        const deeper = asArray(inner);
        if (deeper.length) return deeper;
      }
    }
  }
  return [];
}
