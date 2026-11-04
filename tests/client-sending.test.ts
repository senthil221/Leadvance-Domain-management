import { describe, expect, it } from "vitest";
import { change, dayState, fillDays, isSendingDay, promiseReport, promiseVerdict } from "../src/lib/client-sending";

// 2 Nov 2026 is a Monday.
const days = (...sent: number[]) => sent.map((s, i) => ({ day: `2026-11-${String(2 + i).padStart(2, "0")}`, sent: s }));

describe("sending days", () => {
  it("skips weekends unless the client sends on them", () => {
    expect(isSendingDay("2026-11-02", false)).toBe(true);
    expect(isSendingDay("2026-11-07", false)).toBe(false);
    expect(isSendingDay("2026-11-07", true)).toBe(true);
  });
  it("judges a day against the promise, but never today or a day off", () => {
    expect(dayState("2026-11-02", 1000, 1000, false, "2026-11-09")).toBe("met");
    expect(dayState("2026-11-02", 999, 1000, false, "2026-11-09")).toBe("short");
    expect(dayState("2026-11-07", 0, 1000, false, "2026-11-09")).toBe("off");
    expect(dayState("2026-11-09", 10, 1000, false, "2026-11-09")).toBe("today");
    expect(dayState("2026-11-02", 500, null, false, "2026-11-09")).toBe("open");
  });
});

describe("promiseReport", () => {
  it("counts finished sending days only", () => {
    // Mon to Sun, then today (Mon 9th) hasn't finished.
    const r = promiseReport(days(1000, 1200, 800, 1000, 600, 0, 0, 50), 1000, false, "2026-11-09");
    expect(r.days).toBe(5);
    expect(r.met).toBe(3);
    expect(r.short).toBe(2);
    expect(r.last).toEqual({ day: "2026-11-06", sent: 600 });
  });
  it("doesn't let a big day pay back a short one", () => {
    const r = promiseReport(days(2000, 500), 1000, false, "2026-11-09");
    expect(r.shortfall).toBe(500);
    expect(r.delivered).toBeCloseTo(125);
  });
  it("still reports the average with no promise, and owes nothing", () => {
    const r = promiseReport(days(100, 300), null, false, "2026-11-09");
    expect(r.avg).toBe(200);
    expect(r.met).toBe(0);
    expect(r.short).toBe(0);
    expect(r.shortfall).toBe(0);
    expect(r.delivered).toBeNull();
  });
  it("has nothing to report when today is the whole range", () => {
    const r = promiseReport([{ day: "2026-11-09", sent: 40 }], 1000, false, "2026-11-09");
    expect(r.days).toBe(0);
    expect(r.avg).toBeNull();
    expect(r.last).toBeNull();
  });
  it("counts weekends for clients that send on them", () => {
    const r = promiseReport(days(100, 100, 100, 100, 100, 100, 100), 100, true, "2026-11-09");
    expect(r.days).toBe(7);
    expect(r.met).toBe(7);
  });
});

describe("promiseVerdict", () => {
  const report = (over = {}) => ({ days: 5, met: 3, short: 2, shortfall: 400, avg: 920, delivered: 92, last: null, ...over });
  it("asks for a promise before judging", () => {
    expect(promiseVerdict(report(), null, 5000).tone).toBe("faint");
  });
  it("says first when the inboxes can't reach the promise at all", () => {
    const v = promiseVerdict(report({ short: 0 }), 1000, 800);
    expect(v.tone).toBe("danger");
    expect(v.text).toContain("200 under the promise");
  });
  it("separates a near miss from a real one", () => {
    expect(promiseVerdict(report(), 1000, 5000).tone).toBe("warning");
    expect(promiseVerdict(report({ delivered: 60 }), 1000, 5000).tone).toBe("danger");
    expect(promiseVerdict(report({ short: 0, met: 5 }), 1000, 5000).tone).toBe("success");
  });
});

describe("helpers", () => {
  it("fills the days nothing was sent", () => {
    expect(fillDays([{ day: "2026-11-03", sent: 5 }], "2026-11-02", "2026-11-04").map((d) => d.sent)).toEqual([0, 5, 0]);
  });
  it("has no change without something to compare with", () => {
    expect(change(100, 0)).toBeNull();
    expect(change(null, 100)).toBeNull();
    expect(change(150, 100)).toBe(50);
  });
});
