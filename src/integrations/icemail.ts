import type postgres from "postgres";
import { createHttp, isoDate, validDomain } from "./http";

// Icemail API (https://docs.icemail.ai): one workspace per API key, sent in
// the x-api-key header. Lists page with page/limit (50 at most) and answer
// { success, data: { domains | mailboxes, total_count } }. Every endpoint
// allows 30 requests a minute, so calls are spaced two seconds apart.
// The mailbox list and the order reply carry each mailbox's password in plain
// text: only the fields below are kept, the password never leaves this file.
// Writes (orders, deletions) are skipped in dry run, which is the default.

type Options = { apiKey: string; baseUrl?: string; sql?: postgres.Sql; fetchImpl?: typeof fetch; minSpacingMs?: number; dryRun?: boolean };

export type IcemailDomain = {
  id: string;
  name: string;
  status: string | null;
  active: boolean | null;
  imported: boolean | null;
  prewarmed: boolean | null;
  blacklisted: boolean | null;
  spf: boolean | null;
  dkim: boolean | null;
  dmarc: boolean | null;
  mx: boolean | null;
  provider: string | null;
  mailboxCount: number | null;
  createdOn: string | null;
  expiresOn: string | null;
};

export type IcemailMailbox = {
  id: string;
  email: string;
  domainId: string | null;
  domain: string | null;
  firstName: string | null;
  lastName: string | null;
  provider: string | null;
  status: string | null;
  active: boolean | null;
  masterInbox: boolean | null;
  cost: number | null;
  billingCycle: string | null;
  nextBillingOn: string | null;
  createdOn: string | null;
};

export type IcemailWallet = { balance: number | null; currency: string | null; autoTopup: boolean | null };
export type IcemailPrices = { google: number | null; microsoft: number | null };

/** One inbox to create: the address must be on the order's domain. */
export type IcemailNewMailbox = { first_name: string; last_name: string; username: string };
/** What Icemail answered for one domain of an order; null in dry run. */
export type IcemailOrderResult = { orderId: string | null; domainId: string | null; mailboxIds: string[] };
/** Per domain: the inboxes it will delete (or deleted), skipped when it had none live, or why it failed. */
export type IcemailDeletion = { domainId: string; mailboxIds: string[]; skipped: boolean; error: string | null };

const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const day = (v: unknown) => isoDate(v)?.toISOString().slice(0, 10) ?? null;

export function parseIcemailDomain(raw: unknown): IcemailDomain | null {
  const d = obj(raw);
  const id = str(d.domain_id) ?? str(d.id);
  const name = validDomain(d.domain);
  if (!id || !name) return null;
  return {
    id, name,
    status: str(d.status),
    active: bool(d.active),
    imported: bool(d.import),
    prewarmed: bool(d.prewarmed),
    blacklisted: bool(d.blacklisted),
    spf: bool(d.spf),
    dkim: bool(d.dkim),
    dmarc: bool(d.dmarc),
    mx: bool(d.mx_records),
    provider: str(d.workspace_type),
    mailboxCount: num(d.mailbox_count),
    createdOn: day(d.created_at),
    expiresOn: day(d.expires_at),
  };
}

export function parseIcemailMailbox(raw: unknown): IcemailMailbox | null {
  const m = obj(raw);
  const id = str(m.id);
  const email = str(m.username)?.toLowerCase() ?? null;
  if (!id || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
  const dom = obj(m.domains);
  return {
    id, email,
    domainId: str(dom.domain_id),
    domain: validDomain(dom.domain) ?? validDomain(email.split("@")[1]),
    firstName: str(m.first_name),
    lastName: str(m.last_name),
    provider: str(m.type),
    status: str(m.status),
    active: bool(m.active),
    masterInbox: bool(m.master_inbox),
    cost: num(m.cost),
    billingCycle: str(m.billing_cycle),
    nextBillingOn: day(m.next_billing_date),
    createdOn: day(m.created_at),
  };
}

/** Icemail's reply to an order: ids only, never the passwords it echoes back. */
/** A reply's field names and value types, never its values: safe to log. */
export function shapeOf(v: unknown, depth = 0): unknown {
  if (depth > 4) return typeof v;
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).slice(0, 30).map(([k, x]) => [k, shapeOf(x, depth + 1)]));
  return v === null ? "null" : typeof v;
}

/**
 * The wallet from a /wallet reply. The docs put it at data.balance, but the
 * live reply doesn't match them, so it also looks under data.wallet, a list,
 * the top level, and the usual other names for a balance.
 */
export function parseIcemailWallet(raw: unknown): IcemailWallet {
  const top = obj(raw);
  const data = Array.isArray(top.data) ? obj(top.data[0]) : obj(top.data);
  const places = [data, obj(data.wallet), obj(top.wallet), top].filter((p) => Object.keys(p).length);
  for (const p of places) {
    const b = p.balance;
    const nested = obj(b);
    const cents = num(p.balance_cents) ?? num(p.balance_in_cents);
    const balance = num(b) ?? num(nested.amount) ?? num(nested.value) ?? num(p.available_balance) ?? num(p.current_balance)
      ?? num(p.wallet_balance) ?? num(p.credits) ?? num(p.credit) ?? num(p.amount) ?? (cents == null ? null : cents / 100);
    if (balance == null) continue;
    const auto = p.auto_topup ?? p.autoTopup ?? p.auto_top_up;
    return {
      balance,
      currency: str(p.currency) ?? str(nested.currency),
      autoTopup: bool(auto) ?? bool(obj(auto).enabled) ?? bool(p.auto_topup_enabled),
    };
  }
  return { balance: null, currency: null, autoTopup: null };
}

