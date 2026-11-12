import { BOUNCE_ORDER, bounceLine, type BounceReason } from "./bounces";

// One domain's bounces in a range, for Performance: how many of each cause,
// what the receiving servers actually said (similar notices counted
// together) and which campaigns they came from.

export type BounceDetail = {
  total: number;
  causes: { cause: BounceReason; n: number }[];
  lines: { cause: BounceReason; line: string; n: number; last: string }[];
  campaigns: { id: number | null; name: string; n: number; missing: number }[];
};

export type BounceEvent = { cause: string | null; text: string | null; remote: string | null; campaignId: number | null; campaignName: string | null; at: Date };

/** The notice with its addresses, ids and numbers blanked, so the same rejection reads as one line. */
export function lineKey(line: string) {
  return line.toLowerCase()
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "@")
    .replace(/\[[^\]]*\]|\([^)]*\)/g, "")
    .replace(/\b[0-9a-f]{8,}\b|\b\d[\d.:-]*\b/g, "#")
    .replace(/\s+/g, " ").trim();
}

export function summarizeBounces(events: BounceEvent[]): BounceDetail {
  const causes = new Map<BounceReason, number>();
  const lines = new Map<string, { cause: BounceReason; line: string; n: number; last: string }>();
  const camps = new Map<string, { id: number | null; name: string; n: number; missing: number }>();
  for (const e of events) {
    const cause = (BOUNCE_ORDER.includes(e.cause as BounceReason) ? e.cause : "other") as BounceReason;
    causes.set(cause, (causes.get(cause) ?? 0) + 1);
    const line = bounceLine(e.text, e.remote) ?? "No notice text";
    const k = `${cause}|${lineKey(line)}`;
    const l = lines.get(k) ?? { cause, line, n: 0, last: e.at.toISOString() };
    l.n++;
    if (e.at.toISOString() > l.last) l.last = e.at.toISOString();
    lines.set(k, l);
    const ck = String(e.campaignId ?? e.campaignName ?? "");
    const c = camps.get(ck) ?? { id: e.campaignId, name: e.campaignName ?? "No campaign", n: 0, missing: 0 };
    c.n++;
    if (cause === "missing") c.missing++;
    camps.set(ck, c);
  }
  return {
    total: events.length,
    causes: [...causes].map(([cause, n]) => ({ cause, n })).sort((a, b) => b.n - a.n || BOUNCE_ORDER.indexOf(a.cause) - BOUNCE_ORDER.indexOf(b.cause)),
    lines: [...lines.values()].sort((a, b) => b.n - a.n || b.last.localeCompare(a.last)).slice(0, 12),
    campaigns: [...camps.values()].sort((a, b) => b.n - a.n).slice(0, 8),
  };
}
