// Why one domain is or isn't performing. The numbers are worked out here, not by
// the AI: it only reads them and explains, and every claim has to point at one.
// Nothing here names the domain or the client, and no message text is sent.

import { z } from "zod";
import { MIN_SENT, zScore } from "./compare";
import { ACTION_KEYS, VERDICT_KEYS, type CitedFact, type Diagnosis } from "./diagnose-meta";
import { fixQueue, problemsOf, type FixFact } from "./fix-queue";
import { RULES } from "./review";

/** What the AI must send back. Kept plain, since the API accepts only simple schemas. */
export const DiagnosisSchema = z.object({
  verdict: z.enum(VERDICT_KEYS),
  headline: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
  reasons: z.array(z.object({ claim: z.string(), facts: z.array(z.string()) })),
  action: z.enum(ACTION_KEYS),
  next: z.string(),
  wouldChange: z.string(),
  cannotSee: z.array(z.string()),
});
// checkDiagnosis turns it into a Diagnosis (diagnose-meta.ts), so the two can't drift apart.
export type DiagnosisRaw = z.infer<typeof DiagnosisSchema>;

type Week = { sent: number; daysSent: number; humanReplies: number; allReplies: number; ooo: number; bounces: number; humanReplyRate: number | null; bounceRate: number | null };
type PeerGroup = { domains: number; sent28: number; humanReplyRate28: number | null; bounceRate28: number | null; humanReplyRateWeek1: number | null; humanReplyRateWeek2: number | null };
export type Gap = "below" | "same" | "above" | "too_little_data";
type GapKey = "humanRepliesVsClient" | "bouncesVsClient" | "humanRepliesVsTag" | "bouncesVsTag" | "humanRepliesVsAll" | "bouncesVsAll" | "humanRepliesThisWeekVsBefore" | "bouncesThisWeekVsBefore";

export type DiagnosisFacts = {
  domain: { tld: string | null; status: string; standing: string | null; provider: string | null; ageDays: number | null; daysInSmartlead: number | null; daysToExpiry: number | null; autoRenew: boolean | null };
  inboxes: { connected: number; disconnected: number; capacityPerDay: number; lostCapacityPerDay: number; avgReputation: number | null; underReputationLimit: number; warmupOff: number; warmupBlocked: number };
  setup: { nameserversAnswering: boolean | null; spf: boolean | null; dkim: boolean | null; dmarc: boolean | null; mx: boolean | null; blockLists: number };
  week1: Week; week2: Week; week3: Week; week4: Week;
  bounces7: Record<string, number>;
  bounces28: Record<string, number>;
  peers: { client: PeerGroup | null; tag: PeerGroup | null; all: PeerGroup | null };
  gaps: Record<GapKey, Gap>;
  rules: { problems: string[]; replaceCall: string | null; replaceReasons: string[]; tagNotes: string[] };
  statusChanges: { from: string | null; to: string; daysAgo: number }[];
};

export type WeekRow = { week: number; sent: number; daysSent: number; humanReplies: number; allReplies: number; ooo: number; bounces: number };
export type CauseRow = { cause: string; last7: number; last28: number };
export type PeerRow = { grp: "client" | "tag" | "all"; week: number; domains: number; sent: number; humanReplies: number; bounces: number };
export type DiagnosisInput = {
  fact: FixFact | null;
  /** What the replace rules made of it this week, when it's a live sending domain. */
  replace?: { call: string; reasons: string[]; tagNotes?: string[] } | null;
  own: { tld: string | null; ageDays: number | null; daysInSmartlead: number | null };
  weeks: WeekRow[];
  causes: CauseRow[];
  peers: PeerRow[];
  changes: { from: string | null; to: string; daysAgo: number }[];
};

const rate = (k: number, n: number) => (n > 0 ? Math.round((10000 * k) / n) / 100 : null);

/** Whether a gap between two rates is too big to be chance. The AI is told this rather than left to guess it. */
export function gapBetween(k: number, n: number, peerK: number, peerN: number): Gap {
  if (n < MIN_SENT || peerN < MIN_SENT) return "too_little_data";
  const z = zScore(k, n, peerK, peerN);
  return Math.abs(z) < 2.6 ? "same" : z < 0 ? "below" : "above";
}

