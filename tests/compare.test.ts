import { describe, expect, it } from "vitest";
import { ageBand, bounceMix, findings, groupsBy, headline, keysOf, standAgainst, summarize, trendBuckets, trendSeries, wilson, zScore } from "../src/lib/compare";
import { isCurrent, judge, type ReviewDomain } from "../src/lib/review";

let seq = 0;
const domain = (over: Partial<ReviewDomain> = {}): ReviewDomain => {
  seq++;
  return {
    id: `d${seq}`, name: `d${seq}.com`, status: "active", clientId: "c1", clientName: "Qualifi", clientHue: null, tags: [],
    inboxes: 10, disconnected: 0, removed: 0, blacklisted: 0, sent: 1000, replies: 10, human: 2, bounces: 10, ooo: 3, auto: 1, negative: 2, causes: {},
    prevSent: 1000, prevHuman: 2, prevReplies: 10, prevBounces: 10, prevSpam: 0, ageDays: 200, connectedDays: 120, provider: "Hypertide", standing: "active", graceLeft: null,
    rep: 98, lowRepInboxes: 0, quietDays: 1, neverReplied: false, sentSinceReply: 100, slTags: [], esp: "OUTLOOK", tld: "com", ht: "live", replacedBy: null, ...over,
  };
};
const many = (n: number, over: Partial<ReviewDomain>) => Array.from({ length: n }, () => domain(over));

describe("groups", () => {
  it("adds up what a decision needs, with replies excluding out of office", () => {
    const g = summarize("x", "X", [domain({ sent: 100, replies: 10, ooo: 3, auto: 2, human: 4, causes: { spam: 2, blocklist: 1, missing: 4 } }), domain({ sent: 300, replies: 5, ooo: 1, auto: 0, human: 1, causes: { missing: 2 } })]);
    expect(g).toMatchObject({ domains: 2, sent: 400, replies: 15, real: 9, human: 5, ooo: 4, spam: 3, causes: { missing: 6, spam: 2, blocklist: 1 } });
    expect(bounceMix(g).map((m) => m.cause)).toEqual(["missing", "spam", "blocklist"]);
  });

  it("averages age and reputation over the domains that have them", () => {
    const g = summarize("x", "X", [domain({ ageDays: 10, rep: 90 }), domain({ ageDays: 30, rep: null }), domain({ ageDays: null, rep: 100 })]);
    expect([g.ageDays, g.rep]).toEqual([20, 95]);
  });

  it("counts a domain with two tags under both, once per tag whatever the case", () => {
    const d = domain({ tags: ["Pilot"], slTags: ["pilot", "Client A"] });
    expect(keysOf(d, "tag").map((k) => k.label)).toEqual(["Pilot", "Client A"]);
    expect(keysOf(domain(), "tag")).toEqual([{ key: "", label: "No tag" }]);
    const g = groupsBy([d, domain({ slTags: ["Client A"] })], "tag");
    expect(g.find((x) => x.key === "client a")?.domains).toBe(2);
    expect(g.find((x) => x.key === "pilot")?.domains).toBe(1);
  });

  it("keeps age bands youngest first, not biggest first", () => {
    const g = groupsBy([domain({ ageDays: 500, sent: 9000 }), domain({ ageDays: 5, sent: 10 }), domain({ ageDays: null, sent: 9 })], "age");
    expect(g.map((x) => x.key)).toEqual(["Under 30 days", "Over a year", "Unknown"]);
    expect(ageBand(30)).toBe("30 to 90 days");
  });

  it("names providers and ESPs, not their codes", () => {
    expect(keysOf(domain({ esp: "GMAIL" }), "esp")[0].label).toBe("Google");
    expect(keysOf(domain({ provider: null }), "provider")[0].label).toBe("No provider");
  });
});

