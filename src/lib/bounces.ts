import type { Tone } from "./status";

// Why an email bounced, read from the bounce notice Smartlead forwards
// (Office 365, Gmail and generic SMTP wording). Shared by server and client.

export type BounceReason = "missing" | "blocked" | "restricted" | "full" | "temporary" | "other";

export const BOUNCE_META: Record<BounceReason, { label: string; tone: Tone; hint: string }> = {
  missing: { label: "No such address", tone: "danger", hint: "The address doesn't exist: a list quality problem, not the domain's" },
  blocked: { label: "Blocked", tone: "warning", hint: "Rejected as spam, by policy or a sender block list: a sign the sending domain is being filtered" },
  restricted: { label: "Recipient rules", tone: "faint", hint: "A group, permission or forwarding rule on the recipient's side refused it: drop the address, the domain isn't at fault" },
  full: { label: "Mailbox full", tone: "faint", hint: "The recipient's mailbox is over quota" },
  temporary: { label: "Temporary", tone: "faint", hint: "Delayed or timed out; it may deliver on a retry" },
  other: { label: "Other", tone: "faint", hint: "Couldn't tell why from the bounce notice" },
};
export const BOUNCE_ORDER: BounceReason[] = ["missing", "blocked", "restricted", "full", "temporary", "other"];

const RULES: [BounceReason, RegExp][] = [
  ["full", /mailbox (is )?full|over ?quota|quota exceeded|insufficient (system )?storage|\b5\.2\.2\b/i],
  ["missing", /wasn'?t found|does(n'?t| not) exist|no such (user|recipient|mailbox)|user unknown|unknown (user|recipient)|recipient (address )?(not found|rejected)|address rejected|invalid (recipient|address|mailbox)|mailbox (not found|unavailable)|account (has been )?disabled|\b5\.1\.(1|10)\b/i],
  ["restricted", /only accepts messages from|allowed senders list|don'?t have permission to send|isn'?t set up to receive messages|sender not allowed|couldn'?t be forwarded/i],
  ["blocked", /block(ed|list)|blacklist|badmailfrom|spam|policy|reputation|not authori[sz]ed|access denied|rejected (by|due|for)|\b5\.7\.\d+\b/i],
  ["temporary", /temporar|try again|timed? ?out|deferred|greylist|\b4\.\d\.\d+\b/i],
];

export function bounceReason(text: string | null | undefined): BounceReason {
  if (!text) return "other";
  for (const [reason, re] of RULES) if (re.test(text)) return reason;
  return "other";
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
