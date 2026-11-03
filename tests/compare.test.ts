import { describe, expect, it } from "vitest";
import { ageBand, bounceMix, findings, groupsBy, keysOf, summarize, zScore } from "../src/lib/compare";
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
