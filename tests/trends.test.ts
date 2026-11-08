import { describe, expect, it } from "vitest";
import { BAD_TRENDS, TREND_ORDER, trendWeight, trends, type TrendInput } from "../src/lib/trends";

const base: TrendInput = {
  sent: 1000, replies: 20, bounces: 10, prevSent: 1000, prevReplies: 20, prevBounces: 10,
  rep: 96, prevRep: 96, quietDays: 0, neverReplied: false, sentSinceReply: 0,
};
const keys = (x: Partial<TrendInput>) => trends({ ...base, ...x }, 7).map((t) => t.key);
const one = (x: Partial<TrendInput>) => trends({ ...base, ...x }, 7)[0];

describe("trend tags", () => {
  it("shows nothing for a steady domain", () => {
    expect(keys({})).toEqual([]);
  });

  it("counts days without a reply while sending, red from a week", () => {
    expect(one({ quietDays: 4, sentSinceReply: 600 })).toMatchObject({ key: "quiet", label: "No reply 4d", tone: "warning" });
    expect(one({ quietDays: 9, sentSinceReply: 900 })).toMatchObject({ label: "No reply 9d", tone: "danger" });
    expect(one({ quietDays: 5, neverReplied: true, sentSinceReply: 300 })?.hint).toMatch(/Never had a reply/);
    // Quiet but not sending: nothing to read into it.
    expect(keys({ quietDays: 10, sentSinceReply: 0 })).toEqual([]);
    expect(keys({ quietDays: 2, sentSinceReply: 500 })).toEqual([]);
  });

  it("flags a reply rate down or up by 30% or more", () => {
    expect(one({ replies: 10 })).toMatchObject({ key: "repliesDown", label: "Replies ↓ 50%", tone: "warning" });
    expect(one({ replies: 5 })).toMatchObject({ key: "repliesDown", tone: "danger" });
    expect(one({ replies: 30 })).toMatchObject({ key: "repliesUp", label: "Replies ↑ 50%", tone: "success" });
    expect(keys({ replies: 16 })).toEqual([]);
    expect(one({ prevReplies: 0, replies: 6 })).toMatchObject({ key: "repliesUp", label: "Replies ↑ new" });
  });

  it("doesn't compare rates on too little volume or too few replies", () => {
    expect(keys({ prevSent: 60, prevReplies: 3, prevBounces: 0, replies: 2 })).toEqual([]);
    expect(keys({ replies: 1, prevReplies: 2 })).toEqual([]);
  });

  it("flags bounces rising past 2%, red from 3%, and falling", () => {
    expect(one({ bounces: 25 })).toMatchObject({ key: "bouncesUp", label: "Bounces ↑ 1.5pt", tone: "warning" });
    expect(one({ bounces: 40 })).toMatchObject({ key: "bouncesUp", tone: "danger" });
    // Up a point but still low: not worth a tag.
    expect(keys({ prevBounces: 0, bounces: 15 })).toEqual([]);
    expect(one({ prevBounces: 40, bounces: 10 })).toMatchObject({ key: "bouncesDown", tone: "success" });
  });

  it("flags warmup reputation moving 3 points or more", () => {
    expect(one({ rep: 92, prevRep: 97 })).toMatchObject({ key: "repDown", label: "Rep ↓ 5", tone: "warning" });
    expect(one({ rep: 85, prevRep: 95 })).toMatchObject({ key: "repDown", tone: "danger" });
    expect(one({ rep: 98, prevRep: 93 })).toMatchObject({ key: "repUp", label: "Rep ↑ 5" });
    expect(keys({ rep: 94, prevRep: 96 })).toEqual([]);
    expect(keys({ rep: null })).toEqual([]);
  });

  it("weighs bad news above good for sorting", () => {
    const bad = trends({ ...base, quietDays: 9, sentSinceReply: 900, bounces: 40 }, 7);
    const good = trends({ ...base, replies: 30, rep: 99, prevRep: 94 }, 7);
    expect(trendWeight(bad)).toBeGreaterThan(0);
    expect(trendWeight(good)).toBeLessThan(0);
  });

  it("lists every bad trend in the filter order", () => {
    for (const k of BAD_TRENDS) expect(TREND_ORDER).toContain(k);
  });
});
