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

  /**
   * `once` is for a call that creates something new each time: after a network
   * error or a 5xx Smartlead may already have made it, so it isn't sent again
   * (a 429 means it was refused, and is retried).
   */
  async function request<T = unknown>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, opts: { query?: Query; body?: unknown; once?: boolean } = {}): Promise<T> {
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
        if (attempt < 3 && !opts.once) { await wait(1000 * 2 ** attempt); continue; }
        const msg = e instanceof Error ? e.message : String(e);
        await log(method, shownPath, null, started, msg);
        throw new SmartleadError(`Smartlead unreachable: ${msg}`, null, path);
      }

      if ((res.status === 429 || (res.status >= 500 && !opts.once)) && attempt < 4) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 1000 * 2 ** attempt);
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

    /** One page of master-inbox replies Smartlead couldn't tie to a campaign lead, with their text. */
    untrackedReplies: (offset: number, limit = 50) =>
      request<unknown>("GET", "/master-inbox/untracked-replies", { query: { limit, offset, fetchAttachments: false, fetchBody: true } }),

    // Writes: logged but not sent while dry-run is on.
    updateWarmup: (accountId: number, w: { warmup_enabled: boolean; total_warmup_per_day?: number; daily_rampup?: number; reply_rate_percentage?: number }) =>
      request("POST", `/email-accounts/${accountId}/warmup`, { body: w }),
    /** Campaign sending settings. Both fields are always sent together so neither falls back to a default. */
    updateSending: (accountId: number, s: { max_email_per_day: number; time_to_wait_in_mins: number }) =>
      request("POST", `/email-accounts/${accountId}`, { body: s }),
    /**
     * Adds a Google inbox by its app password over SMTP/IMAP. Sent once: after a
     * network error or a 5xx Smartlead may already have added it. Null id when
     * the reply didn't name one; { dryRun } in dry run.
     */
    addGmailAccount: async (a: GmailAccount): Promise<{ dryRun: true } | { id: number | null }> => {
      const r = await request<unknown>("POST", "/email-accounts/save", {
        once: true,
        body: {
          id: null, type: "GMAIL",
          from_name: a.fromName, from_email: a.email, user_name: a.email, password: a.appPassword,
          smtp_host: "smtp.gmail.com", smtp_port: 587, imap_host: "imap.gmail.com", imap_port: 993,
          max_email_per_day: a.maxPerDay, time_to_wait_in_mins: a.waitMins,
          warmup_enabled: a.warmup.enabled, total_warmup_per_day: a.warmup.perDay, daily_rampup: a.warmup.rampup, reply_rate_percentage: a.warmup.replyRate,
          ...(a.clientId != null ? { client_id: a.clientId } : {}),
        },
      });
      if (r && typeof r === "object" && (r as { dryRun?: boolean }).dryRun) return { dryRun: true };
      // A refusal can come back as 200 with ok: false (a login Google turned down, say).
      const o = (r && typeof r === "object" ? r : {}) as { ok?: unknown; message?: unknown; error?: unknown };
      if (o.ok === false) throw new SmartleadError(`Smartlead refused it: ${String(o.message ?? o.error ?? "no reason given").slice(0, 300)}`, 200, "/email-accounts/save");
      return { id: savedAccountId(r) };
    },
    addAccountsToCampaign: (campaignId: number, accountIds: number[]) =>
      request("POST", `/campaigns/${campaignId}/email-accounts`, { body: { email_account_ids: accountIds } }),

    // Campaigns, for placement tests.
    /** One campaign, with its settings (track_settings, send_as_plain_text, unsubscribe_text…). */
    getCampaign: (campaignId: number) => request<unknown>("GET", `/campaigns/${campaignId}`),
    /** A campaign's steps, each with its subject and body (and variants). */
    campaignSequences: (campaignId: number) => request<unknown>("GET", `/campaigns/${campaignId}/sequences`).then(asArray),
    /** One page of a campaign's leads with when each was sent, replied and whether it bounced. */
    campaignStatistics: (campaignId: number, offset = 0, limit = 100) =>
      request<unknown>("GET", `/campaigns/${campaignId}/statistics`, { query: { offset, limit } }),
    createCampaign: (name: string) => request<unknown>("POST", "/campaigns/create", { body: { name }, once: true }),
    updateCampaignSettings: (campaignId: number, settings: Record<string, unknown>) =>
      request("POST", `/campaigns/${campaignId}/settings`, { body: settings }),
    updateCampaignSchedule: (campaignId: number, schedule: Record<string, unknown>) =>
      request("POST", `/campaigns/${campaignId}/schedule`, { body: schedule }),
    saveSequences: (campaignId: number, sequences: { seq_number: number; seq_delay_details: { delay_in_days: number }; subject: string; email_body: string }[]) =>
      request("POST", `/campaigns/${campaignId}/sequences`, { body: { sequences } }),
    /** Adds leads even when they are in another campaign; block and unsubscribe lists still apply. */
    addLeads: (campaignId: number, leads: { email: string; first_name?: string; last_name?: string; company_name?: string }[]) =>
      request<unknown>("POST", `/campaigns/${campaignId}/leads`, {
        body: {
          lead_list: leads,
          settings: { ignore_global_block_list: false, ignore_unsubscribe_list: false, ignore_duplicate_leads_in_other_campaign: true },
        },
      }),
    setCampaignStatus: (campaignId: number, status: "START" | "PAUSED" | "STOPPED") =>
      request("POST", `/campaigns/${campaignId}/status`, { body: { status } }),
  };
}

export type Smartlead = ReturnType<typeof createSmartlead>;

/** A Google inbox to add to Smartlead. The app password is only passed through. */
export type GmailAccount = {
  email: string; fromName: string; appPassword: string;
  maxPerDay: number; waitMins: number; clientId: number | null;
  warmup: { enabled: boolean; perDay: number; rampup: number; replyRate: number };
};

/** The new account's id in a save reply: { ok, data: { id } }, { emailAccountId }, { id }… */
export function savedAccountId(r: unknown): number | null {
  const o = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const top = o(r), data = o(top.data);
  for (const v of [data.id, data.email_account_id, data.emailAccountId, top.emailAccountId, top.email_account_id, top.id]) {
    const n = Number(v);
    if (v != null && Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

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
