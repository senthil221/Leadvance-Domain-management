import { BOUNCE_META, BOUNCE_ORDER, type BounceReason } from "./bounces";
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
  prevSent: number; prevReplies: number; prevHuman: number; prevBounces: number;
  rep: number | null; ageDays: number | null; connectedDays: number | null;
};

const mean = (v: (number | null)[]) => {
  const k = v.filter((x): x is number => x != null);
  return k.length ? k.reduce((a, b) => a + b, 0) / k.length : null;
};

export function summarize(key: string, label: string, rows: ReviewDomain[]): Group {
  const g: Group = {
    key, label, rows, domains: rows.length, inboxes: 0, sent: 0, replies: 0, real: 0, human: 0, ooo: 0, auto: 0, negative: 0, bounces: 0, spam: 0, causes: {},
    prevSent: 0, prevReplies: 0, prevHuman: 0, prevBounces: 0,
    rep: mean(rows.map((d) => d.rep)), ageDays: mean(rows.map((d) => d.ageDays)), connectedDays: mean(rows.map((d) => d.connectedDays)),
  };
  for (const d of rows) {
    g.inboxes += d.inboxes; g.sent += d.sent; g.replies += d.replies; g.human += d.human; g.ooo += d.ooo; g.auto += d.auto; g.negative += d.negative; g.bounces += d.bounces;
    g.real += Math.max(0, d.replies - d.ooo - d.auto);
    g.spam += (d.causes.spam ?? 0) + (d.causes.blocklist ?? 0);
    g.prevSent += d.prevSent; g.prevReplies += d.prevReplies; g.prevHuman += d.prevHuman; g.prevBounces += d.prevBounces;
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

export type BounceMix = { cause: BounceReason; n: number; share: number };
export function bounceMix(g: Pick<Group, "causes">): BounceMix[] {
  const total = Object.values(g.causes).reduce((a, b) => a + (b ?? 0), 0);
  return BOUNCE_ORDER.filter((c) => g.causes[c]).map((cause) => ({ cause, n: g.causes[cause] ?? 0, share: total ? (100 * (g.causes[cause] ?? 0)) / total : 0 })).sort((a, b) => b.n - a.n);
}

export type Finding = {
  id: string; dim: Dim; groupKey: string; tone: "danger" | "warning" | "success";
  title: string; /** The plain answer: is it this group, its age, or its lists? */ verdict: string; detail: string[]; score: number;
};

const sameBand = (a: ReviewDomain, g: Group) => g.rows.some((x) => ageBand(x.ageDays) === ageBand(a.ageDays));
const sameClient = (a: ReviewDomain, g: Group) => g.rows.some((x) => (x.clientId ?? "") === (a.clientId ?? ""));

/** Work out why a group's bounces stand out: compare with other domains of the same age and the same clients. */
function explainBounce(g: Group, others: ReviewDomain[], dim: Dim): { verdict: string; detail: string[] } {
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

  let verdict: string;
  if (concentrated) verdict = `Not all of ${g.label}: a few domains cause most of it. Look at those first.`;
  else if (ageRate != null && rate < ageRate * 1.25) verdict = `More likely their age than ${g.label}: other domains this new bounce about the same.`;
  else if (clientRate != null && rate < clientRate * 1.25) verdict = `More likely the lists than ${g.label}: the same clients' other domains bounce about the same.`;
  else if (top?.cause === "missing" && top.share >= 50) verdict = `Mostly addresses that don't exist, so check the lists these domains were given before blaming ${g.label}.`;
  else if (ageRate == null && clientRate == null) verdict = `No other domains of the same age or clients to compare with, so this can't be pinned on ${g.label} yet.`;
  else if (ageRate != null && clientRate != null) verdict = `Looks specific to ${g.label}: domains of the same age and clients bounce less.`;
  else if (clientRate != null) verdict = `Looks specific to ${g.label}: the same clients' other domains bounce less.`;
  else verdict = `Looks specific to ${g.label}: other domains of the same age bounce less.`;
  return { verdict, detail };
}

/**
 * What stands out against everything else, strongest first: groups whose bounce
 * or human reply rate differs by a lot on enough volume to rule out chance.
 */
export function findings(domains: ReviewDomain[], dims: Dim[] = ["tld", "provider", "age", "connected", "tag"], limit = 5): Finding[] {
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
        const { verdict, detail } = explainBounce(g, others, dim);
        out.push({
          id: `${dim}:${g.key}:bounce`, dim, groupKey: g.key, tone: br >= 3 ? "danger" : "warning",
          title: `${g.label} bounces ${P(br)}, everything else ${P(rb)}`, verdict, detail, score: bz + 1, ids: inGroup, label: g.label,
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
          score: Math.abs(hz), ids: inGroup, label: g.label,
        });
      }
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
