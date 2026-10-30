import type { BounceReason } from "./bounces";

// The weekly review's call on each sending domain, with the numbers behind
// it. Shared by server and client. Spam and blocklist rejections count
// against the domain; addresses that don't exist count against the list.

export type Verdict = "fix" | "rest" | "watch" | "idle" | "low" | "ok";

export const VERDICT_META: Record<Verdict, { label: string; tone: "danger" | "warning" | "info" | "faint" | "success"; hint: string }> = {
  fix: { label: "Fix sender", tone: "danger", hint: "Our own setup is failing: tenant or mailbox blocked, DNS missing, or inboxes disconnected" },
  rest: { label: "Rest", tone: "danger", hint: "Spam or blocklist rejections and no human replies: take it out of campaigns for a while" },
  watch: { label: "Watch", tone: "warning", hint: "Early signs (spam rejections, no replies at all, blocklisted) but still worth sending: lower volume" },
  idle: { label: "Idle", tone: "info", hint: "Active, but nothing was sent in this range" },
  low: { label: "Too little sent", tone: "faint", hint: "Not enough sent in this range to judge" },
  ok: { label: "OK", tone: "success", hint: "Nothing to act on" },
};
export const VERDICT_ORDER: Verdict[] = ["fix", "rest", "watch", "idle", "low", "ok"];

/** The thresholds. A domain needs MIN_SENT in the range before it is judged on rates. */
export const RULES = {
  minSent: 50,
  senderBounces: 3,
  restSpam: 10,
  restSpamRate: 1.5,
  restBlocklist: 5,
  watchSpam: 5,
  watchSpamRate: 0.5,
  silentSent: 300,
};

export type ReviewDomain = {
  id: string; name: string; status: string; clientId: string | null; clientName: string | null; clientHue: number | null; tags: string[];
  inboxes: number; disconnected: number; blacklisted: number;
  sent: number; replies: number; human: number; bounces: number;
  causes: Partial<Record<BounceReason, number>>;
  prevSent: number; prevHuman: number; prevSpam: number;
};
export type ReviewCampaign = { id: number; name: string; clientName: string | null; bounces: number; missing: number };
export type ReviewData = { from: string; to: string; today: string; domains: ReviewDomain[]; campaigns: ReviewCampaign[] };
export type Judged = ReviewDomain & { verdict: Verdict; why: string; worse: boolean; spam: number };

const pct = (n: number, d: number) => (d > 0 ? (100 * n) / d : 0);
const p = (v: number) => `${v < 1 ? v.toFixed(2) : v.toFixed(1)}%`;
const n = (v: number) => v.toLocaleString("en-US");
const s = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

export function judge(d: ReviewDomain): Judged {
  const c = d.causes;
  const spam = (c.spam ?? 0) + (c.blocklist ?? 0);
  const rate = pct(spam, d.sent);
  const prevRate = pct(d.prevSpam, d.prevSent);
  // Spam share at least doubled since the same days before.
  const worse = spam >= RULES.watchSpam && d.prevSent >= RULES.minSent && rate >= 2 * prevRate && rate > prevRate;
  const trend = worse ? `, up from ${p(prevRate)}` : "";
  const listed = d.blacklisted ? `, on ${s(d.blacklisted, "blocklist")}` : "";
  const disc = d.disconnected ? `${n(d.disconnected)} of ${n(d.inboxes + d.disconnected)} inboxes disconnected` : "";
  const out = (verdict: Verdict, why: string): Judged => ({ ...d, verdict, why, worse, spam });

  if ((c.sender ?? 0) >= RULES.senderBounces) {
    return out("fix", `${s(c.sender ?? 0, "bounce")} from our own setup (tenant, mailbox or DNS)${disc ? `; ${disc}` : ""}`);
  }
  if (d.status === "active" && d.sent === 0) return out("idle", disc ? `Nothing sent; ${disc}` : "Nothing sent");
  if (d.sent >= RULES.minSent && d.human === 0 &&
      ((spam >= RULES.restSpam && rate >= RULES.restSpamRate) || (c.blocklist ?? 0) >= RULES.restBlocklist)) {
    return out("rest", `${n(spam)} spam/blocklist rejections, ${p(rate)} of ${n(d.sent)} sent${trend}, no human replies${listed}`);
  }
  if (d.sent >= RULES.minSent) {
    if (spam >= RULES.watchSpam && rate >= RULES.watchSpamRate) {
      return out("watch", `${n(spam)} spam/blocklist rejections, ${p(rate)} of sent${trend}; ${s(d.human, "human reply", "human replies")}${listed}`);
    }
    if (d.sent >= RULES.silentSent && d.replies === 0) return out("watch", `${n(d.sent)} sent and no replies at all: may be landing in spam${listed}`);
    if (d.blacklisted) return out("watch", `On ${s(d.blacklisted, "blocklist")} (Smartlead's scan)`);
  }
  if (disc) return out("fix", disc);
  if (d.sent > 0 && d.sent < RULES.minSent) return out("low", `Only ${n(d.sent)} sent`);
  return out("ok", d.sent ? `${p(pct(d.human, d.sent))} human replies, ${p(pct(d.bounces, d.sent))} bounces` : "Not sending");
}

/** Campaigns whose bounces are mostly addresses that don't exist: the list needs re-verifying, not the domains. */
export function badLists(campaigns: ReviewCampaign[]) {
  return campaigns
    .filter((c) => c.missing >= 10 && c.missing >= 0.5 * c.bounces)
    .sort((a, b) => b.missing - a.missing);
}
