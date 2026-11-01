import type postgres from "postgres";
import { createHttp, isoDate, validDomain } from "./http";

// Icemail API (https://docs.icemail.ai): one workspace per API key, sent in
// the x-api-key header. Lists page with page/limit (50 at most) and answer
// { success, data: { domains | mailboxes, total_count } }. Every endpoint
// allows 30 requests a minute, so calls are spaced two seconds apart.
// The mailbox list carries each mailbox's password in plain text: only the
// fields below are kept, the password never leaves this file.

type Options = { apiKey: string; baseUrl?: string; sql?: postgres.Sql; fetchImpl?: typeof fetch; minSpacingMs?: number };

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

export type IcemailWallet = { balance: number | null; currency: string | null };

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

/** What one mailbox costs a month: yearly plans are spread over twelve. */
export const monthlyCost = (cost: number | null, cycle: string | null) =>
  cost == null ? null : cycle === "YEARLY" ? cost / 12 : cost;

export function createIcemail({ apiKey, baseUrl = "https://app.icemail.ai/api/v1", sql, fetchImpl, minSpacingMs = 2100 }: Options) {
  // Read-only for now, so dry run never applies.
  const http = createHttp({ service: "icemail", baseUrl, sql, dryRun: false, fetchImpl, minSpacingMs });
  const headers = { "x-api-key": apiKey };
  const failed = (json: Record<string, unknown>) => (json.success === false ? str(json.message) ?? "Icemail said the request failed" : null);
  const get = <T>(path: string) => http.request<{ data?: T }>({ path, headers }, failed).then((r) => r?.data ?? null);

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
    async wallet(): Promise<IcemailWallet> {
      const w = obj(await get<unknown>("/wallet"));
      return { balance: num(w.balance), currency: str(w.currency) };
    },
    listDomains: () => listAll("/domain", "domains", parseIcemailDomain),
    listMailboxes: () => listAll("/mailbox", "mailboxes", parseIcemailMailbox),
  };
}

export type Icemail = ReturnType<typeof createIcemail>;
