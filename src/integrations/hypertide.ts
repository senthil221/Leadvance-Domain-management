import type postgres from "postgres";

// Hypertide Standalone API (base URL from HYPERTIDE_API_URL, ".../api/v1").
// Auth is the x-api-key header. In dry-run, calls with side effects are sent
// with x-dry-run: true, so Hypertide still validates them but creates,
// charges and verifies nothing. Nameserver previews only reserve a pair and
// cost nothing, so they always run for real.

export class HypertideError extends Error {
  constructor(message: string, public code: string | null, public status: number | null) {
    super(message);
  }
}

type Options = {
  baseUrl: string;
  apiKey: string;
  sql?: postgres.Sql;
  dryRun?: boolean;
  minSpacingMs?: number;
  fetchImpl?: typeof fetch;
};

export type OrderStatus = {
  id: string;
  domain: string;
  status: string | null;
  paymentStatus: string | null;
  subscriptionId?: string | null;
  forwardingDomain?: string | null;
  sendingTool?: string | null;
  organizationName?: string | null;
  createdAt?: string | null;
};
export type NsResult = { domain: string; verified: boolean; message: string | null; expected: string[]; current: string[] };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

// "Validation failed: domains — Duplicate domains detected; …"
function describe(json: Json, fallback: string) {
  const parts: string[] = [];
  const details = json.details;
  if (Array.isArray(details)) {
    for (const d of details.slice(0, 4)) {
      const o = obj(d);
      if (o.reason) parts.push(o.field ? `${o.field}: ${o.reason}` : String(o.reason));
    }
  }
  const base = typeof json.message === "string" ? json.message : fallback;
  return parts.length ? `${base} (${parts.join("; ")})` : base;
}

/** Hypertide's per-domain nameserver lists: data.nameservers.domains[], or .ns for one domain. */
export function readNameservers(data: unknown): Map<string, string[]> {
  const ns = obj(obj(data).nameservers);
  const out = new Map<string, string[]>();
  const list = Array.isArray(ns.domains) ? ns.domains : [];
  for (const d of list) {
    const o = obj(d);
    if (typeof o.domain === "string") out.set(o.domain.toLowerCase(), strs(o.ns));
  }
  return out;
}

