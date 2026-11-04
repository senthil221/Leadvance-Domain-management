import type { BounceReason } from "./bounces";
import { slText } from "./smartlead-state";

// The weekly review's call on each sending domain, with the numbers behind
// it. Shared by server and client. Spam and blocklist rejections, a low
// warmup reputation and days without any reply count against the domain;
// addresses that don't exist count against the list.

export type Verdict = "fix" | "rest" | "grace" | "drop" | "dead" | "ended" | "watch" | "idle" | "warming" | "low" | "ok" | "gone";

/**
 * Where a domain really stands today (the domain_standing view). Active and
 * grace are current: they're what every page shows by default. The rest is history.
 */
export type Standing = "active" | "grace" | "expired" | "replaced" | "cancelled" | "retired" | "disconnected" | "deleted" | "not_connected" | "no_order";
export const STANDING_META: Record<Standing, { label: string; hint: string }> = {
  active: { label: "Active", hint: "Connected in Smartlead with a live order" },
  grace: { label: "In grace period", hint: "Replaced or cancelled, but the provider is keeping its inboxes up for now" },
  expired: { label: "Expired", hint: "The domain's registration has run out" },
  replaced: { label: "Replaced", hint: "The provider moved this domain's order to another domain, and the grace period is over" },
  cancelled: { label: "Cancelled", hint: "The order is cancelled and the grace period is over" },
  retired: { label: "Retired", hint: "Taken out of use here: draining, burned or resting" },
  disconnected: { label: "Disconnected", hint: "Every inbox is disconnected in Smartlead" },
  deleted: { label: "Deleted in Smartlead", hint: "Every inbox was deleted in Smartlead" },
  not_connected: { label: "Not connected", hint: "No inboxes in Smartlead" },
  no_order: { label: "No order", hint: "Connected in Smartlead, but the provider has no live order for it" },
};
export const isCurrent = (s: Standing | null | undefined) => s === "active" || s === "grace";

export const VERDICT_META: Record<Verdict, { label: string; tone: "danger" | "warning" | "info" | "faint" | "success"; hint: string }> = {
  fix: { label: "Fix sender", tone: "danger", hint: "Our own setup is failing: tenant or mailbox blocked, DNS missing, or inboxes disconnected" },
  rest: { label: "Replace", tone: "danger", hint: "Two strikes (spam, blocklisted, low rep, no reply for days), heavy spam with no replies, or no response at all on real volume: pull it and line up a replacement" },
  grace: { label: "In grace period", tone: "info", hint: "Replaced or cancelled, but its inboxes stay up for a while: it still counts until the grace period ends" },
  drop: { label: "Cancelled / replaced", tone: "danger", hint: "Every inbox is disconnected and the provider has cancelled the order or the domain was replaced: nothing to reconnect. Delete in one go" },
  dead: { label: "Disconnected", tone: "warning", hint: "Every inbox is disconnected, but the provider hasn't cancelled or replaced the domain: try reconnecting before replacing" },
  ended: { label: "Ended", tone: "faint", hint: "Not active any more: expired, retired, or its order has ended, though some inboxes still show connected" },
  watch: { label: "Watch", tone: "warning", hint: "One strike so far: still worth sending, at lower volume" },
  idle: { label: "Idle", tone: "info", hint: "Active with inboxes connected, but nothing was sent in this range" },
  warming: { label: "Warming", tone: "info", hint: "Marked as still warming up, so it isn't expected to send yet" },
  low: { label: "Too little sent", tone: "faint", hint: "Not enough sent in this range to judge" },
  ok: { label: "OK", tone: "success", hint: "Nothing to act on" },
  gone: { label: "Deleted in Smartlead", tone: "faint", hint: "Every inbox was deleted in Smartlead: its numbers are history, nothing to fix or reconnect" },
};
export const VERDICT_ORDER: Verdict[] = ["fix", "rest", "grace", "drop", "dead", "ended", "watch", "idle", "warming", "low", "ok", "gone"];

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
  /** Sent in the range with not one reply, not even an out of office: Replace on its own. */
  silentSent: 300,
};

/**
 * The short tags beside each domain. Strikes count against the domain; the
 * rest explain the call. Ordered as they're shown.
 */
