import type { Tone } from "./status";

// Why an email bounced, read from the bounce notice Smartlead forwards
// (Office 365, Gmail and generic SMTP wording). Shared by server and client.
// Spam and blocklist rejections are about the sending domain; no such address
// is about the list; sender and dns are our own setup (the tenant or mailbox,
// and the sending domain's DNS records).

export type BounceReason = "sender" | "dns" | "blocklist" | "spam" | "missing" | "restricted" | "policy" | "full" | "temporary" | "other";

export const BOUNCE_META: Record<BounceReason, { label: string; tone: Tone; hint: string }> = {
  sender: { label: "Tenant / mailbox", tone: "danger", hint: "Our side: the Microsoft tenant or mailbox is blocked, over its limit, or can't sign in. Fix before sending more" },
  dns: { label: "Sender DNS", tone: "danger", hint: "Our side: the sending domain's DNS is missing or broken (no MX/A records, SPF, DKIM or DMARC failing). Fix the records" },
  blocklist: { label: "Blocklist", tone: "danger", hint: "The sending domain or IP is on a block list (Spamhaus, Barracuda, Microsoft…): rest the domain" },
  spam: { label: "Spam rejection", tone: "warning", hint: "Rejected as spam or for reputation: the sending domain is being filtered" },
  missing: { label: "No such address", tone: "info", hint: "The address doesn't exist: a list quality problem, not the domain's" },
  restricted: { label: "Recipient rules", tone: "faint", hint: "A group, permission or forwarding rule on the recipient's side refused it: drop the address, the domain isn't at fault" },
  policy: { label: "Policy block", tone: "faint", hint: "The recipient company's filter refused it. One company is no signal; many companies is" },
  full: { label: "Mailbox full", tone: "faint", hint: "The recipient's mailbox is over quota" },
  temporary: { label: "Temporary", tone: "faint", hint: "Delayed or timed out; it may deliver on a retry" },
  other: { label: "Other", tone: "faint", hint: "Couldn't tell why from the bounce notice" },
};
export const BOUNCE_ORDER: BounceReason[] = ["sender", "dns", "blocklist", "spam", "missing", "restricted", "policy", "full", "temporary", "other"];
export const CAUSE_COLOR: Record<BounceReason, string> = {
  sender: "var(--danger-solid)", dns: "color-mix(in srgb, var(--danger-solid) 70%, var(--violet-solid))",
  blocklist: "color-mix(in srgb, var(--danger-solid) 65%, var(--warning-solid))", spam: "var(--warning-solid)",
  missing: "var(--info-solid)", restricted: "var(--line-strong)", policy: "color-mix(in srgb, var(--faint) 70%, transparent)",
  full: "var(--line-strong)", temporary: "var(--line)", other: "var(--line)",
};

// Status codes that mean one thing whatever words surround them. Generic ones
// (5.7.1 above all, used for spam, blocklists and policy alike) aren't here:
// their wording decides. Enhanced codes follow RFC 3463 plus Microsoft's and Google's own.
const CODES: [RegExp, BounceReason][] = [
  [/^[45]\.2\.2$/, "full"],
  [/^5\.7\.(705|700|750|708|233)$|^5\.1\.8$|^5\.4\.5$/, "sender"],
  [/^[45]\.7\.(2[3-7]|30|509|515)$|^5\.1\.7$/, "dns"],
  [/^5\.7\.(511|6[0-4]\d)$/, "blocklist"],
  [/^[45]\.7\.(28|367)$/, "spam"],
  [/^5\.7\.(129|13[1-4]|52[01])$/, "restricted"],
  [/^5\.1\.(0|1|2|3|6|10)$|^5\.2\.1$|^5\.4\.(1|4|310|312|316)$/, "missing"],
];

