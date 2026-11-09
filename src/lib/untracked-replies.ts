// Untracked replies: Smartlead master-inbox replies it couldn't tie to a
// campaign lead. Reading Smartlead's answer, shared by the job (src/jobs) and
// the page. Client-safe: no database here (see untracked-replies-db.ts).

export type UntrackedReply = {
  id: string;
  accountId: number | null;
  subject: string | null;
  senderName: string | null;
  senderEmail: string | null;
  recipientName: string | null;
  recipientEmail: string | null;
  body: string | null;
  /** ISO time it arrived, when Smartlead gives one. */
  receivedAt: string | null;
};

/** Longest body kept: a Google Sheets cell holds 50,000 characters. */
export const BODY_MAX = 20_000;

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * The replies in one page of Smartlead's answer. It has come back as
 * { data: { data: { replies } } }; plainer shapes are accepted too. Null when
 * there's no list of replies in it at all, so a change on Smartlead's side
 * fails loudly instead of reading as "no replies".
 */
export function repliesOf(page: unknown): unknown[] | null {
  if (Array.isArray(page)) return page;
  let at: unknown = page;
  for (let depth = 0; depth < 4 && isObj(at); depth++) {
    if (Array.isArray(at.replies)) return at.replies;
    at = at.data;
  }
  return Array.isArray(at) ? at : null;
}

/** "Jane Doe <jane@acme.com>", "<jane@acme.com>" or "jane@acme.com" → name and email. */
export function parseAddress(detail: unknown): { name: string | null; email: string | null } {
  if (typeof detail !== "string" || !detail.trim()) return { name: null, email: null };
  const m = detail.trim().match(/^(.*?)\s*<([^<>]+)>\s*$/);
  if (m) {
    const name = m[1].trim().replace(/^["']+|["']+$/g, "").trim();
    return { name: name || null, email: m[2].trim().toLowerCase() || null };
  }
  return { name: null, email: detail.trim().toLowerCase() };
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

/** Plain text from an HTML body, for when Smartlead sends no visible text. */
export function htmlToText(html: string) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    .trim();
}

function timeOf(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v !== "string" && typeof v !== "number") continue;
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

/** One reply from Smartlead, or null when it has no id. */
export function parseReply(raw: unknown): UntrackedReply | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id) ?? str(raw.message_id);
  if (!id) return null;
  const from = parseAddress(raw.sender_detail ?? raw.from);
  const to = parseAddress(raw.recipient_detail ?? raw.to);
  const account = Number(raw.account_id ?? raw.email_account_id);
  const html = str(raw.email_body) ?? str(raw.body);
  const body = str(raw.visible_text) ?? (html ? htmlToText(html) || null : null);
  return {
    id,
    accountId: Number.isFinite(account) && account > 0 ? account : null,
    subject: str(raw.subject),
    senderName: from.name,
    senderEmail: from.email,
    recipientName: to.name,
    recipientEmail: to.email,
    body: body ? body.slice(0, BODY_MAX) : null,
    receivedAt: timeOf(raw.created_at, raw.reply_picked_time, raw.time),
  };
}
