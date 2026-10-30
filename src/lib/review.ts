import type { BounceReason } from "./bounces";

// The weekly review's call on each sending domain, with the numbers behind
// it. Shared by server and client. Spam and blocklist rejections, a low
// warmup reputation and days without a human reply count against the domain;
// addresses that don't exist count against the list.

export type Verdict = "fix" | "rest" | "dead" | "watch" | "idle" | "low" | "ok";

export const VERDICT_META: Record<Verdict, { label: string; tone: "danger" | "warning" | "info" | "faint" | "success"; hint: string }> = {
  fix: { label: "Fix sender", tone: "danger", hint: "Our own setup is failing: tenant or mailbox blocked, DNS missing, or inboxes disconnected" },
  rest: { label: "Replace", tone: "danger", hint: "Two strikes (spam, blocklisted, low rep, no reply for days) or heavy spam with no replies: pull it and line up a replacement" },
  dead: { label: "Disconnected", tone: "danger", hint: "Every inbox is disconnected: we can't get into them. Delete or replace in one go" },
  watch: { label: "Watch", tone: "warning", hint: "One strike so far: still worth sending, at lower volume" },
  idle: { label: "Idle", tone: "info", hint: "Active with inboxes connected, but nothing was sent in this range" },
  low: { label: "Too little sent", tone: "faint", hint: "Not enough sent in this range to judge" },
  ok: { label: "OK", tone: "success", hint: "Nothing to act on" },
};
export const VERDICT_ORDER: Verdict[] = ["fix", "rest", "dead", "watch", "idle", "low", "ok"];

/** The thresholds. A domain needs MIN_SENT in the range before it is judged on rates. */
export const RULES = {
  minSent: 50,
  senderBounces: 3,
  restSpam: 10,
  restSpamRate: 1.5,
  restBlocklist: 5,
  watchSpam: 5,
  watchSpamRate: 0.5,
  lowRep: 90,
  quietDays: 3,
  longQuietDays: 7,
  quietSent: 300,
};

/**
 * The short tags beside each domain. Strikes count against the domain; the
 * rest explain the call. Ordered as they're shown.
 */
export type Signal = "tenant" | "dns" | "disconnected" | "spam" | "rising" | "blocklist" | "lowrep" | "quiet" | "badlist";
export const SIGNAL_META: Record<Signal, { label: string; hint: string; strike?: true }> = {
  tenant: { label: "Tenant", hint: "Bounces saying our Microsoft tenant or mailbox is blocked, over its limit, or can't sign in" },
  dns: { label: "DNS", hint: "Bounces saying the sending domain has no MX/A records, or SPF, DKIM or DMARC failed" },
  disconnected: { label: "Disconnected", hint: "Inboxes disconnected in Smartlead" },
  spam: { label: "Spam", hint: `Spam rejections: at least ${RULES.watchSpam} and ${RULES.watchSpamRate}% of sent`, strike: true },
  rising: { label: "Spam rising", hint: "Spam share at least doubled since the same days before" },
  blocklist: { label: "Blocklisted", hint: `On a blocklist in Smartlead's scan, or ${RULES.restBlocklist}+ blocklist bounces`, strike: true },
  lowrep: { label: "Low rep", hint: `Average warmup reputation under ${RULES.lowRep}`, strike: true },
  quiet: { label: "No reply", hint: `No human reply for ${RULES.quietDays}+ days with ${RULES.quietSent}+ sent since`, strike: true },
  badlist: { label: "Bad list", hint: "Most bounces are addresses that don't exist: the list's fault, not the domain's" },
};
export const SIGNAL_ORDER: Signal[] = ["tenant", "dns", "disconnected", "spam", "rising", "blocklist", "lowrep", "quiet", "badlist"];
export type Tone = "danger" | "warning" | "info" | "faint";
export type Chip = { key: Signal; text: string; tone: Tone; why: string };

export type ReviewDomain = {
  id: string; name: string; status: string; clientId: string | null; clientName: string | null; clientHue: number | null; tags: string[];
  inboxes: number; disconnected: number; blacklisted: number;
  sent: number; replies: number; human: number; bounces: number;
  causes: Partial<Record<BounceReason, number>>;
  prevSent: number; prevHuman: number; prevSpam: number;
  /** Average warmup reputation of the connected inboxes, and how many are under RULES.lowRep. */
  rep: number | null; lowRepInboxes: number;
  /** Days from the last human reply (or, with none on record, the first send) to the end of the range. */
  quietDays: number | null; neverReplied: boolean; sentSinceReply: number;
  /** The Smartlead tags on the domain's inboxes, most used first. */
  slTags: string[];
};
export type ReviewCampaign = { id: number; name: string; clientName: string | null; bounces: number; missing: number };
export type ReviewData = { from: string; to: string; today: string; domains: ReviewDomain[]; campaigns: ReviewCampaign[] };
export type Judged = ReviewDomain & { verdict: Verdict; why: string; worse: boolean; spam: number; chips: Chip[]; strikes: number };

