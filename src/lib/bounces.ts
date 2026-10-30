import type { Tone } from "./status";

// Why an email bounced, read from the bounce notice Smartlead forwards
// (Office 365, Gmail and generic SMTP wording). Shared by server and client.
// Spam and blocklist rejections are about the sending domain; no such address
// is about the list; sender is our own setup (tenant, mailbox, DNS).

export type BounceReason = "sender" | "blocklist" | "spam" | "missing" | "restricted" | "policy" | "full" | "temporary" | "other";

export const BOUNCE_META: Record<BounceReason, { label: string; tone: Tone; hint: string }> = {
  sender: { label: "Sender setup", tone: "danger", hint: "Our side: the Microsoft tenant or mailbox is blocked, over its limit, or failing SPF/DKIM/DMARC. Fix before sending more" },
  blocklist: { label: "Blocklist", tone: "danger", hint: "The sending domain or IP is on a block list (Spamhaus, Barracuda, Microsoft…): rest the domain" },
  spam: { label: "Spam rejection", tone: "warning", hint: "Rejected as spam or for reputation: the sending domain is being filtered" },
  missing: { label: "No such address", tone: "info", hint: "The address doesn't exist: a list quality problem, not the domain's" },
  restricted: { label: "Recipient rules", tone: "faint", hint: "A group, permission or forwarding rule on the recipient's side refused it: drop the address, the domain isn't at fault" },
  policy: { label: "Policy block", tone: "faint", hint: "The recipient company's filter refused it. One company is no signal; many companies is" },
  full: { label: "Mailbox full", tone: "faint", hint: "The recipient's mailbox is over quota" },
  temporary: { label: "Temporary", tone: "faint", hint: "Delayed or timed out; it may deliver on a retry" },
  other: { label: "Other", tone: "faint", hint: "Couldn't tell why from the bounce notice" },
};
export const BOUNCE_ORDER: BounceReason[] = ["sender", "blocklist", "spam", "missing", "restricted", "policy", "full", "temporary", "other"];

