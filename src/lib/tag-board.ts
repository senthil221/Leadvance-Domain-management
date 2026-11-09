import type { DomainStatus } from "@/lib/status";
import { isMark, normTag } from "@/lib/tag-map";

// Smartlead → Tags: every client tag with the domains on it and how much they
// can send a day, plus the pool (domains tagged Free or warmup) that tags are
// topped up from to reach their target. Shared by the page and the view.

/** Smartlead tags that hold domains waiting for a client tag. */
export const POOL_TAGS = ["free", "warmup"];
export const isPoolTag = (t: string) => POOL_TAGS.includes(normTag(t));

export type BoardDomain = {
  id: string; name: string; status: DomainStatus; clientName: string | null; clientHue: number | null;
  expiresAt: string | null; graceDaysLeft: number | null; beingReplaced: boolean;
  warmupStartedAt: string | null; warmupDays: number | null; warmupDoneAt: string | null;
  /** Inboxes in Smartlead: connected and disconnected. */
  connected: number; disconnected: number;
  /** Campaign emails a day: the daily limits of the connected inboxes, added up. */
  volume: number; sentToday: number; rep: number | null; ageDays: number | null; esp: string | null;
  senders: { name: string; count: number }[];
  /** Smartlead tags on its inboxes, as spelled there, marks (New, Replaced…) included. */
  tags: string[];
  /** The app's marks on the domain (New, Replaced…). */
  marks: string[];
  campaigns: number[];
};

export type BoardCampaign = { id: number; name: string; status: string | null };

export type BoardTag = {
  key: string; name: string; domains: BoardDomain[];
  /** Free or warmup: domains waiting to go on a client tag. */
  pool: boolean;
  connected: number; disconnected: number; volume: number; sentToday: number; rep: number | null;
  /** The sender name most of its inboxes use. */
  sender: string | null;
  /** The client most of its domains belong to (null on the pool, or with no client yet). */
  client: string | null;
  /** Every client among its domains, most domains first. */
  clients: { name: string; domains: number }[];
  /** Its domains with an inbox under another sender name. */
  offSender: number;
  /** What one connected inbox sends a day here, on average (the limit a domain moved here gets). */
  perInbox: number | null;
  target: number | null;
  /** Campaigns its inboxes are in, with how many of its domains are in each. */
  campaigns: { id: number; domains: number }[];
};

const NO_SENDER = "No sender name";

/** A tag that groups sending domains: any Smartlead tag but the app's marks. */
export const clientTagsOf = (d: BoardDomain) => [...new Map(d.tags.filter((t) => t.trim() && !isMark(t)).map((t) => [normTag(t), t.trim()])).entries()];

/** Where a domain is on its warm-up, or null when it isn't warming. */
export function warmupOf(d: BoardDomain, now = Date.now()) {
  if (!d.warmupStartedAt || d.warmupDoneAt) return null;
  const days = d.warmupDays ?? 18;
  const day = Math.floor((now - new Date(d.warmupStartedAt).getTime()) / 86_400_000) + 1;
  return { day: Math.max(1, day), days, ready: day > days };
}

/**
 * In the pool: tagged Free or warmup and on no client tag, connected in
 * Smartlead, not being replaced or retired. `ready` once its warm-up is done
 * (or it never had one).
 */
export function freeState(d: BoardDomain): { free: boolean; ready: boolean } {
  const tags = clientTagsOf(d).map(([k]) => k);
  const free = d.connected > 0 && tags.some(isPoolTag) && tags.every(isPoolTag) && !d.beingReplaced
    && (d.status === "active" || d.status === "warming");
  const w = warmupOf(d);
  return { free, ready: free && (!w || w.ready) };
}

/** True when the domain's main sender is the tag's sender (names compared loosely). */
export const sameSender = (d: BoardDomain, sender: string | null) =>
  sender != null && d.senders.length > 0 && normTag(d.senders[0].name) === normTag(sender);

/** True when any of its inboxes sends under a name other than the tag's. */
export const senderOff = (d: BoardDomain, sender: string | null) =>
  sender != null && d.senders.some((s) => s.name !== NO_SENDER && normTag(s.name) !== normTag(sender));