export type Signal = "ended" | "unlisted" | "tenant" | "dns" | "disconnected" | "spam" | "rising" | "blocklist" | "lowrep" | "quiet" | "silent" | "badlist";
export const SIGNAL_META: Record<Signal, { label: string; hint: string; strike?: true }> = {
  ended: { label: "Cancelled / replaced", hint: "The provider shows the order cancelled, or the domain was replaced" },
  unlisted: { label: "No order", hint: "Fully disconnected, and the provider's order list doesn't have the domain (or no longer does). The list can miss a live domain, so this alone doesn't prove it's cancelled" },
  tenant: { label: "Tenant", hint: "Bounces saying our Microsoft tenant or mailbox is blocked, over its limit, or can't sign in" },
  dns: { label: "DNS", hint: "Bounces saying the sending domain has no MX/A records, or SPF, DKIM or DMARC failed" },
  disconnected: { label: "Disconnected", hint: "Inboxes disconnected in Smartlead" },
  spam: { label: "Spam", hint: `Spam rejections: at least ${RULES.watchSpam} and ${RULES.watchSpamRate}% of sent`, strike: true },
  rising: { label: "Spam rising", hint: "Spam share at least doubled since the same days before" },
  blocklist: { label: "Blocklisted", hint: `On a blocklist in Smartlead's scan, or ${RULES.restBlocklist}+ blocklist bounces`, strike: true },
  lowrep: { label: "Low rep", hint: `Average warmup reputation under ${RULES.lowRep}`, strike: true },
  quiet: { label: "No reply", hint: `No reply of any kind (out of office included) for ${RULES.quietDays}+ days with ${RULES.quietSent}+ sent since`, strike: true },
  silent: { label: "No response", hint: `${RULES.silentSent}+ sent in the range and not one reply, not even an out of office: the mail is likely landing in spam`, strike: true },
  badlist: { label: "Bad list", hint: "Most bounces are addresses that don't exist: the list's fault, not the domain's" },
};
export const SIGNAL_ORDER: Signal[] = ["ended", "unlisted", "tenant", "dns", "disconnected", "spam", "rising", "blocklist", "lowrep", "quiet", "silent", "badlist"];
export type Tone = "danger" | "warning" | "info" | "faint";
export type Chip = { key: Signal; text: string; tone: Tone; why: string };

export type ReviewDomain = {
  id: string; name: string; status: string; clientId: string | null; clientName: string | null; clientHue: number | null; tags: string[];
  /** Inboxes connected and disconnected in Smartlead now, and deleted there (as of the last sync). */
  inboxes: number; disconnected: number; removed: number; blacklisted: number;
  sent: number; replies: number; human: number; bounces: number;
  /** Replies that are out of office, automatic, or not interested (with wrong person and unsubscribe). */
  ooo: number; auto: number; negative: number;
  causes: Partial<Record<BounceReason, number>>;
  prevSent: number; prevHuman: number; prevReplies: number; prevBounces: number; prevSpam: number;
  /** Days since the domain was bought, and since its first inbox joined Smartlead. */
  ageDays: number | null; connectedDays: number | null;
  /** Where its inboxes come from (Hypertide for Outlook, Icemail for Google), where it stands today, and the grace days left. */
  provider: string | null; standing: Standing | null; graceLeft: number | null;
  /** Average warmup reputation of the connected inboxes, and how many are under RULES.lowRep. */
  rep: number | null; lowRepInboxes: number;
  /** Days from the last reply of any kind (or, with none on record, the first send) to the end of the range. */
  quietDays: number | null; neverReplied: boolean; sentSinceReply: number;
  /** The Smartlead tags on the domain's inboxes, most used first. */
  slTags: string[];
  /** Smartlead's provider type of the domain's inboxes (OUTLOOK, GMAIL, SMTP), MIXED when they differ. */
  esp: string | null; tld: string | null;
  /**
   * Where the domain's order stands at its provider: live, cancelled, gone from
   * the order list, the domain was replaced (by replacedBy), or there's no order
   * for it on this account. null when no provider is on file.
   */
  ht: Ht | null; replacedBy: string | null;
};
export type Ht = "live" | "cancelled" | "gone" | "replaced" | "none";
/** The order column of the sheet, and the chip on a domain its provider is done with. */
export function orderMeta(ht: Ht, provider: string | null | undefined): { label: string; chip: string; why: string } {
  const p = provider ?? "the provider";
  switch (ht) {
    case "live": return { label: "Live", chip: "", why: "" };
    case "cancelled": return { label: "Cancelled", chip: `${provider ?? "Order"} cancelled`, why: `cancelled on ${p}` };
    case "gone": return { label: "Off the order list", chip: `Off ${provider ?? "order"} list`, why: `no longer on ${p}'s order list` };
    case "replaced": return { label: "Replaced", chip: "Replaced", why: "replaced" };
    case "none": return { label: "No order", chip: `No ${provider ?? ""} order`.replace("  ", " "), why: `no ${p} order on this account` };
  }
}
/** The mail provider as people say it. */
export const espName = (esp: string | null | undefined) =>
  !esp ? "Unknown" : esp === "OUTLOOK" ? "Outlook" : esp === "GMAIL" || esp === "GOOGLE" ? "Google" : esp === "MIXED" ? "Mixed" : esp === "SMTP" ? "SMTP" : esp.charAt(0) + esp.slice(1).toLowerCase();