// First match wins, so the specific causes come before the catch-alls (5.7.x).
const RULES: [BounceReason, RegExp][] = [
  ["full", /mailbox (is )?full|over ?quota|quota exceeded|insufficient (system )?storage|exceeded (their|the) storage|\b[45]\.2\.2\b/i],
  ["sender", new RegExp([
    /tenant has exceeded|unregistered domain|traffic not accepted from this ip|\b5\.7\.(705|700|750|708|233)\b/,
    /outboundspam|bad outbound sender|restricted from sending|blocked from sending|sending (has been |is )?(disabled|suspended|blocked)|\b5\.1\.8\b/,
    /daily (user )?sending (limit|quota)|sending limit exceeded|submission ?quota ?exceeded|message rate limit exceeded|\b5\.4\.5\b/,
    /\b(dmarc|dkim|spf)\b[^.\n]{0,40}(fail|reject|not pass|alignment)|sender is not authenticated|unauthenticated (email|mail|sender)|\b5\.7\.(2[3-7]|30|509)\b/,
    /authentication (failed|unsuccessful)(?! temporarily)|username and password not accepted|basic authentication is disabled|invalid_grant/,
    // The receiver couldn't find our domain in DNS (no MX/A records, SPF or DMARC broken).
    /has no a, aaaa,? or mx (dns )?records|(not|weren'?t) recognized as a valid sender|trusted location|spf validation error|misconfigured settings at|sender (address rejected: )?domain (does not exist|not found)|unknown sender domain/,
  ].map((r) => r.source).join("|"), "i")],
  ["blocklist", /spamhaus|spamcop|barracuda|\bsorbs\b|uceprotect|invaluement|mailspike|\bpsbl\b|uribl|surbl|\bdbl\d*\b|blocked using|dnsbl|\brbl\b|black ?list|block ?list|badmailfrom|banned sending ip|banned sender|\bs3150\b|\bs3140\b|\b5\.7\.(511|6[0-4]\d)\b/i],
  ["spam", /spam|unsolicited|junk|reputation|bulk (mail|sender)|phishing|content (rejected|filter)|\b[45]\.7\.(350|28|367)\b/i],
  ["restricted", /only accepts? (mail|messages) from|allowed senders list|don'?t have permission to send|isn'?t set up to receive messages|sender not allowed|couldn'?t be forwarded|group you tried to contact|permission to post|auto.?forward|restricted to internal|distribution list|\b5\.7\.(129|13[1-4]|52[01])\b/i],
  ["missing", /wasn'?t found|does(n'?t| not) exist|no such (user|recipient|mailbox)|user unknown|unknown (user|recipient)|recipient (address )?(not found|rejected)|address rejected|invalid (recipient|address|mailbox)|mailbox (not found|unavailable)|no longer with|account (that you tried to reach )?(has been |is )?(disabled|inactive)|domain (name )?not found|no mx|invalid mx|aren'?t set up correctly|nxdomain|\b5\.1\.(0|1|2|3|6|10)\b/i],
  ["policy", /block(ed)?\b|policy|administrative prohibition|access denied|not permitted|not authori[sz]ed|sender (denied|rejected)|refused|rejected (by|due|for)|\b5\.7\.\d+\b/i],
  ["temporary", /temporar|didn'?t respond|try again|timed? ?out|deferred|greylist|graylist|\b4\.\d\.\d+\b/i],
];

/** The notice without the quoted original message and its headers (which mention DKIM, SPF and antispam). */
export function trimNotice(text: string): string {
  const t = text.replace(/\r/g, "");
  const cut = t.search(/original message headers|-{2,}\s*original message|original message follows|^\s*received: |dkim-signature:|arc-seal:|^\s*return-path:|x-microsoft-antispam|authentication-results:/im);
  return cut >= 8 ? t.slice(0, cut) : t;
}

export function bounceReason(text: string | null | undefined, senderOriginated = false): BounceReason {
  const t = text ? trimNotice(text).trim() : "";
  if (!t) return senderOriginated ? "sender" : "other";
  for (const [reason, re] of RULES) if (re.test(t)) return reason;
  return "other";
}

/**
 * The text a stored webhook payload's bounce reads as: the receiving server's
 * own error (quoted only in the HTML of Office 365 notices) and the notice.
 */
export function bounceCauseOf(payload: unknown): BounceReason {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const msg = p.bounce_message;
  const m = (msg && typeof msg === "object" ? msg : {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const html = s(m.html).replace(/<[^>]+>/g, " ").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&nbsp;/g, " ");
  const remote = html.match(/Remote server returned an error.{0,300}/i)?.[0] ?? "";
  // Office 365 cuts the plain text short; the HTML has the whole notice.
  // Its help sections ("if the issue is related to an SPF failure…") are cut off.
  const htmlNotice = trimNotice(html).split(/how to fix it|more info for email admins/i)[0];
  const text = [s(m.text) || s(msg) || s(p.bounce_reason) || s(p.description), htmlNotice].join(" ");
  const flag = p.is_sender_originated_bounce === true || p.is_sender_originated_bounce === "true";
  return bounceReason(`${remote} ${text}`, flag);
}

/**
 * The line of the notice that says why, without the "couldn't be delivered"
 * preamble. The remote server's own error, when the notice quotes one, wins.
 */
export function bounceLine(text: string | null | undefined, remote?: string | null): string | null {
  const r = remote?.split(/ Message rejected by| Notification Details/)[0].replace(/^remote server returned an error\s*(->|-&gt;)?\s*/i, "").replace(/\s+/g, " ").trim();
  if (r) return r.length > 160 ? `${r.slice(0, 157)}…` : r;
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const why = lines.find((l) => !/couldn'?t be delivered|delivery has failed|undeliverable|delivery status notification|^your message to/i.test(l)) ?? lines[0];
  return why ? (why.length > 160 ? `${why.slice(0, 157)}…` : why) : null;
}
