// Placement seeds (client-safe): which auto-replies make an address a seed,
// who handles a company's mail from its MX hosts, and what a seed can be used
// for. The job that collects them is src/jobs/placement-seeds.ts.

import { newText } from "./classify";

/** The person has left, or the mailbox is dead: nobody will read what we send. */
const LEFT = [
  /\bno longer (?:with|works? (?:at|for|with)|working (?:at|for|with)|employed|at|a part of|part of|affiliated|associated)\b/,
  /\b(?:is|am) longer (?:working|with)\b/,
  /\b(?:has|have) (?:now )?left (?:the |our )?(?:company|organi[sz]ation|firm|business|practice|team|agency|group)\b/,
  /\b(?:he|she|they|i) (?:has|have|'ve) (?:now )?(?:left|departed)\b(?! (?:a|you|it|this|my|your|the (?:message|voicemail|note))\b)|\bhas departed\b/,
  /\b(?:has|have|i've) (?:officially )?(?:retired|moved on)\b/,
  /\b(?:this )?(?:mailbox|inbox|e-?mail(?: account| address)?|address|account) (?:is|will be|has been) (?:no longer|not) (?:being )?(?:actively )?(?:monitored|active|in use|checked|read)\b/,
  /\b(?:not|no longer) (?:being )?(?:actively )?monitored\b/,
  /\baddress (?:is )?no longer (?:in use|active|valid)\b/,
];

/** "Won't be forwarded" and the like, taken out before looking for forwarding. */
const NOT_FORWARDED = /\b(?:not|won'?t|will not|isn'?t|is not|cannot|can'?t|never) (?:be )?(?:automatically )?(?:forwarded|redirected|monitored|read|reviewed|checked)\b/g;
/** The mail still reaches someone, so a person may read (or report) what we send. */
const FORWARDS = [
  /\b(?:is|are|will be|has been|have been|being|gets?|automatically) (?:automatically )?(?:forwarded|redirected|routed)\b/,
  /\b(?:forwarded|redirected|routed) to\b/,
  /\b(?:monitored|checked|reviewed|read|handled) by\b/,
  /\b(?:someone|a colleague|a member of (?:the|our) team|our team) will (?:respond|reply|get back|be in touch|review|follow up)\b/,
  /\b(?:my|her|his|their) new (?:e-?mail|address)\b|\bchanged (?:my|her|his|their) (?:primary |work )?e-?mail\b/,
];
/** Out of office, coming back: not gone. */
const COMING_BACK = /\b(?:i will be|i'll be|i am|i'm|we will be|we'll be) back\b|\breturn(?:ing)? (?:on|to the office|to work)\b/;

export type SeedReason = { forwards: boolean; excerpt: string };

/** Whether an auto-reply makes its sender a seed, and whether it says the mail is passed on. Null when it isn't one. */
export function seedReason(raw: string | null | undefined): SeedReason | null {
  if (!raw) return null;
  const text = newText(raw).replace(/\s+/g, " ").trim();
  const low = text.toLowerCase();
  const at = LEFT.map((r) => low.search(r)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (at === undefined || COMING_BACK.test(low)) return null;
  const rest = low.replace(NOT_FORWARDED, " ");
  // From the start of the sentence it's in, at most 80 characters back.
  const start = Math.max(text.lastIndexOf(".", at) + 1, at - 80, 0);
  return { forwards: FORWARDS.some((r) => r.test(rest)), excerpt: text.slice(start, start + 240).trim() };
}

export type MxProvider = "google" | "outlook" | "gateway" | "other" | "none";

const PROVIDERS: { re: RegExp; provider: MxProvider; name: string }[] = [
  { re: /(?:^|\.)(?:google|googlemail)\.com$/, provider: "google", name: "Google" },
  { re: /\.mail\.protection\.outlook\.com$|(?:^|\.)outlook\.com$|(?:^|\.)hotmail\.com$|\.mx\.microsoft$/, provider: "outlook", name: "Microsoft 365" },
  { re: /(?:^|\.)mimecast\.com$/, provider: "gateway", name: "Mimecast" },
  { re: /(?:^|\.)pphosted\.com$|(?:^|\.)ppe-hosted\.com$/, provider: "gateway", name: "Proofpoint" },
  { re: /(?:^|\.)barracudanetworks\.com$|(?:^|\.)cudamail\.com$/, provider: "gateway", name: "Barracuda" },
  { re: /(?:^|\.)messagelabs\.com$/, provider: "gateway", name: "Symantec" },
  { re: /(?:^|\.)iphmx\.com$/, provider: "gateway", name: "Cisco" },
  { re: /(?:^|\.)trendmicro\.(?:com|eu)$|(?:^|\.)tmes\./, provider: "gateway", name: "Trend Micro" },
  { re: /(?:^|\.)sophos\.com$/, provider: "gateway", name: "Sophos" },
  { re: /(?:^|\.)mailcontrol\.com$|(?:^|\.)forcepoint\.com$/, provider: "gateway", name: "Forcepoint" },
  { re: /(?:^|\.)antispamcloud\.com$|(?:^|\.)spamexperts\.\w+$/, provider: "gateway", name: "SpamExperts" },
  { re: /(?:^|\.)arsmtp\.com$|(?:^|\.)appriver\.com$/, provider: "gateway", name: "Zix" },
  { re: /(?:^|\.)zoho\.(?:com|eu|in)$/, provider: "other", name: "Zoho" },
  { re: /(?:^|\.)secureserver\.net$/, provider: "other", name: "GoDaddy" },
  { re: /(?:^|\.)yahoodns\.net$/, provider: "other", name: "Yahoo" },
];

/** Who receives mail for a domain, from its MX records (lowest preference first wins). */
export function mxProvider(records: { exchange: string; priority: number }[]): { provider: MxProvider; name: string | null; host: string | null } {
  const hosts = [...records].sort((a, b) => a.priority - b.priority).map((r) => r.exchange.toLowerCase().replace(/\.$/, "")).filter(Boolean);
  if (!hosts.length || (hosts.length === 1 && hosts[0] === "")) return { provider: "none", name: null, host: null };
  for (const h of hosts) {
    const p = PROVIDERS.find((x) => x.re.test(h));
    if (p) return { provider: p.provider, name: p.name, host: hosts[0] };
  }
  // Anything else: name it by the MX host's own domain.
  const parts = hosts[0].split(".");
  return { provider: "other", name: parts.slice(-2).join("."), host: hosts[0] };
}

/** How old the latest auto-reply can be before the seed should be checked again. */
export const FRESH_DAYS = 45;

export type SeedStatus = "ready" | "recheck" | "outlook" | "other" | "unknown" | "forwards" | "person" | "bounced" | "no_mx";

export const STATUS_LABEL: Record<SeedStatus, string> = {
  ready: "Ready",
  recheck: "Needs a re-check",
  outlook: "Microsoft, not counted",
  other: "Other provider",
  unknown: "Looking up mail",
  forwards: "Forwarded",
  person: "A person replied",
  bounced: "Bounced",
  no_mx: "No mail server",
};

export const STATUS_HINT: Record<SeedStatus, string> = {
  ready: `Google mail, auto-replied in the last ${FRESH_DAYS} days. Counts in a placement test`,
  recheck: `Google mail, but the last auto-reply is over ${FRESH_DAYS} days old. It will be emailed once to check it still answers`,
  outlook: "Microsoft sends the auto-reply even from the junk folder, so it can't tell inbox from spam",
  other: "A filter in front of the mailbox (Mimecast, Proofpoint…) or another provider: not known to skip auto-replies from spam",
  unknown: "Its MX records haven't been looked up yet",
  forwards: "The auto-reply says the mail is forwarded or read by someone",
  person: "Someone wrote a reply from this address after the auto-reply",
  bounced: "An email to it bounced after the last auto-reply: the mailbox is gone",
  no_mx: "The company's domain has no mail server any more",
};

/** Excluded for good: never used in a test. */
export const EXCLUDED: SeedStatus[] = ["forwards", "person", "bounced", "no_mx"];

export function seedStatus(s: {
  forwards: boolean; lastReplyAt: string; personRepliedAt: string | null; bouncedAt: string | null; provider: MxProvider | null;
}, now: number): SeedStatus {
  if (s.personRepliedAt) return "person";
  if (s.bouncedAt && s.bouncedAt > s.lastReplyAt) return "bounced";
  if (s.forwards) return "forwards";
  if (s.provider === "none") return "no_mx";
  if (!s.provider) return "unknown";
  if (s.provider === "outlook") return "outlook";
  if (s.provider !== "google") return "other";
  return now - new Date(s.lastReplyAt).getTime() <= FRESH_DAYS * 86_400_000 ? "ready" : "recheck";
}
