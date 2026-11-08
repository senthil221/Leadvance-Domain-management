// The short trend tags beside each domain on Performance: how long since its
// last reply, and whether replies, bounces and warmup reputation went up or
// down against the same number of days before. Shared by page and tests.

export type TrendKey = "quiet" | "repliesDown" | "repliesUp" | "bouncesUp" | "bouncesDown" | "repDown" | "repUp";
export type TrendTone = "danger" | "warning" | "success";
export type Trend = { key: TrendKey; label: string; tone: TrendTone; hint: string };

/** The thresholds. Rates are only compared once both periods sent TREND.minSent. */
export const TREND = {
  minSent: 100,
  /** Replies (now and before together) needed before a change in reply rate means anything. */
  minReplies: 4,
  /** Reply rate change, relative, in percent. */
  replyChange: 30,
  replyDrop: 60,
  /** Bounce rate change in percentage points, and the rate that makes a rise worth flagging. */
  bouncePoints: 1,
  bounceWarn: 2,
  bounceBad: 3,
  /** Warmup reputation change in points. */
  repPoints: 3,
  /** Days without any reply before the tag shows, and before it turns red. */
  quietDays: 3,
  longQuietDays: 7,
};

export const TREND_META: Record<TrendKey, { label: string; hint: string }> = {
  quiet: { label: "No reply for days", hint: `No reply of any kind (out of office included) for ${TREND.quietDays}+ days while sending` },
  repliesDown: { label: "Replies dropping", hint: `Reply rate down ${TREND.replyChange}%+ on the days before` },
  repliesUp: { label: "Replies rising", hint: `Reply rate up ${TREND.replyChange}%+ on the days before` },
  bouncesUp: { label: "Bounces rising", hint: `Bounce rate up ${TREND.bouncePoints}+ point and at ${TREND.bounceWarn}% or more` },
  bouncesDown: { label: "Bounces falling", hint: `Bounce rate down ${TREND.bouncePoints}+ point from ${TREND.bounceWarn}% or more` },
  repDown: { label: "Reputation falling", hint: `Warmup reputation down ${TREND.repPoints}+ points on the days before` },
  repUp: { label: "Reputation rising", hint: `Warmup reputation up ${TREND.repPoints}+ points on the days before` },
};
export const TREND_ORDER: TrendKey[] = ["quiet", "repliesDown", "bouncesUp", "repDown", "repliesUp", "bouncesDown", "repUp"];
/** Tags that ask for a look, as opposed to good news. */
export const BAD_TRENDS: TrendKey[] = ["quiet", "repliesDown", "bouncesUp", "repDown"];

export type TrendInput = {
  sent: number; replies: number; bounces: number;
  prevSent: number; prevReplies: number; prevBounces: number;
  /** Average warmup reputation in the range and in the days before. */
  rep: number | null; prevRep: number | null;
  /** From the weekly review: days since the last reply up to the range's end, and what was sent since. */
  quietDays: number | null; neverReplied: boolean; sentSinceReply: number;
};

const rate = (n: number, d: number) => (100 * n) / d;
const p = (v: number) => `${v < 1 ? v.toFixed(2) : v.toFixed(1)}%`;
const n = (v: number) => v.toLocaleString("en-US");
const days = (d: number) => `${d} day${d === 1 ? "" : "s"}`;

export function trends(x: TrendInput, len: number): Trend[] {
  const out: Trend[] = [];
  const before = `the ${days(len)} before`;

  if (x.quietDays != null && x.quietDays >= TREND.quietDays && x.sentSinceReply > 0) {
    out.push({
      key: "quiet",
      label: `No reply ${x.quietDays}d`,
      tone: x.quietDays >= TREND.longQuietDays ? "danger" : "warning",
      hint: x.neverReplied
        ? `Never had a reply: ${days(x.quietDays)} since it started sending, ${n(x.sentSinceReply)} sent`
        : `${days(x.quietDays)} since the last reply of any kind, ${n(x.sentSinceReply)} sent since`,
    });
  }

  const compared = x.sent >= TREND.minSent && x.prevSent >= TREND.minSent;
  if (compared && x.replies + x.prevReplies >= TREND.minReplies) {
    const now = rate(x.replies, x.sent), was = rate(x.prevReplies, x.prevSent);
    const hint = `Reply rate ${p(now)} (${n(x.replies)} of ${n(x.sent)}) against ${p(was)} (${n(x.prevReplies)} of ${n(x.prevSent)}) ${before}`;
    if (was === 0) {
      out.push({ key: "repliesUp", label: "Replies ↑ new", tone: "success", hint });
    } else {
      const change = (100 * (now - was)) / was;
      if (change <= -TREND.replyChange) out.push({ key: "repliesDown", label: `Replies ↓ ${Math.round(-change)}%`, tone: change <= -TREND.replyDrop ? "danger" : "warning", hint });
      else if (change >= TREND.replyChange) out.push({ key: "repliesUp", label: `Replies ↑ ${Math.round(change)}%`, tone: "success", hint });
    }
  }

  if (compared) {
    const now = rate(x.bounces, x.sent), was = rate(x.prevBounces, x.prevSent);
    const diff = now - was;
    const hint = `Bounce rate ${p(now)} (${n(x.bounces)}) against ${p(was)} (${n(x.prevBounces)}) ${before}`;
    if (diff >= TREND.bouncePoints && now >= TREND.bounceWarn) out.push({ key: "bouncesUp", label: `Bounces ↑ ${diff.toFixed(1)}pt`, tone: now >= TREND.bounceBad ? "danger" : "warning", hint });
    else if (diff <= -TREND.bouncePoints && was >= TREND.bounceWarn) out.push({ key: "bouncesDown", label: `Bounces ↓ ${(-diff).toFixed(1)}pt`, tone: "success", hint });
  }

  if (x.rep != null && x.prevRep != null) {
    const diff = x.rep - x.prevRep;
    const hint = `Warmup reputation ${x.rep.toFixed(1)} against ${x.prevRep.toFixed(1)} ${before}`;
    if (diff <= -TREND.repPoints) out.push({ key: "repDown", label: `Rep ↓ ${Math.round(-diff)}`, tone: x.rep < 90 ? "danger" : "warning", hint });
    else if (diff >= TREND.repPoints) out.push({ key: "repUp", label: `Rep ↑ ${Math.round(diff)}`, tone: "success", hint });
  }

  return out;
}

/** For sorting: red tags weigh most, good news counts a little against. */
export const trendWeight = (list: Trend[]) => list.reduce((a, t) => a + (t.tone === "danger" ? 3 : t.tone === "warning" ? 2 : -0.5), 0);