export function buildFacts(input: DiagnosisInput, fact: FixFact): DiagnosisFacts {
  const week = (w: number): Week => {
    const r = input.weeks.find((x) => x.week === w);
    const s = r?.sent ?? 0;
    return {
      sent: s, daysSent: r?.daysSent ?? 0, humanReplies: r?.humanReplies ?? 0, allReplies: r?.allReplies ?? 0, ooo: r?.ooo ?? 0, bounces: r?.bounces ?? 0,
      humanReplyRate: rate(r?.humanReplies ?? 0, s), bounceRate: rate(r?.bounces ?? 0, s),
    };
  };
  const weeks = [week(0), week(1), week(2), week(3)];
  const total = weeks.reduce((a, w) => ({ sent: a.sent + w.sent, human: a.human + w.humanReplies, bounces: a.bounces + w.bounces }), { sent: 0, human: 0, bounces: 0 });

  const peerTotals = (grp: PeerRow["grp"]) => {
    const rows = input.peers.filter((p) => p.grp === grp);
    return { rows, sent: rows.reduce((a, r) => a + r.sent, 0), human: rows.reduce((a, r) => a + r.humanReplies, 0), bounces: rows.reduce((a, r) => a + r.bounces, 0) };
  };
  const peerGroup = (grp: PeerRow["grp"]): PeerGroup | null => {
    const t = peerTotals(grp);
    if (!t.rows.length) return null;
    const at = (w: number) => t.rows.find((r) => r.week === w);
    return {
      domains: Math.max(...t.rows.map((r) => r.domains)), sent28: t.sent, humanReplyRate28: rate(t.human, t.sent), bounceRate28: rate(t.bounces, t.sent),
      humanReplyRateWeek1: rate(at(0)?.humanReplies ?? 0, at(0)?.sent ?? 0), humanReplyRateWeek2: rate(at(1)?.humanReplies ?? 0, at(1)?.sent ?? 0),
    };
  };
  const versus = (grp: PeerRow["grp"], key: "human" | "bounces") => {
    const t = peerTotals(grp);
    return gapBetween(total[key], total.sent, t[key], t.sent);
  };
  const before = { sent: total.sent - weeks[0].sent, human: total.human - weeks[0].humanReplies, bounces: total.bounces - weeks[0].bounces };

  const counts = (key: "last7" | "last28") => Object.fromEntries(input.causes.filter((c) => c[key] > 0).map((c) => [c.cause, c[key]]));
  const queue = fixQueue([fact]).items[0];

  return {
    domain: { tld: input.own.tld, status: fact.status, standing: fact.standing, provider: fact.provider, ageDays: input.own.ageDays, daysInSmartlead: input.own.daysInSmartlead, daysToExpiry: fact.daysToExpiry, autoRenew: fact.autoRenew },
    inboxes: { connected: fact.connected, disconnected: fact.disconnected, capacityPerDay: fact.capacity, lostCapacityPerDay: fact.lostCapacity, avgReputation: fact.rep == null ? null : Math.round(fact.rep * 10) / 10, underReputationLimit: fact.lowRep, warmupOff: fact.warmupOff, warmupBlocked: fact.warmupBlocked },
    setup: { nameserversAnswering: fact.nameserversAnswering, spf: fact.dnsSpf, dkim: fact.dnsDkim, dmarc: fact.dnsDmarc, mx: fact.dnsMx, blockLists: fact.listed },
    week1: weeks[0], week2: weeks[1], week3: weeks[2], week4: weeks[3],
    bounces7: counts("last7"),
    bounces28: counts("last28"),
    peers: { client: peerGroup("client"), tag: peerGroup("tag"), all: peerGroup("all") },
    gaps: {
      humanRepliesVsClient: versus("client", "human"), bouncesVsClient: versus("client", "bounces"),
      humanRepliesVsTag: versus("tag", "human"), bouncesVsTag: versus("tag", "bounces"),
      humanRepliesVsAll: versus("all", "human"), bouncesVsAll: versus("all", "bounces"),
      humanRepliesThisWeekVsBefore: gapBetween(weeks[0].humanReplies, weeks[0].sent, before.human, before.sent),
      bouncesThisWeekVsBefore: gapBetween(weeks[0].bounces, weeks[0].sent, before.bounces, before.sent),
    },
    rules: {
      problems: (queue?.problems ?? []).map((p) => `${p.label}: ${p.evidence}`),
      replaceCall: input.replace?.call ?? null, replaceReasons: input.replace?.reasons ?? [], tagNotes: input.replace?.tagNotes ?? [],
    },
    statusChanges: input.changes,
  };
}

export const sent28 = (f: DiagnosisFacts) => f.week1.sent + f.week2.sent + f.week3.sent + f.week4.sent;

/**
 * Answers that need no AI, so they cost nothing: a domain that isn't in use, or
 * has sent too little to judge. Any problem the rules can already see is still shown.
 */
