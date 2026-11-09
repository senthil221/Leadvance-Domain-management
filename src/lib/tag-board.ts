import type { DomainStatus } from "@/lib/status";
import { isMark, normTag } from "@/lib/tag-map";

// Smartlead → Tags: every client tag with the domains on it and how much they
// can send a day, plus the free domains (no tag yet) that can be pushed onto a
// tag to reach its volume. Shared by the page (server) and the view (client).

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
  connected: number; disconnected: number; volume: number; sentToday: number; rep: number | null;
  /** The sender name most of its inboxes use. */
  sender: string | null;
  target: number | null;
  /** Campaigns its inboxes are in, with how many of its domains are in each. */
  campaigns: { id: number; domains: number }[];
};

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
 * Free: connected in Smartlead, on no client tag yet, not being replaced or
 * retired. `ready` once its warm-up is done (or it never had one).
 */
export function freeState(d: BoardDomain): { free: boolean; ready: boolean } {
  const free = d.connected > 0 && clientTagsOf(d).length === 0 && !d.beingReplaced
    && (d.status === "active" || d.status === "warming");
  const w = warmupOf(d);
  return { free, ready: free && (!w || w.ready) };
}

/** The tags, each with its domains and totals, biggest first. */
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
    return {
      key, name: e.name, domains: e.domains,
      connected: e.domains.reduce((a, d) => a + d.connected, 0),
      disconnected: e.domains.reduce((a, d) => a + d.disconnected, 0),
      volume: e.domains.reduce((a, d) => a + d.volume, 0),
      sentToday: e.domains.reduce((a, d) => a + d.sentToday, 0),
      rep: weight ? reps.reduce((a, d) => a + (d.rep ?? 0) * d.connected, 0) / weight : null,
      sender: [...senders.entries()].filter(([n]) => n !== "No sender name").sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      target: targets[key] ?? null,
      campaigns: [...camps.entries()].map(([id, domains]) => ({ id, domains })).sort((a, b) => b.domains - a.domains),
    };
  }).sort((a, b) => b.volume - a.volume || a.name.localeCompare(b.name));
}

/** True when the domain's main sender is the tag's sender (names compared loosely). */
export const sameSender = (d: BoardDomain, sender: string | null) =>
  sender != null && d.senders.length > 0 && normTag(d.senders[0].name) === normTag(sender);

/**
 * Picks free, warmed-up domains to reach `need` more a day: the tag's sender
 * first, then the best reputation, then the most volume.
 */
export function fillPick(free: BoardDomain[], sender: string | null, need: number): string[] {
  if (need <= 0) return [];
  const order = [...free].filter((d) => freeState(d).ready && d.volume > 0).sort((a, b) =>
    Number(sameSender(b, sender)) - Number(sameSender(a, sender)) || (b.rep ?? 0) - (a.rep ?? 0) || b.volume - a.volume || a.name.localeCompare(b.name));
  const out: string[] = [];
  let got = 0;
  for (const d of order) {
    if (got >= need) break;
    out.push(d.id);
    got += d.volume;
  }
  return out;
}

/** Saved volume targets: settings key tag_targets, { "tag": emails a day }. */
export function parseTargets(v: unknown): Record<string, number> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>)
    .filter(([k, n]) => k.trim() && typeof n === "number" && Number.isFinite(n) && n > 0)
    .map(([k, n]) => [normTag(k), Math.round(n as number)]));
}