// Wording that settles it even when a code says otherwise: "550 5.1.0 sender rejected"
// isn't a bad address, and a sender domain nobody can find is our DNS whatever the code.
const PHRASES: [RegExp, BounceReason][] = [
  [/sender address rejected:? domain not found|domain of sender address[\s<>\[\]]*(does not exist|does not resolve)|sender domain not found|has no a, aaaa,? or mx|unresolvable\b.{0,80}\bfrom domain/i, "dns"],
  // The receiver says our mail carries no SPF, DKIM or DMARC, or failed its DMARC: our DNS, whatever the code (Outlook sends these as a bare 5.7.1).
  [/lacks\s+(spf|dkim|dmarc)|\bspf\s*\/\s*dkim\s*\/\s*dmarc\b|(rejected|refused|blocked)\s+(per|due to|by|because of)\s+(the\s+)?dmarc|dmarc\s+(policy|check)\s+fail/i, "dns"],
  [/sender address\s*(\[[^\]]*\]\s*)?blocked|blocked using/i, "blocklist"],
  // A content filter scored the message as spam. It lists the rules that fired, and names like URIBL_BLOCKED
  // (the filter couldn't ask a list, not that anything is on one) must not read as a block listing.
  [/spamassassin|content filter reject/i, "spam"],
  [/\bsender rejected\b|reject due to policy restrictions/i, "policy"],
  [/no mail-enabled subscriptions|mailbox is disabled|no mailbox by that name|has been suspended|no longer at\b|unable to receive email|account closed|domain\s+no longer available/i, "missing"],
  // Their mail goes round in circles, or a forward is broken: the recipient's own setup, nothing to do with the sender.
  [/hop count exceeded|mail loop|misconfigured forwarding address/i, "restricted"],
  // The server doesn't take mail for that address at all.
  [/relay access denied|authentication required to relay|please turn on smtp authentication|disabled recipient address/i, "missing"],
];

/**
 * The code in a notice: the enhanced status (5.1.1) when there is one, else the
 * three-digit reply (550). Reads the first one that's the server's own, not an
 * address, version or IP.
 */