export const ESP_ORDER = ["Outlook", "Google", "SMTP", "Mixed", "Unknown"];

const htText = (d: ReviewDomain) => (d.ht === "replaced" && d.replacedBy ? `Replaced by ${d.replacedBy}` : d.ht ? orderMeta(d.ht, d.provider).label : "");
export type ReviewCampaign = { id: number; name: string; clientName: string | null; bounces: number; missing: number };
export type ReviewData = { from: string; to: string; today: string; slSyncedAt: Date | null; domains: ReviewDomain[]; campaigns: ReviewCampaign[] };
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
  // Cancelled or replaced is proof the inboxes won't come back. A domain missing
  // from the order list isn't: Hypertide's list leaves out some live domains.
  const ended = d.ht === "cancelled" || d.ht === "replaced";
  const allGone = d.disconnected > 0 && !d.inboxes;
  if ((d.ht === "gone" || d.ht === "none") && allGone) { const m = orderMeta(d.ht, d.provider); add("unlisted", m.chip, "info", m.why); }
  if (ended && d.ht) {
    const m = orderMeta(d.ht, d.provider);
    add("ended", d.ht === "replaced" && d.replacedBy ? `Replaced → ${d.replacedBy}` : m.chip, allGone ? "danger" : "warning",
      d.ht === "replaced" && d.replacedBy ? `replaced by ${d.replacedBy}` : m.why);
  }
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
  const quiet = d.quietDays != null && d.quietDays >= RULES.quietDays && d.sentSinceReply >= RULES.quietSent;
  // Quiet for days and not one reply in the whole range on real volume: no
  // longer a strike among others, it goes on its own.
  const silent = quiet && d.replies === 0 && d.sent >= RULES.silentSent;
  if (silent) {
    add("silent", `No response · ${n(d.sent)} sent`, "danger", `not one reply on ${n(d.sent)} sent, not even an out of office`);
  } else if (quiet && d.quietDays != null) {
    const days = `${n(d.quietDays)}${d.neverReplied ? "+" : ""}d`;
    add("quiet", `No reply ${days}`, d.quietDays >= RULES.longQuietDays ? "danger" : "warning",
      `no reply of any kind ${d.neverReplied ? "on record" : `for ${s(d.quietDays, "day")}`} (${n(d.sentSinceReply)} sent since)`);
  }
  const missing = c.missing ?? 0;
  if (missing >= 10 && missing >= 0.5 * d.bounces) add("badlist", `Bad list ${Math.round(pct(missing, d.bounces))}%`, "info", `${n(missing)} of ${s(d.bounces, "bounce")} to addresses that don't exist`);

  const strikes = chips.filter((x) => SIGNAL_META[x.key].strike).length;
  const said = (keys: Signal[]) => chips.filter((x) => keys.includes(x.key)).map((x) => x.why).join(", ");
  const against = said(["spam", "rising", "blocklist", "lowrep", "quiet", "silent"]);
  const humans = s(d.human, "human reply", "human replies");
  const out = (verdict: Verdict, why: string): Judged => ({ ...d, verdict, why: why.charAt(0).toUpperCase() + why.slice(1), worse, spam, chips, strikes });
  // A reply in the last few days, of any kind, says the domain still lands.
  const replying = d.quietDays != null && d.quietDays < RULES.quietDays && !d.neverReplied;

  // Expired, or still connected after its order ended: history, whatever its numbers say.
  if (d.standing === "expired") return out("ended", "The domain has expired");
  if (d.standing && !isCurrent(d.standing) && d.inboxes > 0) return out("ended", STANDING_META[d.standing].hint);
  if (d.standing === "grace") {
    return out("grace", d.graceLeft != null ? `Inboxes stay up for ${s(d.graceLeft, "more day")}: it still counts until then` : "Marked replaced, with its inboxes still connected");
  }
  // Deleted in Smartlead: last week's numbers are history, nothing to act on.
  if (!d.inboxes && !d.disconnected && d.removed) return out("gone", `Every inbox (${s(d.removed, "inbox", "inboxes")}) was deleted in Smartlead`);
  // No inbox left to log into: nothing else about the domain matters. Gone
  // from Hypertide, it can go; otherwise it may only need reconnecting.
  if (allGone) return ended ? out("drop", said(["ended", "disconnected"])) : out("dead", said(["unlisted", "disconnected"]));
  if (ownSetup) return out("fix", `${said(["tenant", "dns", "disconnected"])}${against ? `; ${against}` : ""}`);
  if (d.status === "active" && d.sent === 0) return out("idle", ["Nothing sent", said(["disconnected", "lowrep"])].filter(Boolean).join("; "));
  if (d.status === "warming" && d.sent === 0) return out("warming", ["Warming up, not sending yet", said(["disconnected", "lowrep"])].filter(Boolean).join("; "));
  if (silent) return out("rest", against);
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
  const head = ["Domain", "Call", "Reason", "Signals", "ESP", "TLD", "Smartlead tags", "Order", "Client", "Status", "Sent", "Human replies", "Spam rejections",
    "Bounce rate", "Warmup reputation", "Days since any reply", "Inboxes connected", "Inboxes disconnected", "Replies incl. OOO", "Smartlead now", "Provider", "Domain age (days)", "In Smartlead (days)"];
  const rows = list.map((d) => [
    d.name, VERDICT_META[d.verdict].label, d.why, d.chips.map((c) => c.text).join(", "), espName(d.esp), d.tld ? `.${d.tld}` : "", d.slTags.join(", "), htText(d), d.clientName, d.status,
    d.sent, d.human, d.spam, d.sent ? `${((100 * d.bounces) / d.sent).toFixed(2)}%` : "", d.rep,
    d.quietDays == null ? "" : `${d.quietDays}${d.neverReplied ? "+" : ""}`, d.inboxes, d.disconnected, d.replies,
    slText({ slConnected: d.inboxes, slDisconnected: d.disconnected, slRemoved: d.removed }), d.provider, d.ageDays, d.connectedDays,
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
        r = { ...k, domains: 0, counts: { fix: 0, rest: 0, grace: 0, drop: 0, dead: 0, ended: 0, watch: 0, idle: 0, warming: 0, low: 0, ok: 0, gone: 0 }, sent: 0, human: 0, bounces: 0, spam: 0 };
        m.set(k.id, r);
      }
      r.domains++; r.counts[d.verdict]++;
      r.sent += d.sent; r.human += d.human; r.bounces += d.bounces; r.spam += d.spam;
    }
  }
  return [...m.values()].sort((a, b) =>
    b.counts.fix + b.counts.rest - (a.counts.fix + a.counts.rest) || b.counts.drop + b.counts.dead - (a.counts.drop + a.counts.dead) || b.counts.watch - a.counts.watch || b.sent - a.sent || a.name.localeCompare(b.name));
}