describe("what stands out", () => {
  const calm = () => many(10, { tld: "com", sent: 1000, bounces: 10, human: 2 });

  it("says nothing when the groups are alike", () => {
    expect(findings([...calm(), ...many(4, { tld: "info", sent: 1000, bounces: 12, human: 2 })])).toEqual([]);
  });

  it("ignores a gap on too little volume to mean anything", () => {
    expect(findings([...calm(), ...many(2, { tld: "info", sent: 60, bounces: 12, human: 0 })], ["tld"])).toEqual([]);
    expect(zScore(5, 100, 4, 100)).toBeLessThan(2.6);
  });

  it("answers .info or across the board: specific to it when others of the same age and clients are fine", () => {
    const list = [...many(10, { tld: "com", ageDays: 20, sent: 1000, bounces: 10 }), ...many(5, { tld: "info", ageDays: 20, sent: 1000, bounces: 60, causes: { spam: 60 } })];
    const f = findings(list, ["tld"]).find((x) => x.id === "tld:info:bounce")!;
    expect(f.title).toBe(".info bounces 6.0%, everything else 1.0%");
    expect(f.tone).toBe("danger");
    expect(f.verdict).toBe("Looks specific to .info: domains of the same age and clients bounce less.");
  });

  it("blames age when other domains that new bounce just as much", () => {
    const list = [
      ...many(6, { tld: "com", ageDays: 400, sent: 1000, bounces: 8 }),
      ...many(4, { tld: "com", ageDays: 15, sent: 1000, bounces: 55 }),
      ...many(4, { tld: "info", ageDays: 15, sent: 1000, bounces: 60 }),
    ];
    const f = findings(list, ["tld"]).find((x) => x.id === "tld:info:bounce")!;
    expect(f.verdict).toBe("More likely their age than .info: other domains this new bounce about the same.");
  });

  it("blames the lists when the same client's other domains bounce as much", () => {
    const list = [
      ...many(6, { tld: "com", clientId: "c1", ageDays: 400, sent: 1000, bounces: 8 }),
      ...many(4, { tld: "com", clientId: "c2", ageDays: 400, sent: 1000, bounces: 55 }),
      ...many(4, { tld: "info", clientId: "c2", ageDays: 15, sent: 1000, bounces: 60 }),
    ];
    expect(findings(list, ["tld"]).find((x) => x.id === "tld:info:bounce")!.verdict).toBe("More likely the lists than .info: the same clients' other domains bounce about the same.");
  });

  it("says when a couple of domains cause most of it", () => {
    const list = [...many(10, { tld: "com", sent: 1000, bounces: 10 }), domain({ tld: "info", sent: 1000, bounces: 100 }), domain({ tld: "info", sent: 1000, bounces: 90 }), ...many(3, { tld: "info", sent: 1000, bounces: 5 })];
    const f = findings(list, ["tld"]).find((x) => x.id === "tld:info:bounce")!;
    expect(f.verdict).toBe("Not all of .info: a few domains cause most of it. Look at those first.");
  });

  it("doesn't say the same thing twice when two groups are the same domains", () => {
    const list = [...many(10, { tld: "com", ageDays: 400, sent: 1000, bounces: 10 }), ...many(5, { tld: "info", ageDays: 12, sent: 1000, bounces: 60 })];
    const f = findings(list, ["tld", "age"]).filter((x) => x.id.endsWith(":bounce"));
    expect(f).toHaveLength(1);
    expect(f[0].detail.at(-1)).toMatch(/^Mostly the same domains as /);
  });

  it("points out what's doing well too", () => {
    const list = [...many(10, { tld: "com", sent: 1000, human: 2 }), ...many(5, { tld: "co", sent: 1000, human: 12 })];
    expect(findings(list, ["tld"]).find((x) => x.id === "tld:co:human")?.tone).toBe("success");
  });
});

describe("standing in the review", () => {
  it("only active and grace count as current", () => {
    expect(["active", "grace"].every((s) => isCurrent(s as ReviewDomain["standing"]))).toBe(true);
    expect(["expired", "replaced", "cancelled", "retired", "disconnected", "deleted", "not_connected", "no_order"].some((s) => isCurrent(s as ReviewDomain["standing"]))).toBe(false);
  });

  it("calls a domain in its grace period what it is, however it's doing", () => {
    const j = judge(domain({ standing: "grace", graceLeft: 9, causes: { spam: 40 } }));
    expect(j.verdict).toBe("grace");
  });

  it("doesn't ask for action on a domain that's finished but still connected", () => {
    expect(judge(domain({ standing: "expired" })).verdict).toBe("ended");
    expect(judge(domain({ standing: "cancelled", ht: "cancelled" })).verdict).toBe("ended");
  });
});

