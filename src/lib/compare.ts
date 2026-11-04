import { BOUNCE_META, BOUNCE_ORDER, type BounceReason } from "./bounces";
import type { CompareDay } from "./queries";
import { addDays, daysBetween } from "./range";
import { espName, type ReviewDomain } from "./review";

// Comparing groups of domains: by TLD, provider, mail type, tag, client or age,
// with everything a decision needs side by side, and a plain answer to "is this
// only these domains, or across the board?". Shared by server and client.

export type Dim = "tld" | "provider" | "esp" | "tag" | "client" | "age" | "connected";
export const DIM_META: Record<Dim, { label: string; all: string }> = {
  tld: { label: "TLD", all: "All TLDs" },
  provider: { label: "Provider", all: "All providers" },
  esp: { label: "ESP", all: "All ESPs" },
  tag: { label: "Tag", all: "All tags" },
  client: { label: "Client", all: "All clients" },
  age: { label: "Domain age", all: "Any domain age" },
  connected: { label: "Time in Smartlead", all: "Any time in Smartlead" },
};
export const DIMS = Object.keys(DIM_META) as Dim[];

const AGE_BANDS: [number, string][] = [[30, "Under 30 days"], [90, "30 to 90 days"], [180, "3 to 6 months"], [365, "6 to 12 months"], [Infinity, "Over a year"]];
const CONNECTED_BANDS: [number, string][] = [[14, "Under 2 weeks"], [30, "2 to 4 weeks"], [60, "1 to 2 months"], [90, "2 to 3 months"], [Infinity, "Over 3 months"]];
const band = (days: number | null, bands: [number, string][]) => (days == null ? "Unknown" : bands.find(([top]) => days < top)![1]);
export const ageBand = (days: number | null) => band(days, AGE_BANDS);
export const connectedBand = (days: number | null) => band(days, CONNECTED_BANDS);

/** The groups a domain sits in. Only tags can be more than one: it counts under each. */
export function keysOf(d: ReviewDomain, dim: Dim): { key: string; label: string }[] {
  switch (dim) {
    case "tld": return [{ key: d.tld ?? "?", label: d.tld ? `.${d.tld}` : "No TLD" }];
    case "provider": return [{ key: d.provider ?? "?", label: d.provider ?? "No provider" }];
    case "esp": return [{ key: espName(d.esp), label: espName(d.esp) }];
    case "client": return [{ key: d.clientId ?? "", label: d.clientName ?? "No client" }];
    case "age": { const b = ageBand(d.ageDays); return [{ key: b, label: b }]; }
    case "connected": { const b = connectedBand(d.connectedDays); return [{ key: b, label: b }]; }
    case "tag": {
      const seen = new Map<string, string>();
      for (const t of [...d.tags, ...d.slTags]) if (t.trim() && !seen.has(t.trim().toLowerCase())) seen.set(t.trim().toLowerCase(), t.trim());
      return seen.size ? [...seen].map(([key, label]) => ({ key, label })) : [{ key: "", label: "No tag" }];
    }
  }
}

export type Group = {
  key: string; label: string; rows: ReviewDomain[]; domains: number; inboxes: number;
  sent: number; replies: number; /** Replies without out of office and auto-replies. */ real: number; human: number; ooo: number; auto: number; negative: number;
  bounces: number; /** Spam and blocklist rejections. */ spam: number; causes: Partial<Record<BounceReason, number>>;
  prevSent: number; prevReplies: number; prevHuman: number; prevBounces: number; prevSpam: number;
  rep: number | null; ageDays: number | null; connectedDays: number | null;
};

const mean = (v: (number | null)[]) => {
  const k = v.filter((x): x is number => x != null);
  return k.length ? k.reduce((a, b) => a + b, 0) / k.length : null;
};