const pct = (n: number, d: number) => (d > 0 ? (100 * n) / d : 0);
const p = (v: number) => `${v < 1 ? v.toFixed(2) : v.toFixed(1)}%`;
const n = (v: number) => v.toLocaleString("en-US");
const s = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

export function judge(d: ReviewDomain): Judged {
  const c = d.causes;
  const spam = (c.spam ?? 0) + (c.blocklist ?? 0);
  const rate = pct(spam, d.sent);
  const prevRate = pct(d.prevSpam, d.prevSent);
  const judged = d.sent >= RULES.minSent;
  // Spam share at least doubled since the same days before.
  const worse = spam >= RULES.watchSpam && d.prevSent >= RULES.minSent && rate >= 2 * prevRate && rate > prevRate;
  const tenant = c.sender ?? 0, dns = c.dns ?? 0;
  const ownSetup = tenant + dns >= RULES.senderBounces;
  const heavySpam = judged && spam >= RULES.restSpam && rate >= RULES.restSpamRate;

  const chips: Chip[] = [];
  const add = (key: Signal, text: string, tone: Tone, why: string) => chips.push({ key, text, tone, why });
  if (ownSetup && tenant) add("tenant", `Tenant ${n(tenant)}`, "danger", `${s(tenant, "bounce")} from the tenant or mailbox`);
  if (ownSetup && dns) add("dns", `DNS ${n(dns)}`, "danger", `${s(dns, "bounce")} from missing or failing DNS`);
  if (d.disconnected) add("disconnected", `Disconnected ${n(d.disconnected)}/${n(d.inboxes + d.disconnected)}`, "danger", `${n(d.disconnected)} of ${n(d.inboxes + d.disconnected)} inboxes disconnected`);
  if (judged && spam >= RULES.watchSpam && rate >= RULES.watchSpamRate) {
    add("spam", `Spam ${p(rate)}`, heavySpam ? "danger" : "warning", `${n(spam)} spam/blocklist rejections, ${p(rate)} of ${n(d.sent)} sent`);
  }
  if (worse) add("rising", `Spam ↑ from ${p(prevRate)}`, "warning", `up from ${p(prevRate)}`);
  if (d.blacklisted || (c.blocklist ?? 0) >= RULES.restBlocklist) {
    add("blocklist", "Blocklisted", "danger", d.blacklisted ? `on ${s(d.blacklisted, "blocklist")}` : `${n(c.blocklist ?? 0)} blocklist bounces`);
  }
  if (d.rep != null && d.rep < RULES.lowRep) {
    add("lowrep", `Rep ${d.rep.toFixed(0)}`, d.rep < RULES.lowRep - 5 ? "danger" : "warning",
      `warmup reputation ${d.rep.toFixed(1)}${d.lowRepInboxes ? ` (${s(d.lowRepInboxes, "inbox", "inboxes")} under ${RULES.lowRep})` : ""}`);
  }
  if (d.quietDays != null && d.quietDays >= RULES.quietDays && d.sentSinceReply >= RULES.quietSent) {
    const days = `${n(d.quietDays)}${d.neverReplied ? "+" : ""}d`;
    add("quiet", `No reply ${days}`, d.quietDays >= RULES.longQuietDays ? "danger" : "warning",
      `no human reply ${d.neverReplied ? "on record" : `for ${s(d.quietDays, "day")}`} (${n(d.sentSinceReply)} sent since)`);
  }
  const missing = c.missing ?? 0;
  if (missing >= 10 && missing >= 0.5 * d.bounces) add("badlist", `Bad list ${Math.round(pct(missing, d.bounces))}%`, "info", `${n(missing)} of ${s(d.bounces, "bounce")} to addresses that don't exist`);

  const strikes = chips.filter((x) => SIGNAL_META[x.key].strike).length;
  const said = (keys: Signal[]) => chips.filter((x) => keys.includes(x.key)).map((x) => x.why).join(", ");
  const against = said(["spam", "rising", "blocklist", "lowrep", "quiet"]);
  const humans = s(d.human, "human reply", "human replies");
  const out = (verdict: Verdict, why: string): Judged => ({ ...d, verdict, why: why.charAt(0).toUpperCase() + why.slice(1), worse, spam, chips, strikes });
  // A human reply in the last few days says the domain still lands.
  const replying = d.quietDays != null && d.quietDays < RULES.quietDays && !d.neverReplied;

  // No inbox left to log into: nothing else about the domain matters.
  if (d.disconnected && !d.inboxes) return out("dead", said(["disconnected"]));
  if (ownSetup) return out("fix", `${said(["tenant", "dns", "disconnected"])}${against ? `; ${against}` : ""}`);
  if (d.status === "active" && d.sent === 0) return out("idle", ["Nothing sent", said(["disconnected", "lowrep"])].filter(Boolean).join("; "));
  if (judged && d.human === 0 && (heavySpam || (c.blocklist ?? 0) >= RULES.restBlocklist)) return out("rest", chips.some((x) => x.key === "quiet") ? against : `${against}, no human replies`);
  if (strikes >= 2 && !replying) return out("rest", `${against}; ${humans}`);
  if (strikes >= 1) return out("watch", `${against}; ${humans}`);
  if (d.disconnected) return out("fix", said(["disconnected"]));
  if (d.sent > 0 && d.sent < RULES.minSent) return out("low", `Only ${n(d.sent)} sent`);
  return out("ok", d.sent ? `${p(pct(d.human, d.sent))} human replies, ${p(pct(d.bounces, d.sent))} bounces` : "Not sending");
}