export function parseIcemailOrder(raw: unknown, domainName: string): IcemailOrderResult {
  const list = Array.isArray(raw) ? raw : [raw];
  const entry = obj(list.find((x) => validDomain(obj(x).domain_name) === domainName) ?? list[0]);
  const boxes = Array.isArray(entry.mailboxes) ? entry.mailboxes : [];
  return {
    orderId: str(entry.order_id),
    domainId: str(entry.domain_id),
    mailboxIds: boxes.map((b) => str(obj(b).mailbox_id) ?? str(obj(b).id)).filter((x): x is string => Boolean(x)),
  };
}

export function parseIcemailDeletion(raw: unknown): IcemailDeletion[] {
  const per = obj(raw).per_domain;
  return (Array.isArray(per) ? per : []).map((x) => {
    const d = obj(x);
    return {
      domainId: str(d.domain_id) ?? "",
      mailboxIds: Array.isArray(d.mailbox_ids) ? d.mailbox_ids.map(str).filter((v): v is string => Boolean(v)) : [],
      skipped: d.skipped === true,
      error: str(d.error),
    };
  }).filter((d) => d.domainId);
}

export function createIcemail({ apiKey, baseUrl = "https://app.icemail.ai/api/v1", sql, fetchImpl, minSpacingMs = 2100, dryRun = true }: Options) {
  const http = createHttp({ service: "icemail", baseUrl, sql, dryRun, fetchImpl, minSpacingMs });
  const headers = { "x-api-key": apiKey };
  const failed = (json: Record<string, unknown>) => (json.success === false ? str(json.message) ?? "Icemail said the request failed" : null);
  const get = <T>(path: string) => http.request<{ data?: T }>({ path, headers }, failed).then((r) => r?.data ?? null);
  /** A write: null without calling Icemail in dry run. */
  const write = (method: "POST" | "PUT" | "DELETE", path: string, body: unknown) =>
    http.request<{ data?: unknown }>({ method, path, headers, body, write: true }, failed);

  async function listAll<T>(path: string, key: string, parse: (raw: unknown) => T | null) {
    const out: T[] = [];
    for (let page = 1; page <= 2000; page++) {
      const data = obj(await get<unknown>(`${path}?page=${page}&limit=50`));
      const list = Array.isArray(data[key]) ? (data[key] as unknown[]) : [];
      for (const raw of list) {
        const x = parse(raw);
        if (x) out.push(x);
      }
      const total = num(data.total_count);
      if (list.length < 50 || (total != null && page * 50 >= total)) break;
    }
    return out;
  }

  return {
    /** The workspace this key belongs to; also the key test. */
    async workspace() {
      const list = await get<unknown[]>("/workspace");
      const w = obj(Array.isArray(list) ? list[0] : list);
      return { id: str(w.id), name: str(w.name) };
    },
    dryRun,
    async wallet(): Promise<IcemailWallet> {
      const raw = await http.request<unknown>({ path: "/wallet", headers }, failed);
      const w = parseIcemailWallet(raw);
      // No balance where we look: keep the reply's shape (names and types only) in the API log.
      if (w.balance == null) await http.note("GET", "/wallet", `No balance found in the reply. Its shape: ${JSON.stringify(shapeOf(raw))}`);
      return w;
    },
    /** What one inbox costs a month, in US dollars. */
    async prices(): Promise<IcemailPrices> {
      const direct = obj(obj(await get<unknown>("/mailbox/price")).direct);
      return { google: num(direct.GOOGLE), microsoft: num(direct.MICROSOFT) };
    },
    /**
     * Inboxes on one domain the workspace doesn't pay a domain for: one already
     * connected, or one imported with its nameservers at Icemail's ClouDNS.
     * Every inbox for a domain goes in the one request, as Icemail asks; no
     * password is sent, so Icemail makes its own. Null in dry run.
     */
    async orderMailboxes(domainName: string, provider: "GOOGLE" | "MICROSOFT", mailboxes: IcemailNewMailbox[]): Promise<IcemailOrderResult | null> {
      const r = await write("POST", "/order", {
        import: true,
        data: [{ domain_name: domainName, mailbox_type: provider, mailboxes: mailboxes.map(({ first_name, last_name, username }) => ({ first_name, last_name, username })) }],
      });
      return r ? parseIcemailOrder(r.data, domainName) : null;
    },
    /** Deletes every inbox on these domains at their next billing date; they keep working until then. Null in dry run. */
    async scheduleDeletion(domainIds: string[]): Promise<IcemailDeletion[] | null> {
      const r = await write("DELETE", "/domain/mailboxes", { domain_ids: domainIds, mode: "scheduled" });
      return r ? parseIcemailDeletion(r.data) : null;
    },
    /** Takes back a scheduled deletion, while its date is still ahead. Null in dry run. */
    async cancelScheduledDeletion(domainIds: string[]): Promise<{ ok: string[]; failed: string[] } | null> {
      const r = await write("POST", "/domain/mailboxes/cancel-scheduled-deletion", { domain_ids: domainIds });
      if (!r) return null;
      const d = obj(r.data);
      const ids = (v: unknown) => (Array.isArray(v) ? v.map(str).filter((x): x is string => Boolean(x)) : []);
      return { ok: ids(d.success_domain_ids), failed: ids(d.failed_domain_ids) };
    },
    listDomains: () => listAll("/domain", "domains", parseIcemailDomain),
    listMailboxes: () => listAll("/mailbox", "mailboxes", parseIcemailMailbox),
  };
}

export type Icemail = ReturnType<typeof createIcemail>;