export function summarize(key: string, label: string, rows: ReviewDomain[]): Group {
  const g: Group = {
    key, label, rows, domains: rows.length, inboxes: 0, sent: 0, replies: 0, real: 0, human: 0, ooo: 0, auto: 0, negative: 0, bounces: 0, spam: 0, causes: {},
    prevSent: 0, prevReplies: 0, prevHuman: 0, prevBounces: 0, prevSpam: 0,
    rep: mean(rows.map((d) => d.rep)), ageDays: mean(rows.map((d) => d.ageDays)), connectedDays: mean(rows.map((d) => d.connectedDays)),
  };
  for (const d of rows) {
    g.inboxes += d.inboxes; g.sent += d.sent; g.replies += d.replies; g.human += d.human; g.ooo += d.ooo; g.auto += d.auto; g.negative += d.negative; g.bounces += d.bounces;
    g.real += Math.max(0, d.replies - d.ooo - d.auto);
    g.spam += (d.causes.spam ?? 0) + (d.causes.blocklist ?? 0);
    g.prevSent += d.prevSent; g.prevReplies += d.prevReplies; g.prevHuman += d.prevHuman; g.prevBounces += d.prevBounces; g.prevSpam += d.prevSpam;
    for (const [k, v] of Object.entries(d.causes) as [BounceReason, number][]) g.causes[k] = (g.causes[k] ?? 0) + v;
  }
  return g;
}

/** Every group of a dimension: age bands youngest first, the rest biggest first. */
export function groupsBy(domains: ReviewDomain[], dim: Dim): Group[] {
  const m = new Map<string, { label: string; rows: ReviewDomain[] }>();
  for (const d of domains) {
    for (const k of keysOf(d, dim)) {
      const e = m.get(k.key) ?? { label: k.label, rows: [] };
      e.rows.push(d);
      m.set(k.key, e);
    }
  }
  const list = [...m].map(([key, e]) => summarize(key, e.label, e.rows));
  const bands = dim === "age" ? AGE_BANDS : dim === "connected" ? CONNECTED_BANDS : null;
  if (bands) {
    const at = (g: Group) => { const i = bands.findIndex(([, l]) => l === g.key); return i < 0 ? 99 : i; };
    return list.sort((a, b) => at(a) - at(b));
  }
  return list.sort((a, b) => b.sent - a.sent || a.label.localeCompare(b.label));
}

export const pct = (n: number, d: number) => (d > 0 ? (100 * n) / d : null);

/** Enough sent for a rate to mean anything. */
export const MIN_SENT = 300;
const MIN_DOMAIN_SENT = 50;
const P = (v: number) => `${v < 1 ? v.toFixed(2) : v.toFixed(1)}%`;

/** Two-proportion z-test: how many standard errors apart two rates are. Over 2.6 is rarely chance. */
export function zScore(a: number, an: number, b: number, bn: number) {
  if (!an || !bn) return 0;
  const p = (a + b) / (an + bn);
  const se = Math.sqrt(p * (1 - p) * (1 / an + 1 / bn));
  return se ? (a / an - b / bn) / se : 0;
}

/** The range a rate could really be in, given how little was sent: a 95% Wilson interval, in percent. */
export function wilson(k: number, n: number, z = 1.96): [number, number] | null {
  if (!n) return null;
  const p = k / n, d = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, 100 * (mid - half)), Math.min(100, 100 * (mid + half))];
}

export type MetricKey = "human" | "real" | "bounce" | "spam" | "sent" | "rep";
export type MetricDef = {
  label: string; hint: string;
  /** Higher is better (1), lower is better (-1), or neither (0). */ better: 1 | -1 | 0;
  kind: "rate" | "count" | "score";
  count: (g: Group) => number;
};
export const METRICS: Record<MetricKey, MetricDef> = {
  human: { label: "Human replies", hint: "Replies from a real person, per email sent", better: 1, kind: "rate", count: (g) => g.human },
  real: { label: "Replies without OOO", hint: "Every reply except out of offices and auto-replies, per email sent", better: 1, kind: "rate", count: (g) => g.real },
  bounce: { label: "Bounce rate", hint: "Bounces per email sent", better: -1, kind: "rate", count: (g) => g.bounces },
  spam: { label: "Spam and blocks", hint: "Bounces that were spam or block list rejections, per email sent", better: -1, kind: "rate", count: (g) => g.spam },
  sent: { label: "Sent", hint: "Emails sent", better: 0, kind: "count", count: (g) => g.sent },
  rep: { label: "Reputation", hint: "Smartlead warm-up reputation, averaged over the domains", better: 1, kind: "score", count: () => 0 },
};
export const METRIC_KEYS = Object.keys(METRICS) as MetricKey[];

