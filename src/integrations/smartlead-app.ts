import type postgres from "postgres";

// Smartlead's app endpoints, used with a login token (SMARTLEAD_JWT) because
// the public API key can't reach them: re-check every domain's DNS
// configuration, reconnect inboxes whose login failed, and read a campaign's
// blacklist scan. Writes are logged but not sent while dry-run is on.

const BASE = "https://server.smartlead.ai";
const TAGS_URL = "https://sl-fe-v2.smartlead.ai/api/v1/tags";
const GQL_URL = "https://fe-gql.smartlead.ai/v1/graphql";
const TAG_COLORS = ["#B1FCFA", "#FCE1B1", "#FCEFB1", "#D7FCB1", "#B1DDFC", "#D6B1FC", "#FCB1D7", "#FCC4B1"];

export type SmartleadTag = { id: number; name: string; color: string };

/** The workspace tag list ({ data: [{ id, name, color }] }). */
export function readTags(json: unknown): SmartleadTag[] {
  const seen = new Set<number>();
  return arr(obj(json).data).map((t) => ({ id: Number(obj(t).id) || 0, name: String(obj(t).name ?? "").trim(), color: String(obj(t).color ?? "").trim() || "#B1FCFA" }))
    .filter((t) => t.id && t.name && !seen.has(t.id) && Boolean(seen.add(t.id)));
}

export class SmartleadAppError extends Error {
  constructor(message: string, public status: number | null) {
    super(message);
  }
}

export type BlacklistListing = { kind: "domain" | "ip"; list: string };
export type BlacklistEntry = { domain: string; ip: string | null; domainCount: number; ipCount: number; listings: BlacklistListing[] };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Why a token can't work, without revealing it. Null when it looks usable. */
export function jwtProblem(token: string, now = Date.now()): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return "The Smartlead token is incomplete: copy the whole value after \"Bearer \" from a Smartlead request.";
  try {
    const exp = (JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown }).exp;
    if (typeof exp === "number" && exp * 1000 < now) return `The Smartlead token expired on ${new Date(exp * 1000).toISOString().slice(0, 10)}. Copy a fresh one and save it again.`;
  } catch {
    return "The Smartlead token is damaged. Copy it again from a Smartlead request.";
  }
  return null;
}

/** When the token stops working, if it says. */
export function jwtExpiry(token: string): Date | null {
  try {
    const exp = (JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" ? new Date(exp * 1000) : null;
  } catch {
    return null;
  }
}

/** One campaign's blacklist scan (GET /api/email-campaigns/:id/black-list-domains). */
export function readBlacklist(json: unknown): BlacklistEntry[] {
  return arr(json).map((e) => {
    const d = obj(obj(e).domain), ip = obj(obj(e).ip), summary = obj(d.summary);
    const name = (l: unknown) => String(obj(l).name ?? obj(l).blacklist ?? obj(l).host ?? (typeof l === "string" ? l : "")).trim();
    const domainList = arr(d.blacklisted), ipList = arr(ip.blacklisted);
    return {
      domain: String(d.domain ?? "").trim().toLowerCase(),
      ip: ip.ip ? String(ip.ip) : summary.ip ? String(summary.ip) : null,
      domainCount: domainList.length,
      ipCount: ipList.length,
      listings: [
        ...domainList.map((l) => ({ kind: "domain" as const, list: name(l) })),
        ...ipList.map((l) => ({ kind: "ip" as const, list: name(l) })),
      ].filter((l) => l.list),
    };
  }).filter((e) => e.domain);
}

export function createSmartleadApp({ jwt, sql, dryRun = true, fetchImpl = fetch }: { jwt: string; sql?: postgres.Sql; dryRun?: boolean; fetchImpl?: typeof fetch }) {
  async function log(method: string, path: string, status: number | null, started: number, error: string | null, dry: boolean) {
    if (!sql) return;
    try {
      await sql`insert into api_calls (service, method, path, status, duration_ms, error, dry_run)
        values ('smartlead-app', ${method}, ${path}, ${status}, ${Date.now() - started}, ${error}, ${dry})`;
    } catch { /* logging must never break a job */ }
  }

  async function call(method: "GET" | "POST", path: string, write = false, body: unknown = {}): Promise<unknown> {
    const started = Date.now();
    if (write && dryRun) {
      await log(method, path, null, started, null, true);
      return { dryRun: true };
    }
    const problem = jwtProblem(jwt);
    if (problem) throw new SmartleadAppError(problem, null);
    const res = await fetchImpl(path.startsWith("https://") ? path : `${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      body: method === "POST" ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* plain text */ }
    if (!res.ok || obj(json).success === false) {
      const msg = res.status === 401 || res.status === 403
        ? "Smartlead rejected the token (it may have expired). Save a fresh SMARTLEAD_JWT."
        : String(obj(json).message ?? obj(json).error ?? text.slice(0, 200)) || res.statusText;
      await log(method, path, res.status, started, msg.slice(0, 1000), false);
      throw new SmartleadAppError(`Smartlead ${path} failed (HTTP ${res.status}): ${msg}`, res.status);
    }
    await log(method, path, res.status, started, null, false);
    return json;
  }

  return {
    dryRun,
    /** Smartlead re-checks SPF, DKIM and DMARC for every connected domain. */
    verifyDomains: () => call("POST", "/api/email-account/bulk-verify-domain-email-configurations", true),
    /** Smartlead retries the login of every inbox whose SMTP or IMAP failed. */
    reconnectFailed: () => call("POST", "/api/email-account/bulk-save-failed-email-accounts", true),
    blacklist: async (campaignId: number) => readBlacklist(await call("GET", `/api/email-campaigns/${campaignId}/black-list-domains`)),
    /** Every tag in the workspace (Smartlead's own UI reads them here). */
    tags: async () => readTags(await call("GET", `${TAGS_URL}?limit=500`)),
    /** Creates a workspace tag with a random pastel colour. */
    createTag: async (name: string): Promise<SmartleadTag | null> => {
      const color = TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)];
      const json = obj(await call("POST", GQL_URL, true, {
        operationName: "createTag",
        variables: { object: { name, color } },
        query: "mutation createTag($object: tags_insert_input!) { insert_tags_one(object: $object) { id name color } }",
      }));
      if ("dryRun" in json) return null;
      const errors = arr(json.errors);
      if (errors.length) throw new SmartleadAppError(String(obj(errors[0]).message ?? "Smartlead couldn't create the tag"), null);
      const t = obj(obj(json.data).insert_tags_one);
      return { id: Number(t.id), name: String(t.name ?? name), color: String(t.color ?? color) };
    },
    /**
     * Smartlead's bulk inbox config write, the one its own "Configure settings"
     * uses: tags (replaces them), outbound, warmup or the warmup on/off switch.
     * Sent in chunks of 250 inboxes.
     */
    bulkConfig: async (accountIds: number[], updateData: Record<string, unknown>) => {
      for (let i = 0; i < accountIds.length; i += 250) {
        await call("POST", "/api/email-account/bulk-update-email-account-config", true, {
          emailAccountIds: accountIds.slice(i, i + 250),
          updateData: { dailyReplyLimit: null, ...updateData },
          excludeEmailAccountIds: [],
        });
      }
      return accountIds.length;
    },
  };
}

export type SmartleadApp = ReturnType<typeof createSmartleadApp>;