export function answerWithoutAi(fact: FixFact | null, facts: DiagnosisFacts | null): Diagnosis | null {
  const base = { confidence: "high" as const, action: "wait_for_data" as const, cannotSee: [] };
  if (!fact || !facts) {
    return { ...base, verdict: "not_enough_data", headline: "This domain isn't in use, so there's nothing to judge yet.", reasons: [], next: "Run this again once it's sending.", wouldChange: `At least ${RULES.minSent} emails sent.` };
  }
  const sent = sent28(facts);
  if (sent >= RULES.minSent) return null;
  const top = fixQueue([fact]).items[0]?.top;
  const problems = problemsOf(fact);
  return {
    ...base,
    verdict: "not_enough_data",
    action: top ? "fix_setup" : "wait_for_data",
    headline: `It has sent ${sent} email${sent === 1 ? "" : "s"} in 28 days, too few to judge how it performs.`,
    reasons: facts.rules.problems.map((claim, i) => ({ claim, facts: resolveFacts([`rules.problems.${i}`], facts) })),
    next: top && problems.length ? top.next : "Run this again once it has sent more.",
    wouldChange: `At least ${RULES.minSent} emails sent.`,
  };
}

const GROUP_LABELS: Record<string, string> = {
  domain: "", inboxes: "Inboxes", setup: "Setup", week1: "Last 7 days", week2: "7 days before that", week3: "2 weeks before that", week4: "3 weeks before that",
  bounces7: "Bounces, 7 days", bounces28: "Bounces, 28 days", "peers.client": "Client's other domains", "peers.tag": "Same tag", "peers.all": "All live domains", gaps: "Compared",
};
const KEY_LABELS: Record<string, string> = {
  tld: "TLD", ageDays: "Days since bought", daysInSmartlead: "Days in Smartlead", daysToExpiry: "Days to expiry", autoRenew: "Auto-renew",
  capacityPerDay: "Can send a day", lostCapacityPerDay: "Lost a day", avgReputation: "Average reputation", underReputationLimit: `Under ${RULES.lowRep} reputation`,
  warmupOff: "Warm-up off", warmupBlocked: "Warm-up blocked", nameserversAnswering: "Nameservers answering", spf: "SPF", dkim: "DKIM", dmarc: "DMARC", mx: "MX", blockLists: "Block lists",
  sent: "Sent", daysSent: "Days sending", humanReplies: "Human replies", allReplies: "All replies", ooo: "Out of office", bounces: "Bounces", humanReplyRate: "Human reply rate", bounceRate: "Bounce rate",
  domains: "Domains", sent28: "Sent, 28 days", humanReplyRate28: "Human reply rate, 28 days", bounceRate28: "Bounce rate, 28 days", humanReplyRateWeek1: "Human reply rate, last 7 days", humanReplyRateWeek2: "Human reply rate, 7 days before",
  humanRepliesVsClient: "Human replies against the client", bouncesVsClient: "Bounces against the client", humanRepliesVsTag: "Human replies against the same tag", bouncesVsTag: "Bounces against the same tag",
  humanRepliesVsAll: "Human replies against all domains", bouncesVsAll: "Bounces against all domains", humanRepliesThisWeekVsBefore: "Human replies, this week against before", bouncesThisWeekVsBefore: "Bounces, this week against before",
};
const words = (s: string) => { const w = s.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase(); return w[0].toUpperCase() + w.slice(1); };

export function factLabel(path: string) {
  const parts = path.split(".");
  if (parts[0] === "rules") return parts[1] === "replaceCall" ? "Replace rules: call" : parts[1] === "replaceReasons" ? "Replace rules" : parts[1] === "tagNotes" ? "Its whole tag" : "Rule check";
  if (parts[0] === "statusChanges") return "Status change";
  const group = parts[0] === "peers" ? `peers.${parts[1]}` : parts[0];
  const key = parts[parts.length - 1];
  const name = KEY_LABELS[key] ?? words(key);
  const prefix = GROUP_LABELS[group];
  return prefix ? `${prefix}: ${name.toLowerCase()}` : name;
}

const RATE_KEYS = /rate/i;
function factValue(key: string, v: unknown) {
  if (v == null) return "unknown";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return RATE_KEYS.test(key) ? `${v}%` : v.toLocaleString("en-GB");
  return String(v).replace(/_/g, " ");
}

/** The citations that really exist, each with the value from the facts rather than the AI's copy of it. */
export function resolveFacts(paths: string[], facts: DiagnosisFacts): CitedFact[] {
  const out: CitedFact[] = [];
  for (const path of new Set(paths)) {
    let at: unknown = facts;
    let found = true;
    for (const part of path.split(".")) {
      if (at == null || typeof at !== "object" || !Object.hasOwn(at, part)) { found = false; break; }
      at = (at as Record<string, unknown>)[part];
    }
    if (!found || (at != null && typeof at === "object")) continue;
    out.push({ path, label: factLabel(path), value: factValue(path.split(".").pop()!, at) });
  }
  return out;
}