export function metricValue(g: Group, key: MetricKey): number | null {
  const m = METRICS[key];
  return m.kind === "rate" ? pct(m.count(g), g.sent) : m.kind === "count" ? g.sent : g.rep;
}
export const formatMetric = (v: number | null, key: MetricKey) =>
  v == null ? "—" : METRICS[key].kind === "rate" ? P(v) : METRICS[key].kind === "score" ? v.toFixed(0) : Math.round(v).toLocaleString("en-US");

export type Standing2 = "ahead" | "behind" | "level" | "low" | "none";
/**
 * Where a group stands against every other domain in view: ahead or behind only
 * when the gap is too big to be chance and big enough to matter.
 */
export function standAgainst(g: Group, all: Group, key: MetricKey): { state: Standing2; z: number } {
  const m = METRICS[key];
  if (m.kind !== "rate" || !m.better) return { state: "none", z: 0 };
  if (g.sent < MIN_SENT) return { state: "low", z: 0 };
  const restSent = all.sent - g.sent;
  if (restSent < MIN_SENT) return { state: "none", z: 0 };
  const k = m.count(g), rk = m.count(all) - k;
  const z = zScore(k, g.sent, rk, restSent);
  const rate = k / g.sent, rest = rk / restSent;
  const big = rate > rest ? rate >= rest * 1.25 : rest >= rate * 1.25;
  if (Math.abs(z) < 2.6 || !big) return { state: "level", z };
  return { state: (z > 0) === (m.better > 0) ? "ahead" : "behind", z };
}

/** The one-sentence answer above the bars. */
export function headline(groups: Group[], all: Group, key: MetricKey): string {
  const m = METRICS[key];
  if (m.kind !== "rate") {
    if (!groups.length) return "Pick something to compare";
    const vals = groups.map((g) => ({ g, v: metricValue(g, key) })).filter((x) => x.v != null).sort((a, b) => b.v! - a.v!);
    if (!vals.length) return `No ${m.label.toLowerCase()} numbers for these yet`;
    return `${vals[0].g.label} is highest at ${formatMetric(vals[0].v, key)}${vals.length > 1 ? `, ${vals.at(-1)!.g.label} lowest at ${formatMetric(vals.at(-1)!.v, key)}` : ""}`;
  }
  const rated = groups.map((g) => ({ g, s: standAgainst(g, all, key), v: metricValue(g, key) ?? 0 }));
  const enough = rated.filter((r) => r.s.state !== "low" && r.s.state !== "none");
  if (!enough.length) return `Too little sent to call any of these on ${m.label.toLowerCase()}: ${int2(MIN_SENT)}+ sent is needed`;
  const name = (l: typeof rated) => l.slice(0, 2).map((r) => r.g.label).join(" and ") + (l.length > 2 ? ` and ${l.length - 2} more` : "");
  const byBest = (a: (typeof rated)[number], b: (typeof rated)[number]) => (b.v - a.v) * m.better;
  const ahead = rated.filter((r) => r.s.state === "ahead").sort(byBest), behind = rated.filter((r) => r.s.state === "behind").sort((a, b) => byBest(b, a));
  const average = formatMetric(metricValue(all, key), key);
  if (ahead.length && behind.length) return `${name(ahead)} ${ahead.length === 1 ? "is" : "are"} clearly ahead on ${m.label.toLowerCase()}, ${name(behind)} clearly behind (everything in view: ${average})`;
  if (ahead.length) return `${name(ahead)} ${ahead.length === 1 ? "is" : "are"} clearly ahead on ${m.label.toLowerCase()} (everything in view: ${average})`;
  if (behind.length) return `${name(behind)} ${behind.length === 1 ? "is" : "are"} clearly behind on ${m.label.toLowerCase()} (everything in view: ${average})`;
  return `No clear winner on ${m.label.toLowerCase()}: the gaps could be chance`;
}
const int2 = (n: number) => n.toLocaleString("en-US");