export function createHypertide({ baseUrl, apiKey, sql, dryRun = true, minSpacingMs = 2100, fetchImpl = fetch }: Options) {
  const root = baseUrl.replace(/\/+$/, "");
  let nextSlot = 0;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function log(method: string, path: string, status: number | null, started: number, error: string | null, dry: boolean) {
    if (!sql) return;
    try {
      await sql`insert into api_calls (service, method, path, status, duration_ms, error, dry_run)
        values ('hypertide', ${method}, ${path}, ${status}, ${Date.now() - started}, ${error}, ${dry})`;
    } catch { /* logging must never break a job */ }
  }

  async function call(method: "GET" | "POST", path: string, body?: unknown, opts: { sideEffect?: boolean } = {}): Promise<Json> {
    const dry = Boolean(opts.sideEffect && dryRun);
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      // Spaced out to stay under the tightest per-minute limits (20-30/min).
      const now = Date.now();
      if (now < nextSlot) await wait(nextSlot - now);
      nextSlot = Math.max(now, nextSlot) + minSpacingMs;

      let res: Response;
      try {
        res = await fetchImpl(`${root}${path}`, {
          method,
          headers: {
            "x-api-key": apiKey,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...(dry ? { "x-dry-run": "true" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        if (attempt < 2) { await wait(2000 * 2 ** attempt); continue; }
        const msg = e instanceof Error ? e.message : String(e);
        await log(method, path, null, started, msg, dry);
        throw new HypertideError(`Hypertide unreachable: ${msg}`, null, null);
      }
      let json: Json = {};
      try { json = obj(await res.json()); } catch { /* non-JSON error page */ }
      if (res.status === 429 && attempt < 3) {
        const after = Number(json.retryAfter ?? res.headers.get("retry-after"));
        await wait(Number.isFinite(after) && after > 0 ? after * 1000 : 15_000);
        continue;
      }
      if (res.status >= 500 && attempt < 2 && !opts.sideEffect) { await wait(3000 * 2 ** attempt); continue; }
      if (!res.ok || json.success === false) {
        const code = typeof json.error === "string" ? json.error : null;
        const msg = describe(json, res.statusText || "request failed");
        await log(method, path, res.status, started, `${code ?? ""} ${msg}`.trim().slice(0, 1000), dry);
        throw new HypertideError(`Hypertide ${path} failed${code ? ` (${code})` : ""}: ${msg}`, code, res.status);
      }
      await log(method, path, res.status, started, null, dry);
      return { ...json, dryRun: dry };
    }
  }

  return {
    dryRun,
    health: () => call("GET", "/health"),

    /** Reserves (or returns the already reserved) Cloudflare pair per domain. */
    async previewNameservers(domains: string[]) {
      const r = await call("POST", "/domains/nameservers/preview", { domains });
      return readNameservers(r.data);
    },

    /** Places one unpaid order. In dry-run Hypertide only validates it. */
    async createOrder(payload: Json) {
      const r = await call("POST", "/orders", payload, { sideEffect: true });
      const data = obj(r.data);
      const first = obj(Array.isArray(data.orders) ? data.orders[0] : null);
      return {
        dryRun: Boolean(r.dryRun),
        recordId: typeof first.id === "string" ? first.id : null,
        nameservers: readNameservers(data),
        message: typeof r.message === "string" ? r.message : null,
      };
    },

    /** Charges the saved card for unpaid orders. Only ever called on a person's approval. */
    async charge(recordIds: string[], description?: string) {
      const r = await call("POST", "/payments/charge", { recordIds, ...(description ? { description } : {}) }, { sideEffect: true });
      return { dryRun: Boolean(r.dryRun), message: typeof r.message === "string" ? r.message : null };
    },

    /** After payment and the registrar change: checks NS and prepares the zone. */
    async verifyNameservers(recordIds: string[]): Promise<{ dryRun: boolean; results: NsResult[] }> {
      const r = await call("POST", "/orders/nameservers/verify", { recordIds }, { sideEffect: true });
      const data = obj(r.data);
      const results = (Array.isArray(data.results) ? data.results : []).map((x) => {
        const o = obj(x);
        return {
          domain: String(o.domain ?? "").toLowerCase(),
          verified: o.verified === true,
          message: typeof o.message === "string" ? o.message : typeof o.errorCode === "string" ? o.errorCode : null,
          expected: strs(o.expectedNameservers),
          current: strs(o.currentNameservers),
        };
      });
      return { dryRun: Boolean(r.dryRun), results };
    },

    /**
     * Queues one replacement of a domain we own. Hypertide answers 202 with
     * the operation and the new domain's nameservers; identical submissions
     * reuse the same operation. Test calls are refused by Hypertide, so in
     * dry-run nothing is sent.
     */
    async submitReplacement(input: ReplacementInput) {
      if (dryRun) return { dryRun: true as const, ...readReplacement({}, input.newDomain), raw: "" };
      const body = {
        originalDomain: input.originalDomain,
        newDomain: input.newDomain,
        replacementSource: "owned",
        copyTagsAndWarmup: input.copyTagsAndWarmup,
        ...(input.usernames?.length ? { updateUsernames: true, usernames: input.usernames } : {}),
      };
      const r = await call("POST", "/replacements", body);
      return { dryRun: false as const, ...readReplacement(r, input.newDomain), raw: JSON.stringify(r).slice(0, 4000) };
    },

    /** Status of one replacement operation. */
    async replacementStatus(operationId: string, newDomain: string) {
      const r = await call("GET", `/replacements/${encodeURIComponent(operationId)}`);
      return { ...readReplacement(r, newDomain), raw: JSON.stringify(r).slice(0, 4000) };
    },

    /** Paid orders on the account. */
    activeOrders: async () => readOrders(await call("GET", "/orders/active")),

    /** Placed but not yet charged. */
    pendingOrders: async () => readOrders(await call("GET", "/orders/pending")),
  };
}

const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** Orders from GET /orders/active or /orders/pending. */
export function readOrders(json: unknown): OrderStatus[] {
  const list = obj(json).orders;
  return (Array.isArray(list) ? list : [])
    .map((x) => {
      const o = obj(x);
      return {
        id: String(o.id ?? ""),
        domain: String(o.domain ?? "").trim().toLowerCase(),
        status: str(o.status),
        paymentStatus: str(o.paymentStatus),
        subscriptionId: str(o.subscriptionId),
        forwardingDomain: str(o.forwardingDomain),
        sendingTool: str(o.sendingTool),
        organizationName: str(o.organizationName),
        createdAt: str(o.createdAt),
      };
    })
    .filter((o) => o.id && o.domain);
}

export type Hypertide = ReturnType<typeof createHypertide>;

export type ReplacementInput = {
  originalDomain: string;
  newDomain: string;
  copyTagsAndWarmup: boolean;
  usernames?: { firstName: string; lastName: string }[];
};

export type ReplacementState = {
  operationId: string | null;
  status: string | null;          // queued, pending, awaiting_payment, completed, expired, failed…
  pending: boolean | null;
  requiresPayment: boolean;
  nameservers: string[];
  error: string | null;
};

const NS_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
// A nameserver list in whichever shape Hypertide sends it: ["a","b"],
// { ns: [...] }, { nameservers: [...] } or { assignment: { ns: [...] } }.
function nsList(v: unknown): string[] {
  if (Array.isArray(v)) {
    const list = v.map((x) => (typeof x === "string" ? x.trim().toLowerCase().replace(/\.$/, "") : "")).filter((x) => NS_RE.test(x));
    return list.length === v.length ? list : [];
  }
  if (!v || typeof v !== "object") return [];
  const o = obj(v);
  for (const k of ["ns", "nameservers", "assignment", "assignedNameservers"]) {
    const found = nsList(o[k]);
    if (found.length) return found;
  }
  return [];
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Reads a /replacements answer (submit or progress). The fields are taken
 * loosely, since only the request side is documented in detail: the
 * operation can sit at the top, in data, or in data.results[] next to the
 * entry for our new domain.
 */
export function readReplacement(json: unknown, newDomain: string): ReplacementState {
  const root = obj(json);
  const data = Array.isArray(root.data) ? obj(root.data[0]) : obj(root.data);
  const results = [data.results, root.results].find(Array.isArray) as unknown[] | undefined;
  const want = newDomain.toLowerCase();
  const entries = (results ?? []).map(obj);
  const mine = entries.find((e) => [e.newDomain, e.domain, e.new_domain].some((d) => typeof d === "string" && d.toLowerCase() === want)) ?? entries[0] ?? {};
  const pick = <T>(f: (o: Json) => T | null) => f(mine) ?? f(data) ?? f(root);

  const status = pick((o) => text(o.status) ?? text(o.state));
  const pendingRaw = pick((o) => (typeof o.pending === "boolean" ? o.pending : null));
  const err = pick((o) => text(o.error) ?? text(o.errorMessage) ?? text(o.reason) ?? (o.success === false ? text(o.message) : null));
  return {
    operationId: pick((o) => text(o.operationId) ?? text(o.operation_id)),
    status: status ? status.toLowerCase() : null,
    pending: pendingRaw,
    requiresPayment: pick((o) => (o.requiresPayment === true ? true : null)) ?? false,
    nameservers: [nsList(mine), nsList(data.nameservers), readNameservers(data).get(want) ?? []].find((l) => l.length) ?? [],
    error: err,
  };
}

/** Hypertide refuses customer-owned domains with hyphens or over 35 characters. */
export function hypertideAcceptsDomain(name: string) {
  return name.length <= 35 && !name.split(".")[0].includes("-") && /^[a-z0-9.]+$/.test(name);
}

export type OrderTemplate = { plan: "entra" | "google"; inbox_quantity: 25 | 50; forwarding_domain: string; client_name: string };
export type SmartleadCredentials = { api_key: string; username: string; password: string; oauth_link?: string };

/**
 * One order for a replacement domain: the template's plan and inbox count,
 * the old domain's sender names as users and its Smartlead warmup and limits.
 * Returns the reasons it can't be built yet instead of throwing.
 */
export function buildOrderPayload(input: {
  template: OrderTemplate;
  domain: string;
  clientName: string | null;
  senders: string[];
  warmup: { perDay: number | null; rampup: number | null; dailyLimit: number | null };
  credentials: Partial<SmartleadCredentials>;
}): { ok: true; payload: Json } | { ok: false; problems: string[] } {
  const { template: t, domain, credentials: c } = input;
  const problems: string[] = [];
  if (!hypertideAcceptsDomain(domain)) problems.push(`Hypertide doesn't accept ${domain} (no hyphens, 35 characters at most)`);
  if (!t.forwarding_domain.trim()) problems.push("Set the forwarding domain in Settings → Hypertide orders");
  const clientName = (input.clientName ?? t.client_name).trim();
  if (!clientName) problems.push("Give the domain a client, or set a default client name in Settings → Hypertide orders");
  if (!c.api_key || !c.username || !c.password) problems.push("Add the Smartlead login for Hypertide on the server (HYPERTIDE_SMARTLEAD_USERNAME / _PASSWORD)");
  if (t.plan === "entra" && !c.oauth_link?.startsWith("https://login.microsoftonline.com")) {
    problems.push("Add the Smartlead Microsoft OAuth link on the server (HYPERTIDE_SMARTLEAD_OAUTH_LINK)");
  }

  const users = [...new Set(input.senders.map((s) => s.trim()).filter(Boolean))]
    .map((name) => {
      const [first, ...rest] = name.split(/\s+/);
      return { first_name: first, last_name: rest.join(" ") || first };
    });
  if (!users.length) problems.push("No sender names known for the old domain; add inboxes with sender names first");
  if (problems.length) return { ok: false, problems };

  const inboxCount = t.inbox_quantity + 2;
  const payload: Json = {
    plan: t.plan,
    domain_option: "i_have_my_own_domains",
    domains: [domain],
    forwarding_domain: t.forwarding_domain.trim(),
    client_name: clientName,
    selected_tool: "smartlead",
    tool_credentials: {
      api_key: c.api_key,
      username: c.username,
      password: c.password,
      ...(t.plan === "entra" ? { oauth_link: c.oauth_link } : {}),
    },
    users: t.plan === "google" ? users.slice(0, 1) : users.slice(0, inboxCount),
    ...(t.plan === "entra" ? { inbox_quantity: t.inbox_quantity } : {}),
  };
  const w = input.warmup;
  if (w.perDay != null || w.rampup != null) {
    payload.warmup_setup = {
      disabled: false,
      settings: {
        ...(w.perDay != null ? { max_warmup_emails_per_day: w.perDay } : {}),
        ...(w.rampup != null ? { ramp_up_value: w.rampup } : {}),
      },
    };
  }
  if (w.dailyLimit != null) payload.sending_settings = { max_email_per_day: w.dailyLimit };
  return { ok: true, payload };
}