/** Campaigns whose bounces are mostly addresses that don't exist: the list needs re-verifying, not the domains. */
export function badLists(campaigns: ReviewCampaign[]) {
  return campaigns
    .filter((c) => c.missing >= 10 && c.missing >= 0.5 * c.bounces)
    .sort((a, b) => b.missing - a.missing);
}

export type ClientSummary = {
  id: string; name: string; hue: number | null; domains: number; counts: Record<Verdict, number>;
  sent: number; human: number; bounces: number; spam: number;
};

/** A cell Google Sheets pastes as plain text: no tabs or line breaks, and never read as a formula. */
const cell = (v: string | number | null) => {
  const t = v == null ? "" : String(v).replace(/[\t\r\n]+/g, " ").trim();
  return /^[=+\-@]/.test(t) ? `'${t}` : t;
};

/** Tab-separated rows with a header, ready to paste into Google Sheets: one column per fact. */
export function sheetRows(list: Judged[]): string {
  const head = ["Domain", "Call", "Reason", "Signals", "Smartlead tags", "Client", "Status", "Sent", "Human replies", "Spam rejections",
    "Bounce rate", "Warmup reputation", "Days since human reply", "Inboxes connected", "Inboxes disconnected"];
  const rows = list.map((d) => [
    d.name, VERDICT_META[d.verdict].label, d.why, d.chips.map((c) => c.text).join(", "), d.slTags.join(", "), d.clientName, d.status,
    d.sent, d.human, d.spam, d.sent ? `${((100 * d.bounces) / d.sent).toFixed(2)}%` : "", d.rep,
    d.quietDays == null ? "" : `${d.quietDays}${d.neverReplied ? "+" : ""}`, d.inboxes, d.disconnected,
  ].map(cell).join("\t"));
  return [head.join("\t"), ...rows].join("\n");
}

/** Rows of domains grouped by keys (a domain can sit in several), worst first: most to fix or replace, then to watch. */
function summarize(domains: Judged[], keys: (d: Judged) => { id: string; name: string; hue: number | null }[]): ClientSummary[] {
  const m = new Map<string, ClientSummary>();
  for (const d of domains) {
    for (const k of keys(d)) {
      let r = m.get(k.id);
      if (!r) {
        r = { ...k, domains: 0, counts: { fix: 0, rest: 0, dead: 0, watch: 0, idle: 0, low: 0, ok: 0 }, sent: 0, human: 0, bounces: 0, spam: 0 };
        m.set(k.id, r);
      }
      r.domains++; r.counts[d.verdict]++;
      r.sent += d.sent; r.human += d.human; r.bounces += d.bounces; r.spam += d.spam;
    }
  }
  return [...m.values()].sort((a, b) =>
    b.counts.fix + b.counts.rest - (a.counts.fix + a.counts.rest) || b.counts.dead - a.counts.dead || b.counts.watch - a.counts.watch || b.sent - a.sent || a.name.localeCompare(b.name));
}

/** One row per client. "" is the domains without a client. */
export const byClient = (domains: Judged[]) =>
  summarize(domains, (d) => [{ id: d.clientId ?? "", name: d.clientName ?? "No client", hue: d.clientHue }]);

/** One row per Smartlead tag; a domain with two tags counts under both. "" is the untagged domains. */
export const bySmartleadTag = (domains: Judged[]) =>
  summarize(domains, (d) => (d.slTags.length ? d.slTags : [""]).map((t) => ({ id: t, name: t || "No tag", hue: null })));