export type TrendBucket = { from: string; to: string };
export type TrendSeries = { key: string; values: (number | null)[]; sent: number[] };
/** Below this a day's rate is noise, so the line skips it. */
export const MIN_BUCKET_SENT = 20;

/** Daily points, weekly once the range is long enough for days to be unreadable. */
export function trendBuckets(from: string, to: string): TrendBucket[] {
  const days = daysBetween(from, to) + 1, size = days > 45 ? 7 : 1;
  const out: TrendBucket[] = [];
  for (let d = from; d <= to; d = addDays(d, size)) {
    const end = addDays(d, size - 1);
    out.push({ from: d, to: end > to ? to : end });
  }
  return out;
}

/** The metric for each group per bucket. A domain in two groups (tags) counts in both. */
export function trendSeries(daily: CompareDay[], groups: { key: string; ids: Set<string> }[], key: MetricKey, buckets: TrendBucket[]): TrendSeries[] {
  const index = new Map(buckets.map((b, i) => [b.from, i]));
  const at = (day: string) => {
    if (index.has(day)) return index.get(day)!;
    for (let i = buckets.length - 1; i >= 0; i--) if (buckets[i].from <= day && day <= buckets[i].to) return i;
    return -1;
  };
  const byDomain = new Map<string, { i: number; d: CompareDay }[]>();
  for (const d of daily) {
    const i = at(d.day);
    if (i < 0) continue;
    const e = byDomain.get(d.domainId);
    if (e) e.push({ i, d }); else byDomain.set(d.domainId, [{ i, d }]);
  }
  return groups.map((g) => {
    const sent = buckets.map(() => 0), num = buckets.map(() => 0), repSum = buckets.map(() => 0), repN = buckets.map(() => 0);
    for (const id of g.ids) {
      for (const { i, d } of byDomain.get(id) ?? []) {
        sent[i] += d.sent;
        if (key === "human") num[i] += d.human;
        else if (key === "real") num[i] += Math.max(0, d.replies - d.ooo - d.auto);
        else if (key === "bounce") num[i] += d.bounces;
        else if (key === "spam") num[i] += d.blocked;
        if (d.rep != null) { repSum[i] += d.rep; repN[i]++; }
      }
    }
    const kind = METRICS[key].kind;
    const values = buckets.map((_, i) => kind === "count" ? sent[i] : kind === "score" ? (repN[i] ? repSum[i] / repN[i] : null) : sent[i] >= MIN_BUCKET_SENT ? (100 * num[i]) / sent[i] : null);
    return { key: g.key, values, sent };
  });
}

export type BounceMix = { cause: BounceReason; n: number; share: number };
export function bounceMix(g: Pick<Group, "causes">): BounceMix[] {
  const total = Object.values(g.causes).reduce((a, b) => a + (b ?? 0), 0);
  return BOUNCE_ORDER.filter((c) => g.causes[c]).map((cause) => ({ cause, n: g.causes[cause] ?? 0, share: total ? (100 * (g.causes[cause] ?? 0)) / total : 0 })).sort((a, b) => b.n - a.n);
}

export type Finding = {
  id: string; tone: "danger" | "warning" | "success";
  /** The group it's about, when it's about one. */ dim?: Dim; groupKey?: string;
  title: string; /** The plain answer: is it this group, its age, or its lists? */ verdict: string; detail: string[]; score: number;
  /** What to do about it. */ action: string;
  /** How sure: only set when it rests on a statistical test. */ sure?: string;
  /** The domains behind it. */ domainIds: string[];
  /** A page that answers it better than this one. */ href?: string;
};

