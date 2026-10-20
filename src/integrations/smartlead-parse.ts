import { asArray } from "./smartlead";

// Reads Smartlead responses into the fields we store. Smartlead's field names
// vary between endpoints and versions, so every reader tries the known names
// and treats anything missing as unknown (null) rather than zero.

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const num = (...vs: unknown[]): number | null => {
  for (const v of vs) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim()) {
      const n = Number(v.replace(/[%,\s]/g, ""));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
};
const str = (...vs: unknown[]) => {
  for (const v of vs) if (typeof v === "string" && v.trim()) return v.trim();
  return null;
};

export type SmartleadAccount = {
  id: number;
  email: string;
  domain: string;
  senderName: string | null;
  clientId: number | null;
  dailyLimit: number | null;
  warmupEnabled: boolean | null;
  warmupPerDay: number | null;
  warmupRampup: number | null;
  warmupReputation: number | null;
  connected: boolean;
};

export function parseAccount(raw: unknown): SmartleadAccount | null {
  const a = obj(raw);
  const w = obj(a.warmup_details);
  const id = num(a.id);
  const email = str(a.from_email, a.email, a.username)?.toLowerCase();
  if (id == null || !email || !email.includes("@")) return null;

  const warmupStatus = str(w.status, a.warmup_status)?.toUpperCase();
  const warmupEnabled =
    typeof a.warmup_enabled === "boolean" ? a.warmup_enabled :
    warmupStatus ? warmupStatus === "ACTIVE" || warmupStatus === "ENABLED" : null;

  const smtpOk = a.is_smtp_success !== false;
  const imapOk = a.is_imap_success !== false;

  return {
    id,
    email,
    domain: email.split("@")[1],
    senderName: str(a.from_name, a.name),
    clientId: num(a.client_id),
    dailyLimit: num(a.message_per_day, a.max_email_per_day, a.daily_limit),
    warmupEnabled,
    warmupPerDay: num(w.max_email_per_day, w.total_warmup_per_day, a.total_warmup_per_day, w.warmup_max_count),
    warmupRampup: num(w.daily_rampup, a.daily_rampup, w.rampup),
    warmupReputation: num(w.warmup_reputation, a.warmup_reputation, w.reputation),
    connected: smtpOk && imapOk,
  };
}

export type SmartleadCampaign = { id: number; name: string; status: string | null; clientId: number | null };

export function parseCampaign(raw: unknown): SmartleadCampaign | null {
  const c = obj(raw);
  const id = num(c.id);
  if (id == null) return null;
  return { id, name: str(c.name) ?? `Campaign ${id}`, status: str(c.status), clientId: num(c.client_id) };
}

export function parseClient(raw: unknown): { id: number; name: string } | null {
  const c = obj(raw);
  const id = num(c.id);
  const name = str(c.name, c.client_name);
  return id != null && name ? { id, name } : null;
}

export type DomainDay = { domain: string; sent: number; replies: number | null; bounces: number | null };

// The first array of objects, searched breadth-first a few levels deep, since
// Smartlead nests analytics lists under endpoint-specific keys.
function findRows(raw: unknown): unknown[] {
  let level: unknown[] = [raw];
  for (let depth = 0; depth < 4 && level.length; depth++) {
    const next: unknown[] = [];
    for (const v of level) {
      if (Array.isArray(v)) {
        if (v.some((x) => x && typeof x === "object" && !Array.isArray(x))) return v;
      } else if (v && typeof v === "object") {
        next.push(...Object.values(v));
      }
    }
    level = next;
  }
  return asArray(raw);
}

// Domain-wise health rows: whichever array holds objects with a domain field.
export function parseDomainHealth(raw: unknown): { rows: DomainDay[]; recognised: boolean } {
  const rows = findRows(raw);
  const out: DomainDay[] = [];
  for (const r of rows) {
    const o = obj(r);
    const domain = str(o.domain, o.domain_name, o.mailbox_domain, o.email_domain, o.name)?.toLowerCase().replace(/^@/, "");
    const sent = num(o.sent_count, o.sent, o.total_sent, o.emails_sent, o.total_sent_count);
    if (!domain || !domain.includes(".") || sent == null) continue;
    out.push({
      domain,
      sent,
      replies: num(o.reply_count, o.replied, o.replies, o.total_replied),
      bounces: num(o.bounce_count, o.bounced, o.bounces, o.total_bounced),
    });
  }
  return { rows: out, recognised: rows.length === 0 || out.length > 0 };
}
