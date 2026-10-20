import { createHash } from "node:crypto";
import { classifyReply, newText, type ReplyClass } from "./classify";

// Smartlead documents two webhook shapes (flat `event_type`/`from_email`, and
// nested `event`/`lead`/`reply`). This reads either into one event. For every
// event type `from_email` is our sending inbox and `to_email` the lead.

export type ParsedEvent = {
  kind: "sent" | "reply" | "bounce";
  dedupeKey: string;
  occurredAt: Date;
  inboxEmail: string | null;
  domainName: string | null;
  smartleadAccountId: number | null;
  leadEmail: string | null;
  campaignId: number | null;
  campaignName: string | null;
  smartleadClientId: number | null;
  sequenceNumber: number | null;
  subject: string | null;
  preview: string | null;
  replyClass: ReplyClass | null;
};

const KINDS: Record<string, ParsedEvent["kind"]> = {
  EMAIL_SENT: "sent",
  EMAIL_REPLY: "reply",
  EMAIL_REPLIED: "reply",
  EMAIL_BOUNCE: "bounce",
  EMAIL_BOUNCED: "bounce",
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (...vs: unknown[]) => {
  for (const v of vs) if (typeof v === "string" && v.trim()) return v.trim();
  return null;
};
const num = (...vs: unknown[]) => {
  for (const v of vs) {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
};
const email = (v: string | null) => {
  const m = v?.toLowerCase().match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  return m ? m[0] : null;
};
const date = (...vs: unknown[]) => {
  for (const v of vs) {
    if (v == null || v === "") continue;
    const d = new Date(typeof v === "number" && v < 1e12 ? v * 1000 : (v as string | number));
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
};

/** Returns null for events we don't track (opens, clicks, unsubscribes…). */
export function parseSmartleadEvent(payload: unknown, receivedAt = new Date()): ParsedEvent | null {
  const p = obj(payload);
  const type = str(p.event_type, p.event, p.type)?.toUpperCase().replace(/\s+/g, "_") ?? "";
  const kind = KINDS[type];
  if (!kind) return null;

  const reply = obj(p.reply_message ?? p.reply);
  const sent = obj(p.sent_message);
  const lead = obj(p.lead);
  const account = obj(p.email_account);

  const inboxEmail = email(str(p.from_email, account.email, account.from_email, p.sender_email));
  const leadEmail = email(str(p.to_email, lead.email, p.lead_email, p.sl_lead_email));
  const campaignId = num(p.campaign_id, p.email_campaign_id);
  const sequenceNumber = num(p.sequence_number, p.seq_number);

  const replyBody = str(reply.text, reply.body, reply.html, p.reply_body, p.reply_text);
  const subject = str(p.subject, reply.subject, sent.subject);
  const bounceText = str(p.bounce_reason, p.bounce_message, p.reason, p.description);
  const previewSource = kind === "reply" ? str(replyBody, p.preview_text) : kind === "bounce" ? str(bounceText, p.preview_text, replyBody) : null;
  const preview = previewSource ? newText(previewSource).slice(0, 2000) : null;

  const occurredAt =
    date(kind === "reply" ? (p.time_replied ?? reply.time ?? reply.received_at) : null, p.event_timestamp, p.timestamp, sent.time) ?? receivedAt;

  // Smartlead retries deliveries, so the same event must map to the same key.
  const messageId = str(reply.message_id, p.message_id, kind === "sent" ? sent.message_id : null);
  const statsId = str(p.stats_id, typeof p.stats_id === "number" ? String(p.stats_id) : null);
  const natural =
    kind === "reply" && messageId ? `reply:${messageId}` :
    statsId ? `${kind}:${statsId}:${sequenceNumber ?? ""}` :
    messageId ? `${kind}:${messageId}` : null;
  const dedupeKey =
    natural ??
    `${kind}:h:${createHash("sha256")
      .update(JSON.stringify([kind, inboxEmail, leadEmail, campaignId, sequenceNumber, occurredAt.toISOString(), preview?.slice(0, 200)]))
      .digest("hex")
      .slice(0, 32)}`;

  return {
    kind,
    dedupeKey,
    occurredAt,
    inboxEmail,
    domainName: inboxEmail ? inboxEmail.split("@")[1] : null,
    smartleadAccountId: num(p.email_account_id, account.id, p.sl_email_account_id),
    leadEmail,
    campaignId,
    campaignName: str(p.campaign_name),
    smartleadClientId: num(p.client_id),
    sequenceNumber,
    subject,
    preview,
    replyClass: kind === "reply" ? classifyReply(replyBody ?? str(p.preview_text), subject) : null,
  };
}