const sureOf = (z: number) => (Math.abs(z) >= 3.3 ? "Far too big to be chance" : "Very unlikely to be chance");

const sameBand = (a: ReviewDomain, g: Group) => g.rows.some((x) => ageBand(x.ageDays) === ageBand(a.ageDays));
const sameClient = (a: ReviewDomain, g: Group) => g.rows.some((x) => (x.clientId ?? "") === (a.clientId ?? ""));

/** Work out why a group's bounces stand out: compare with other domains of the same age and the same clients. */
function explainBounce(g: Group, others: ReviewDomain[], dim: Dim): { verdict: string; detail: string[]; action: string } {
  const rate = pct(g.bounces, g.sent) ?? 0;
  const detail: string[] = [];
  const domains = g.rows.filter((d) => d.sent >= MIN_DOMAIN_SENT);
  const rest = summarize("", "", others);
  const line = (pct(rest.bounces, rest.sent) ?? 0) * 1.5;
  const high = domains.filter((d) => (pct(d.bounces, d.sent) ?? 0) >= line);
  const worst = [...g.rows].sort((a, b) => b.bounces - a.bounces);
  const topTwo = (worst[0]?.bounces ?? 0) + (worst[1]?.bounces ?? 0);
  if (domains.length) detail.push(`${high.length} of ${domains.length} sending domains are above ${P(line)}`);
  const concentrated = g.rows.length >= 4 && g.bounces > 0 && topTwo / g.bounces >= 0.6;
  if (concentrated) detail.push(`${worst.slice(0, 2).map((d) => d.name).join(" and ")} are ${Math.round((100 * topTwo) / g.bounces)}% of the bounces`);

  const top = bounceMix(g)[0];
  const restTop = top ? bounceMix(rest).find((m) => m.cause === top.cause) : undefined;
  if (top) detail.push(`Top reason: ${BOUNCE_META[top.cause].label} ${Math.round(top.share)}% (other domains ${Math.round(restTop?.share ?? 0)}%)`);

  const age = dim === "age" || dim === "connected" ? null : summarize("", "", others.filter((d) => sameBand(d, g)));
  const client = dim === "client" ? null : summarize("", "", others.filter((d) => sameClient(d, g)));
  const ageRate = age && age.sent >= MIN_SENT ? pct(age.bounces, age.sent) : null;
  const clientRate = client && client.sent >= MIN_SENT ? pct(client.bounces, client.sent) : null;
  if (ageRate != null) detail.push(`Other domains of the same age: ${P(ageRate)}`);
  if (clientRate != null) detail.push(`Other domains of the same clients: ${P(clientRate)}`);

  let verdict: string, action: string;
  if (concentrated) { verdict = `Not all of ${g.label}: a few domains cause most of it. Look at those first.`; action = `Open ${worst[0].name} and ${worst[1].name}, and rest them if the reasons are blocks or spam.`; }
  else if (ageRate != null && rate < ageRate * 1.25) { verdict = `More likely their age than ${g.label}: other domains this new bounce about the same.`; action = "Keep volume low on these until they've aged, rather than dropping the group."; }
  else if (clientRate != null && rate < clientRate * 1.25) { verdict = `More likely the lists than ${g.label}: the same clients' other domains bounce about the same.`; action = "Check the lists these clients are sending to before changing domains."; }
  else if (top?.cause === "missing" && top.share >= 50) { verdict = `Mostly addresses that don't exist, so check the lists these domains were given before blaming ${g.label}.`; action = "Verify the lists on these campaigns before sending more."; }
  else if (ageRate == null && clientRate == null) { verdict = `No other domains of the same age or clients to compare with, so this can't be pinned on ${g.label} yet.`; action = "Watch it another week before acting on it."; }
  else if (ageRate != null && clientRate != null) { verdict = `Looks specific to ${g.label}: domains of the same age and clients bounce less.`; action = `Move volume away from ${g.label}, and don't buy more until it recovers.`; }
  else if (clientRate != null) { verdict = `Looks specific to ${g.label}: the same clients' other domains bounce less.`; action = `Move volume away from ${g.label}, and don't buy more until it recovers.`; }
  else { verdict = `Looks specific to ${g.label}: other domains of the same age bounce less.`; action = `Move volume away from ${g.label}, and don't buy more until it recovers.`; }
  return { verdict, detail, action };
}