describe("comparing any number of groups", () => {
  const many2 = (n: number, over: Partial<ReviewDomain>) => Array.from({ length: n }, () => domain(over));

  it("gives a wider likely range the less was sent", () => {
    const small = wilson(2, 100)!, big = wilson(200, 10000)!;
    expect(small[1] - small[0]).toBeGreaterThan(big[1] - big[0]);
    expect(small[0]).toBeLessThan(2);
    expect(small[1]).toBeGreaterThan(2);
    expect(wilson(0, 0)).toBeNull();
  });

  it("calls a group ahead or behind only when the gap can't be chance", () => {
    const good = many2(5, { tags: ["good"], sent: 2000, human: 60 });
    const bad = many2(5, { tags: ["bad"], sent: 2000, human: 4 });
    const all = summarize("all", "All", [...good, ...bad]);
    expect(standAgainst(summarize("good", "good", good), all, "human").state).toBe("ahead");
    expect(standAgainst(summarize("bad", "bad", bad), all, "human").state).toBe("behind");
    // Too little sent to say.
    expect(standAgainst(summarize("few", "few", [domain({ sent: 100, human: 10 })]), all, "human").state).toBe("low");
    // Sent and reputation aren't better or worse.
    expect(standAgainst(summarize("good", "good", good), all, "sent").state).toBe("none");
  });

  it("reads a higher bounce rate as behind, not ahead", () => {
    const high = many2(5, { sent: 2000, bounces: 200 }), low = many2(5, { sent: 2000, bounces: 10 });
    const all = summarize("all", "All", [...high, ...low]);
    expect(standAgainst(summarize("h", "h", high), all, "bounce").state).toBe("behind");
    expect(standAgainst(summarize("l", "l", low), all, "bounce").state).toBe("ahead");
  });

  it("says so when nothing separates them", () => {
    const a = summarize("a", "A", many2(3, { sent: 1000, human: 5 })), b = summarize("b", "B", many2(3, { sent: 1000, human: 5 }));
    const all = summarize("all", "All", [...a.rows, ...b.rows]);
    expect(headline([a, b], all, "human")).toContain("No clear winner");
    expect(headline([], all, "sent")).toContain("Pick");
  });

  it("names the group that's ahead", () => {
    const a = summarize("a", "Alpha", many2(5, { sent: 2000, human: 60 })), b = summarize("b", "Beta", many2(5, { sent: 2000, human: 4 }));
    const all = summarize("all", "All", [...a.rows, ...b.rows]);
    const line = headline([b, a], all, "human");
    expect(line).toContain("Alpha");
    expect(line).toContain("ahead");
    expect(line).toContain("Beta");
  });

  it("draws a line per group, leaving out days with too little sent", () => {
    const a = domain({ id: "a" }), b = domain({ id: "b" });
    const row = (domainId: string, day: string, sent: number, human: number) => ({ domainId, day, sent, replies: human, human, ooo: 0, auto: 0, bounces: 1, blocked: 0, rep: 90 });
    const buckets = trendBuckets("2026-11-02", "2026-11-04");
    expect(buckets).toHaveLength(3);
    const daily = [row("a", "2026-11-02", 100, 5), row("a", "2026-11-03", 5, 5), row("b", "2026-11-02", 100, 1)];
    const [x, y] = trendSeries(daily, [{ key: "A", ids: new Set([a.id]) }, { key: "B", ids: new Set([b.id]) }], "human", buckets);
    expect(x.values).toEqual([5, null, null]);
    expect(y.values).toEqual([1, null, null]);
    expect(trendSeries(daily, [{ key: "A", ids: new Set([a.id]) }], "sent", buckets)[0].values).toEqual([100, 5, 0]);
  });

  it("goes weekly on long ranges and keeps the last days in the last week", () => {
    const b = trendBuckets("2026-08-01", "2026-10-31");
    expect(b[0].to).toBe("2026-08-07");
    expect(b.at(-1)!.to).toBe("2026-10-31");
    const s = trendSeries([{ domainId: "a", day: "2026-08-05", sent: 50, replies: 0, human: 0, ooo: 0, auto: 0, bounces: 0, blocked: 0, rep: null }], [{ key: "A", ids: new Set(["a"]) }], "sent", b);
    expect(s[0].values[0]).toBe(50);
  });

  it("raises what the servers said about our own setup, with what to do", () => {
    const list = [...many2(3, { causes: { dns: 20 }, bounces: 20 }), ...many2(5, { causes: { missing: 2 }, bounces: 2 })];
    const f = findings(list).find((x) => x.id === "cause:dns")!;
    expect(f.title).toContain("60 bounces across 3 domains");
    expect(f.action).toContain("DNS");
    expect(f.domainIds).toHaveLength(3);
  });

  it("doesn't raise a reason that's only a handful of bounces", () => {
    const list = many2(3, { causes: { blocklist: 1 }, bounces: 1 });
    expect(findings(list).find((x) => x.id === "cause:blocklist")).toBeUndefined();
  });

  it("notices a group's bounces rising against its own past", () => {
    const list = [...many2(5, { tld: "info", sent: 2000, bounces: 120, prevSent: 2000, prevBounces: 10 }), ...many2(5, { tld: "com", sent: 2000, bounces: 12, prevSent: 2000, prevBounces: 12 })];
    const f = findings(list, ["tld"], 10).find((x) => x.id === "tld:info:bounce-up")!;
    expect(f.title).toContain("went from");
    expect(f.sure).toBeTruthy();
  });

  it("only mentions a client's volume falling when asked to look, and links to the client", () => {
    const list = [...many2(4, { clientId: "c9", clientName: "Client Nine", sent: 200, prevSent: 2000 }), ...many2(4, { clientId: "c8", clientName: "Client Eight", sent: 2000, prevSent: 2000 })];
    expect(findings(list, ["tld"], 10).find((x) => x.id.endsWith(":volume"))).toBeUndefined();
    const f = findings(list, ["tld"], 10, { volumeDrop: 0.3 }).find((x) => x.id === "client:c9:volume")!;
    expect(f.title).toContain("90% less");
    expect(f.href).toBe("/clients/c9");
  });

  it("every finding says what to do", () => {
    const list = [...many2(5, { tld: "info", sent: 2000, bounces: 200, human: 60 }), ...many2(5, { tld: "com", sent: 2000, bounces: 10, human: 4 })];
    const all = findings(list, ["tld"], 10);
    expect(all.length).toBeGreaterThan(0);
    for (const f of all) expect(f.action.length).toBeGreaterThan(5);
  });
});
