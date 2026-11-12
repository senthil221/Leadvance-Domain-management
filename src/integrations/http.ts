import type postgres from "postgres";

// Shared transport for the registrar clients: one request at a time with a
// minimum gap, retries on 429/5xx and network errors, every call logged to
// api_calls (never the keys), and writes skipped in dry-run mode.

export class ApiError extends Error {
  constructor(message: string, public status: number | null) {
    super(message);
  }
}

export type HttpOptions = {
  service: string;
  baseUrl: string;
  sql?: postgres.Sql;
  dryRun?: boolean;
  minSpacingMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type Request = {
  method?: "GET" | "POST" | "PUT";
  /** Logged; must not carry keys. */
  path: string;
  /** Sent instead of path, for APIs that take the key in the query. */
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  write?: boolean;
  /** Called with the response headers of a successful reply (an async operation id, say). */
  onHeaders?: (headers: Headers) => void;
};

export function createHttp({ service, baseUrl, sql, dryRun = true, minSpacingMs = 300, timeoutMs = 60_000, fetchImpl = fetch }: HttpOptions) {
  let nextSlot = 0;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function log(method: string, path: string, status: number | null, started: number, error: string | null, dry = false) {
    if (!sql) return;
    try {
      await sql`insert into api_calls (service, method, path, status, duration_ms, error, dry_run)
        values (${service}, ${method}, ${path.slice(0, 500)}, ${status}, ${Date.now() - started}, ${error?.slice(0, 1000) ?? null}, ${dry})`;
    } catch { /* logging must never break a sync */ }
  }

  /** The parsed JSON body; `fail` turns a 200 body into an error message. */
  async function request<T = Record<string, unknown>>(req: Request, fail?: (json: Record<string, unknown>) => string | null): Promise<T | null> {
    const method = req.method ?? (req.body === undefined ? "GET" : "POST");
    const started = Date.now();
    if (req.write && dryRun) {
      await log(method, req.path, null, started, null, true);
      return null;
    }
    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      if (now < nextSlot) await wait(nextSlot - now);
      nextSlot = Math.max(now, nextSlot) + minSpacingMs;

      let res: Response;
      try {
        res = await fetchImpl(req.url ?? `${baseUrl}${req.path}`, {
          method,
          headers: { Accept: "application/json", ...(req.body === undefined ? {} : { "Content-Type": "application/json" }), ...req.headers },
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        if (attempt < 3 && !req.write) { await wait(1000 * 2 ** attempt); continue; }
        const msg = e instanceof Error ? e.message : String(e);
        await log(method, req.path, null, started, msg);
        throw new ApiError(`${service} unreachable: ${msg}`, null);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 1500 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try { json = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { /* non-JSON error page */ }
      const problem = !res.ok ? errorText(json) ?? (text.trim().slice(0, 200) || res.statusText || `HTTP ${res.status}`) : fail?.(json) ?? null;
      if (problem) {
        await log(method, req.path, res.status, started, problem);
        const hint = res.status === 401 || res.status === 403 ? " (check the key and its permissions)" : "";
        throw new ApiError(`${service} ${req.path.split("?")[0]} failed: ${problem}${hint}`, res.status);
      }
      await log(method, req.path, res.status, started, null);
      req.onHeaders?.(res.headers);
      return json as T;
    }
  }

  return { dryRun, request };
}

/** The message in a typical JSON error body. */
export function errorText(json: Record<string, unknown>): string | null {
  for (const k of ["detail", "message", "error", "Error", "title"]) {
    const v = json[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v && typeof v === "object" && typeof (v as { message?: unknown }).message === "string") return (v as { message: string }).message;
  }
  return null;
}

/** Lowercased, no trailing dot, de-duplicated. */
export const cleanNs = (xs: unknown[]) =>
  [...new Set(xs.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean))];

export const validDomain = (v: unknown) => {
  const name = typeof v === "string" ? v.trim().toLowerCase() : "";
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name) ? name : null;
};

export const isoDate = (v: unknown) => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const n = typeof v === "number" || /^\d{10,}$/.test(v) ? Number(v) : NaN;
  const d = Number.isFinite(n) ? new Date(n < 1e11 ? n * 1000 : n) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};