/** A claim with nothing real behind it is dropped. If nothing is left, it can't be trusted, so it says so. */
/** The card stays readable: the model is asked for the most important few, and any extra are dropped. */
export const MAX_REASONS = 5;

export function checkDiagnosis(raw: DiagnosisRaw, facts: DiagnosisFacts): Diagnosis {
  const reasons = raw.reasons.map((r) => ({ claim: r.claim, facts: resolveFacts(r.facts, facts) })).filter((r) => r.facts.length).slice(0, MAX_REASONS);
  const unbacked = raw.reasons.length > 0 && reasons.length === 0;
  return {
    ...raw,
    reasons,
    confidence: unbacked ? "low" : raw.confidence,
    headline: unbacked ? `${raw.headline} (No claim could be tied to the numbers, so treat this with care.)` : raw.headline,
  };
}

/** Cheap, and good enough to read numbers. Set OPENROUTER_MODEL to use another one. */
export const DEFAULT_DIAGNOSIS_MODEL = "deepseek/deepseek-v4.1-flash-1017";

export const DIAGNOSIS_SYSTEM = `You diagnose one sending domain for a cold email agency. The user will act on your answer, so a wrong call costs real sending volume.

You get a JSON object of facts, already calculated from the agency's own data. It does not name the domain or the client.

How to read the facts:
- week1 is the last 7 days including today, which may be partial. week2 to week4 are the 7-day blocks before it.
- humanReplies are real people replying; allReplies also includes out of office and automatic replies. Rates are percentages of sent.
- bounces7 and bounces28 count bounces by cause: missing (bad address), blocklist, policy, dns, sender (tenant or mailbox), spam, restricted, temporary, full, other.
- peers.client is the client's other live domains, peers.tag is those sharing a tag with this one, and peers.all is every live domain.
- gaps says whether a difference is too big to be chance: below, same, above, or too_little_data. These were calculated with a statistical test. Trust them over your own reading of the rates. Never call a gap real when it says same or too_little_data.
- rules.problems are problems the agency's rule checks have already raised.
- rules.replaceCall is what the agency's replace rules decided from the last 7 days against the other domains it sends with (the same Smartlead tag, or the client's others): Replace now, Replace, Watch, Fix first, List problem, Keep, or Too early to judge. rules.replaceReasons are the numbers behind it. Those rules act only on spam, policy and block list bounces, on replies of any kind, and on block lists. They leave out warm-up reputation, domain age and one domain's human reply rate on purpose: in this agency's own data those did not single out a bad domain, so don't call for a replacement on them alone.
- rules.tagNotes, when there are any, say this domain's whole tag is worse than the client's other domains or every other live domain. Then peers.tag and peers.client are mostly made of those same weak domains, so "same" against them does not clear this domain: it only shows the whole tag shares the problem. For spam, policy and block list bounces, judge it against the healthy-tag comparison in rules.replaceReasons, and against peers.all. Say the tag is likely the bigger problem, but still choose replace when the domain is clearly worse than the healthy tags.
- Say whether the facts support the replace call. Choose the action replace only when they do. If you disagree with the call, cite the fact that contradicts it.
- setup values of null mean not checked, which is not the same as missing.

What makes this useful is telling apart a problem with this domain from a problem with the client, its lists or its copy. If the client's other domains or the same tag fell in the same way, it is probably not this domain, so say so and prefer check_lists over rest or replace.

Rules for your answer:
- Give at most ${MAX_REASONS} reasons, most important first, and only ones that bear on the verdict. Put related facts in one reason: comparing this domain with the client's other domains and with all domains is one reason, not two.
- The statistics are already done. Decide from the gaps rather than recalculating them, and keep your thinking short.
- Every reason must cite in "facts" the exact paths it relies on, such as "week1.bounceRate" or "gaps.humanRepliesVsClient". Only cite paths that exist and hold a single value. Paths inside lists use the index, such as "rules.problems.0".
- Only use numbers that appear in the facts. Don't bring in industry benchmarks from memory.
- A number can show that something happened, not why. Word causes as "probably" or "likely", and set confidence to match. Use high only when several independent facts agree.
- Use not_enough_data and wait_for_data when the numbers can't support a call. That is a good answer. Don't invent reasons.
- healthy is a fine verdict when nothing is wrong. Don't look for problems that aren't there.
- headline: one sentence with the conclusion. Each claim: one short sentence. next: the concrete next step. wouldChange: what result would prove this wrong.
- cannotSee: what you would need but don't have and that matters for this domain, such as inbox placement, list quality or the copy. Leave it empty if nothing would change the call.
- Write in plain English for someone running campaigns. Refer to facts in words, never by their path or field names: write "the last 7 days", not "week1", and "the client's other domains", not "peers.client". Path names belong only in "facts".`;