/** One row per client. "" is the domains without a client. */
export const byClient = (domains: Judged[]) =>
  summarize(domains, (d) => [{ id: d.clientId ?? "", name: d.clientName ?? "No client", hue: d.clientHue }]);

/** One row per mail provider. */
export const byEsp = (domains: Judged[]) =>
  summarize(domains, (d) => [{ id: espName(d.esp), name: espName(d.esp), hue: null }]);

/** One row per inbox provider. */
export const byProvider = (domains: Judged[]) =>
  summarize(domains, (d) => [{ id: d.provider ?? "?", name: d.provider ?? "No provider", hue: null }]);

/** One row per TLD. */
export const byTld = (domains: Judged[]) =>
  summarize(domains, (d) => [{ id: d.tld ?? "?", name: d.tld ? `.${d.tld}` : "No TLD", hue: null }]);

/** One row per Smartlead tag; a domain with two tags counts under both. "" is the untagged domains. */
export const bySmartleadTag = (domains: Judged[]) =>
  summarize(domains, (d) => (d.slTags.length ? d.slTags : [""]).map((t) => ({ id: t, name: t || "No tag", hue: null })));

export type Advice = { tone: Tone | "success"; text: string };

/**
 * What to do about a domain, in words, from its call and what its bounces
 * say. The first is the one that matters most; the rest are worth knowing.
 */