const CAUSE_FINDINGS: { cause: BounceReason; title: (n: number, m: number) => string; verdict: string; action: string }[] = [
  {
    cause: "sender",
    title: (n, m) => `${int2(n)} bounces across ${int2(m)} domains come from the tenant or mailbox itself`,
    verdict: "Our side, not the lists: the Microsoft tenant or mailbox is blocked, over its limit or can't sign in.",
    action: "Fix the tenant or mailbox before sending more through them.",
  },
  {
    cause: "dns",
    title: (n, m) => `${int2(n)} bounces across ${int2(m)} domains say the sending domain's DNS is failing`,
    verdict: "Our side, not the lists: receivers couldn't find the domain or verify its records.",
    action: "Check the DNS of these domains first. Everything they send can fail until it's fixed.",
  },
  {
    cause: "blocklist",
    title: (n, m) => `${int2(n)} bounces across ${int2(m)} domains name a block list`,
    verdict: "The domain, its IP or a link in the email is listed, so more volume only makes it worse.",
    action: "Rest these domains, check the listing, and check the links in the copy.",
  },
];

/**
 * What stands out against everything else, strongest first: groups whose bounce
 * or human reply rate differs by a lot on enough volume to rule out chance.
 */
export function findings(domains: ReviewDomain[], dims: Dim[] = ["tld", "provider", "age", "connected", "tag"], limit = 5, opts: {
  /** How far a client's volume has to fall to mention it, or null when the range is too short or unfinished to tell. */ volumeDrop?: number | null;
} = {}): Finding[] {
  const out: (Finding & { ids: Set<string>; label: string })[] = [];
  for (const dim of dims) {
    for (const g of groupsBy(domains, dim)) {
      if (g.sent < MIN_SENT || g.domains < 2 || !g.key) continue;
      const inGroup = new Set(g.rows.map((d) => d.id));
      const others = domains.filter((d) => !inGroup.has(d.id));
      const rest = summarize("", "", others);
      if (rest.sent < MIN_SENT) continue;
      const br = pct(g.bounces, g.sent)!, rb = pct(rest.bounces, rest.sent)!;
      const bz = zScore(g.bounces, g.sent, rest.bounces, rest.sent);
      if (br >= rb * 1.5 && br - rb >= 0.5 && bz >= 2.6) {
        const { verdict, detail, action } = explainBounce(g, others, dim);
        out.push({
          id: `${dim}:${g.key}:bounce`, dim, groupKey: g.key, tone: br >= 3 ? "danger" : "warning",
          title: `${g.label} bounces ${P(br)}, everything else ${P(rb)}`, verdict, detail, action, sure: sureOf(bz), domainIds: [...inGroup], score: bz + 1, ids: inGroup, label: g.label,
        });
      }
      const hr = pct(g.human, g.sent)!, rh = pct(rest.human, rest.sent)!;
      const hz = zScore(g.human, g.sent, rest.human, rest.sent);
      if (Math.abs(hz) >= 2.6 && (hr >= rh * 1.5 || hr * 1.5 <= rh)) {
        const up = hr > rh;
        out.push({
          id: `${dim}:${g.key}:human`, dim, groupKey: g.key, tone: up ? "success" : "warning",
          title: `${g.label} gets ${P(hr)} human replies, everything else ${P(rh)}`,
          verdict: up ? `Worth more volume: ${g.label} is ahead on ${g.sent.toLocaleString("en-US")} sent.` : `${g.label} is behind on ${g.sent.toLocaleString("en-US")} sent: check placement and the lists it was given.`,
          detail: [`${g.domains} domains · ${g.human} human replies`],
          action: up ? `Give ${g.label} more of the volume, and see what its campaigns do differently.` : `Compare its campaigns and lists with the groups ahead of it before sending more through ${g.label}.`,
          sure: sureOf(hz), domainIds: [...inGroup],
          score: Math.abs(hz), ids: inGroup, label: g.label,
        });
      }
      // Against its own past: the same group, the same days before.
      if (g.prevSent >= MIN_SENT) {
        const pb = pct(g.prevBounces, g.prevSent)!;
        const pz = zScore(g.bounces, g.sent, g.prevBounces, g.prevSent);
        if (br >= pb * 1.5 && br - pb >= 0.5 && pz >= 2.6) {
          out.push({
            id: `${dim}:${g.key}:bounce-up`, dim, groupKey: g.key, tone: "warning",
            title: `${g.label}'s bounces went from ${P(pb)} to ${P(br)}`,
            verdict: `Something changed since the same days before: the group itself is the comparison, so it isn't down to what it is.`,
            detail: [`${int2(g.sent)} sent now, ${int2(g.prevSent)} before`, ...bounceMix(g).slice(0, 1).map((m) => `Top reason: ${BOUNCE_META[m.cause].label} ${Math.round(m.share)}%`)],
            action: "Look for a new list or new domains in this group, and check the top reason.",
            sure: sureOf(pz), domainIds: [...inGroup], score: pz, ids: inGroup, label: g.label,
          });
        }
      }
    }
  }
  // What the receiving servers said, whichever group the domains are in.
  const total = domains.reduce((a, d) => a + d.bounces, 0);
  for (const c of CAUSE_FINDINGS) {
    const hit = domains.map((d) => ({ d, n: d.causes[c.cause] ?? 0 })).filter((x) => x.n).sort((a, b) => b.n - a.n);
    const n = hit.reduce((a, x) => a + x.n, 0);
    if (n < 10 || n < 0.03 * total) continue;
    const ids = new Set(hit.map((x) => x.d.id));
    const names = hit.slice(0, 3).map((x) => `${x.d.name} ${int2(x.n)}`).join(", ");
    out.push({
      id: `cause:${c.cause}`, tone: "danger", title: c.title(n, hit.length), verdict: c.verdict, action: c.action,
      detail: [`Most: ${names}`, `${Math.round((100 * n) / total)}% of all bounces in view`], domainIds: [...ids],
      score: 3 + Math.min(n / 40, 6), ids, label: BOUNCE_META[c.cause].label,
    });
  }
  // A client sending much less than the same days before.
  if (opts.volumeDrop != null) {
    for (const g of groupsBy(domains, "client")) {
      if (!g.key || g.prevSent < MIN_SENT || g.sent >= g.prevSent * (1 - opts.volumeDrop)) continue;
      const ids = new Set(g.rows.map((d) => d.id));
      const fell = Math.round((100 * (g.prevSent - g.sent)) / g.prevSent);
      out.push({
        id: `client:${g.key}:volume`, dim: "client", groupKey: g.key, tone: "warning", title: `${g.label} is sending ${fell}% less`,
        verdict: `${int2(g.sent)} sent, ${int2(g.prevSent)} on the same days before.`, detail: [],
        action: "Open the client to see which domains stopped, and whether the promised volume is at risk.",
        href: `/clients/${g.key}`, domainIds: [...ids], score: 2.6 + fell / 25, ids, label: g.label,
      });
    }
  }
  // .info and "Under 30 days" can be the same domains saying the same thing: keep the stronger one and name the other.
  const kept: typeof out = [];
  for (const f of out.sort((a, b) => b.score - a.score)) {
    const twin = kept.find((k) => k.id.split(":").at(-1) === f.id.split(":").at(-1) && [...f.ids].filter((id) => k.ids.has(id)).length >= 0.7 * Math.min(f.ids.size, k.ids.size));
    if (twin) {
      if (!twin.detail.some((x) => x.startsWith("Mostly the same domains as"))) twin.detail.push(`Mostly the same domains as ${f.label}`);
    } else kept.push(f);
  }
  return kept.slice(0, limit);
}