/** The tags, each with its domains and totals: client tags biggest first, the pool last. */
export function buildTags(domains: BoardDomain[], targets: Record<string, number>): BoardTag[] {
  const by = new Map<string, { name: string; domains: BoardDomain[] }>();
  for (const d of domains) {
    for (const [key, name] of clientTagsOf(d)) {
      const e = by.get(key) ?? { name, domains: [] };
      e.domains.push(d);
      by.set(key, e);
    }
  }
  // Tags with a target but no domain left still show, so they can be filled.
  for (const key of Object.keys(targets)) if (!by.has(key)) by.set(key, { name: key, domains: [] });
  return [...by.entries()].map(([key, e]) => {
    const senders = new Map<string, number>();
    for (const d of e.domains) for (const s of d.senders) senders.set(s.name, (senders.get(s.name) ?? 0) + s.count);
    const reps = e.domains.filter((d) => d.rep != null);
    const camps = new Map<number, number>();
    for (const d of e.domains) for (const c of d.campaigns) camps.set(c, (camps.get(c) ?? 0) + 1);
    const weight = reps.reduce((a, d) => a + d.connected, 0);
    const connected = e.domains.reduce((a, d) => a + d.connected, 0);
    const volume = e.domains.reduce((a, d) => a + d.volume, 0);
    const sender = [...senders.entries()].filter(([n]) => n !== NO_SENDER).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const pool = isPoolTag(key);
    const byClient = new Map<string, number>();
    for (const d of e.domains) if (d.clientName) byClient.set(d.clientName, (byClient.get(d.clientName) ?? 0) + 1);
    const clients = [...byClient.entries()].map(([name, domains]) => ({ name, domains }))
      .sort((a, b) => b.domains - a.domains || a.name.localeCompare(b.name));
    return {
      key, name: e.name, domains: e.domains, pool,
      connected,
      disconnected: e.domains.reduce((a, d) => a + d.disconnected, 0),
      volume,
      sentToday: e.domains.reduce((a, d) => a + d.sentToday, 0),
      rep: weight ? reps.reduce((a, d) => a + (d.rep ?? 0) * d.connected, 0) / weight : null,
      sender,
      client: pool ? null : clients[0]?.name ?? null,
      clients,
      // The pool has no one sender: every domain in it keeps its own.
      offSender: pool ? 0 : e.domains.filter((d) => senderOff(d, sender)).length,
      perInbox: connected && volume ? Math.round(volume / connected) : null,
      target: pool ? null : targets[key] ?? null,
      campaigns: [...camps.entries()].map(([id, domains]) => ({ id, domains })).sort((a, b) => b.domains - a.domains),
    };
  }).sort((a, b) => Number(a.pool) - Number(b.pool) || b.volume - a.volume || a.name.localeCompare(b.name));
}

/** What a pool domain will send a day on a tag: its inboxes at the tag's limit, or its own limits if the tag has none yet. */
export const volumeOn = (d: BoardDomain, perInbox: number | null) => (perInbox ? d.connected * perInbox : d.volume);

/**
 * Picks warmed-up pool domains to reach `need` more a day: the tag's sender
 * first, then the best reputation, then the most volume.
 */
export function fillPick(pool: BoardDomain[], sender: string | null, need: number, perInbox: number | null = null): string[] {
  if (need <= 0) return [];
  const order = [...pool].filter((d) => freeState(d).ready && volumeOn(d, perInbox) > 0).sort((a, b) =>
    Number(sameSender(b, sender)) - Number(sameSender(a, sender)) || (b.rep ?? 0) - (a.rep ?? 0)
    || volumeOn(b, perInbox) - volumeOn(a, perInbox) || a.name.localeCompare(b.name));
  const out: string[] = [];
  let got = 0;
  for (const d of order) {
    if (got >= need) break;
    out.push(d.id);
    got += volumeOn(d, perInbox);
  }
  return out;
}

export type FillStep = {
  tag: BoardTag; domains: BoardDomain[]; adds: number; after: number;
  /** Campaigns the added inboxes join: those at least half the tag's domains are in. */
  campaignIds: number[];
};

/** The tag's campaigns most of its domains are in: where a domain added to it should go too. */
export const mainCampaigns = (t: BoardTag) => t.campaigns.filter((c) => c.domains * 2 >= t.domains.length).map((c) => c.id);

/**
 * Tops up every client tag below its target from the pool, the biggest
 * shortfall first, each pool domain used once.
 */
export function fillPlan(tags: BoardTag[], pool: BoardDomain[]): FillStep[] {
  const left = new Map(pool.map((d) => [d.id, d]));
  const short = tags.filter((t) => !t.pool && t.target && t.target > t.volume)
    .sort((a, b) => (b.target! - b.volume) - (a.target! - a.volume) || a.name.localeCompare(b.name));
  const steps: FillStep[] = [];
  for (const t of short) {
    const ids = fillPick([...left.values()], t.sender, t.target! - t.volume, t.perInbox);
    if (!ids.length) continue;
    const domains = ids.map((id) => left.get(id)!);
    for (const id of ids) left.delete(id);
    const adds = domains.reduce((a, d) => a + volumeOn(d, t.perInbox), 0);
    steps.push({ tag: t, domains, adds, after: t.volume + adds, campaignIds: mainCampaigns(t) });
  }
  return steps;
}

/** Saved volume targets: settings key tag_targets, { "tag": emails a day }. */
export function parseTargets(v: unknown): Record<string, number> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>)
    .filter(([k, n]) => k.trim() && typeof n === "number" && Number.isFinite(n) && n > 0)
    .map(([k, n]) => [normTag(k), Math.round(n as number)]));
}