export function advise(d: Judged): Advice[] {
  const out: Advice[] = [];
  const add = (tone: Advice["tone"], text: string) => out.push({ tone, text });
  const c = d.causes;
  const total = Object.values(c).reduce((a, b) => a + (b ?? 0), 0);
  const br = pct(d.bounces, d.sent);
  const share = (k: BounceReason) => (total ? (c[k] ?? 0) / total : 0);
  const tenant = c.sender ?? 0, dns = c.dns ?? 0, recipient = (c.restricted ?? 0) + (c.policy ?? 0) + (c.full ?? 0);

  if (d.verdict === "gone") return [{ tone: "faint", text: "Deleted in Smartlead: nothing to analyse. Mark it replaced, or send it back to storage to reuse later" }];
  if (d.verdict === "ended") return [{ tone: "faint", text: `${d.standing ? STANDING_META[d.standing].label : "Ended"}: history, nothing to fix. Delete any inboxes still in Smartlead` }];
  if (d.verdict === "grace") return [{ tone: "info", text: "Replaced or cancelled: keep it for replies until its inboxes go, then delete them in Smartlead" }];
  if (d.verdict === "drop") add("danger", `Delete its inboxes in Smartlead: ${d.ht === "replaced" && d.replacedBy ? `replaced by ${d.replacedBy}` : `${d.provider ?? "the provider"} has cancelled it`}, nothing to reconnect`);
  if (d.verdict === "dead") add("warning", `Reconnect the inboxes in Smartlead; if they don't come back, cancel it on ${d.provider ?? "the provider"} and replace it`);
  if (tenant >= RULES.senderBounces) add("danger", `${s(tenant, "bounce")} say the tenant or mailbox is blocked or over its limit: pause it in campaigns, check the Microsoft tenant, then lower the daily limit`);
  if (dns >= RULES.senderBounces) add("danger", `${s(dns, "bounce")} say SPF, DKIM or DMARC failed: run Validate DNS and fix the records before sending more`);
  if (d.disconnected && d.inboxes) add("warning", `${n(d.disconnected)} of ${n(d.inboxes + d.disconnected)} inboxes disconnected: reconnect them`);
  if (d.blacklisted || (c.blocklist ?? 0) >= RULES.restBlocklist) add("danger", `${d.blacklisted ? `On ${s(d.blacklisted, "blocklist")}` : `${n(c.blocklist ?? 0)} blocklist bounces`}: take it out of campaigns and replace it`);
  if (d.verdict === "rest" && !out.some((a) => a.tone === "danger")) add("danger", "Replace it: line up a rested domain and move its campaigns over");
  const spamRate = pct(d.spam, d.sent) ?? 0;
  if (d.spam >= RULES.watchSpam && spamRate >= RULES.watchSpamRate && d.verdict !== "rest") {
    add("warning", `${p(spamRate)} rejected as spam: lower the daily limit by about half and keep warmup on; replace it if it rises again next week`);
  }
  if (br != null && br >= 2 && total) {
    if (share("missing") >= 0.5) add("info", `${p(br)} bounce, but ${Math.round(100 * share("missing"))}% are addresses that don't exist: re-verify the list, the domain is fine`);
    else if (recipient / total >= 0.5) add("info", `${p(br)} bounce, mostly the recipients' own rules (groups, filters, full mailboxes): drop those leads, not the domain`);
    else if (share("other") + share("temporary") >= 0.5) add("info", `${p(br)} bounce with no clear reason in the notices: open the bounces to read them`);
  }
  if (d.rep != null && d.rep < RULES.lowRep) add("warning", `Warmup reputation ${d.rep.toFixed(0)}: keep warmup on and send less until it is back over ${RULES.lowRep}`);
  if (d.chips.some((x) => x.key === "silent")) add("danger", `${n(d.sent)} sent and not one reply: it's likely landing in spam; rest or replace it`);
  else if (d.chips.some((x) => x.key === "quiet")) add("warning", `No reply for ${n(d.quietDays ?? 0)} days: check inbox placement and lower the volume`);
  if (d.verdict === "warming") add("info", "Warming up: mark it active once it joins a campaign");
  if (d.verdict === "idle") add("info", "Connected but sent nothing: add it to a campaign or check its Smartlead tag");
  if (d.verdict === "low" && !out.length) add("faint", `Only ${n(d.sent)} sent: too little to judge yet`);
  if (!out.length && d.sent) add("success", "Healthy: nothing to change");
  return out;
}