export function bounceCode(text: string | null | undefined): string | null {
  const t = (text ?? "").replace(/\[[\d.:a-f]+\]/gi, " ");
  const enhanced = t.match(/(?<![\w.])([45]\.\d{1,3}\.\d{1,3})(?![\d.])/);
  if (enhanced) return enhanced[1];
  // A bare 450 in a sentence could be anything ("limit of 450 recipients"): only where a server would put it.
  const reply = t.match(/(?:^|[:;'"(#=]\s*|\b(?:error|code|smtp|reply|status)\s+)([45]\d\d)(?=[\s\-:,.]|$)/i);
  return reply ? reply[1] : null;
}

/**
 * Host names say nothing about why a mail bounced, but plenty of filters are
 * called something like mx.spamexperts.com or d123.barracudanetworks.com, so
 * "550 no such user" from them read as spam. Block list zones stay, they're the reason.
 */
const LIST_ZONE = /spamhaus|spamcop|sorbs|uceprotect|invaluement|mailspike|psbl|uribl|surbl|barracudacentral|dnsbl|\.rbl\./i;
function withoutHosts(t: string) {
  return t
    .replace(/[\w.+'-]+@[\w-]+(\.[\w-]+)+/g, " ")
    .replace(/\b(?:https?:\/\/)?[a-z0-9][\w-]*(\.[a-z0-9][\w-]*)+(?:\/[^\s)]*)?/gi, (h) => (/^\d+(\.\d+)*$/.test(h) || LIST_ZONE.test(h) ? h : " "));
}

// First match wins, so the specific causes come before the catch-alls (5.7.x).
const RULES: [BounceReason, RegExp][] = [
  ["full", /mailbox (is )?full|out of storage|over ?quota|quota exceeded|insufficient (system )?storage|exceeded (their|the) storage|\b[45]\.2\.2\b/i],
  ["sender", new RegExp([
    /tenant has exceeded|unregistered domain|traffic not accepted from this ip|\b5\.7\.(705|700|750|708|233)\b/,
    /outboundspam|bad outbound sender|restricted from sending|blocked from sending|sending (has been |is )?(disabled|suspended|blocked)|\b5\.1\.8\b/,
    /daily (user )?sending (limit|quota)|sending limit exceeded|submission ?quota ?exceeded|message rate limit exceeded|\b5\.4\.5\b/,
    /authentication (failed|unsuccessful)(?! temporarily)|username and password not accepted|basic authentication is disabled|invalid_grant/,
  ].map((r) => r.source).join("|"), "i")],
  // The receiver couldn't find or verify our domain in DNS (no MX/A records, SPF, DKIM or DMARC broken).
  ["dns", new RegExp([
    /\b(dmarc|dkim|spf)\b[^.\n]{0,40}(fail|reject|not pass|alignment)|sender is not authenticated|unauthenticated (email|mail|sender)|\b5\.7\.(2[3-7]|30|509)\b/,
    /has no a, aaaa,? or mx (dns )?records|(not|weren'?t) recognized as a valid sender|trusted location|spf validation error|misconfigured settings at|sender (address rejected: )?domain (does not exist|not found)|unknown sender domain/,
  ].map((r) => r.source).join("|"), "i")],
  ["blocklist", /spamhaus|spamcop|barracuda|\bsorbs\b|uceprotect|invaluement|mailspike|\bpsbl\b|uribl|surbl|\bdbl\d*\b|blocked using|dnsbl|\brbl\b|black ?list|block ?list|badmailfrom|banned sending ip|banned sender|\bs3150\b|\bs3140\b|\b5\.7\.(511|6[0-4]\d)\b/i],
  ["spam", /spam|unsolicited|junk|reputation|complaints|bulk (mail|sender)|phishing|content (rejected|filter)|\b[45]\.7\.(350|28|367)\b/i],
  ["restricted", /only accepts? (mail|messages) from|allowed senders list|don'?t have permission to send|isn'?t set up to receive messages|sender not allowed|couldn'?t be forwarded|group you tried to contact|permission to post|auto.?forward|restricted to internal|distribution list|\b5\.7\.(129|13[1-4]|52[01])\b/i],
  ["missing", /wasn'?t found|(couldn'?t|could not) be found|address not found|does(n'?t| not) exist|no such (user|recipient|mailbox)|user unknown|unknown (user|recipient)|recipient (address )?(not found|rejected)|address rejected|invalid (recipient|address|mailbox)|mailbox (not found|unavailable)|no longer with|account (that you tried to reach )?(has been |is )?(disabled|inactive)|domain (name )?not found|no mx|invalid mx|aren'?t set up correctly|nxdomain|\b5\.1\.(0|1|2|3|6|10)\b/i],
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
  const code = bounceCode(t);
  const words = withoutHosts(t);
  for (const [re, reason] of PHRASES) if (re.test(words)) return reason;
  if (code) for (const [re, reason] of CODES) if (re.test(code)) return reason;
  // A try-again code is temporary unless its words blame our reputation, as Gmail's 4.7.28 and Yahoo's TSS04 do.
  if (code && /^4/.test(code) && !/spam|unsolicited|reputation|complaints|block ?list|black ?list|dnsbl/i.test(words)) return "temporary";
  for (const [reason, re] of RULES) if (re.test(words)) return reason;
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
  // The server's own words: "Remote server returned…", or "Error: 554 5.7.1…" further down newer notices.
  const flat = html.replace(/\s+/g, " ");
  const remote = (flat.match(/Remote server returned an error.{0,300}/i)?.[0] ?? flat.match(/\bError:\s+[45]\d\d[\s-].{0,300}/)?.[0] ?? "").split(/ Message rejected by| Notification Details/)[0];
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
  const r = remote?.split(/ Message rejected by| Notification Details/)[0].replace(/^(?:remote server returned an error\s*(->|-&gt;)?|error:)\s*/i, "").replace(/\s+/g, " ").trim();
  if (r) return r.length > 160 ? `${r.slice(0, 157)}…` : r;
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const why = lines.find((l) => !/couldn'?t be delivered|delivery has failed|undeliverable|delivery status notification|^your message to/i.test(l)) ?? lines[0];
  return why ? (why.length > 160 ? `${why.slice(0, 157)}…` : why) : null;
}
