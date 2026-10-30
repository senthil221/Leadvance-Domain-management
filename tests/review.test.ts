import { describe, expect, it } from "vitest";
import { bounceCauseOf, bounceReason } from "../src/lib/bounces";
import { matchPreset, monday, presetRange, previousLabel, previousRange } from "../src/lib/range";
import { badLists, judge, type ReviewDomain } from "../src/lib/review";

const domain = (over: Partial<ReviewDomain> = {}): ReviewDomain => ({
  id: "d1", name: "welvion.com", status: "active", clientId: null, clientName: "Qualifi", clientHue: null, tags: [],
  inboxes: 10, disconnected: 0, blacklisted: 0, sent: 800, replies: 4, human: 1, bounces: 20, causes: {},
  prevSent: 800, prevHuman: 2, prevSpam: 2, ...over,
});

describe("week ranges", () => {
  // 30 Oct 2026 is a Friday, 28 Oct a Wednesday.
  it("runs this week from Monday and two weeks from the Monday before", () => {
    expect(monday("2026-10-28")).toBe("2026-10-26");
    expect(monday("2026-10-26")).toBe("2026-10-26");
    expect(monday("2026-11-01")).toBe("2026-10-26"); // Sunday
    expect(presetRange("week", "2026-10-28")).toEqual(["2026-10-26", "2026-10-28"]);
    expect(presetRange("2weeks", "2026-10-28")).toEqual(["2026-10-19", "2026-10-28"]);
    expect(matchPreset("2026-10-26", "2026-10-28", "2026-10-28")).toBe("week");
    expect(matchPreset("2026-10-01", "2026-10-28", "2026-10-28")).toBe("month");
  });

  it("compares with the same weekdays before", () => {
    expect(previousRange("2026-10-26", "2026-10-28")).toEqual(["2026-10-19", "2026-10-21"]);
    expect(previousRange("2026-10-19", "2026-10-28")).toEqual(["2026-10-05", "2026-10-14"]);
    expect(previousRange("2026-10-28", "2026-10-28")).toEqual(["2026-10-21", "2026-10-21"]);
    expect(previousLabel("2026-10-26", "2026-10-28")).toBe("the same days last week");
    expect(previousLabel("2026-10-19", "2026-10-28")).toBe("the same days 2 weeks before");
  });
});

describe("bounce causes", () => {
  it("tells our own setup, blocklists, spam and dead addresses apart", () => {
    expect(bounceReason("Remote server returned an error -> 550 Sender (welvion.com) has no A, AAAA, or MX DNS records.")).toBe("sender");
    expect(bounceReason("550 5.7.705 Access denied, tenant has exceeded threshold")).toBe("sender");
    expect(bounceReason("550 A URL in this email (brightorae . com) is listed on https://www.surbl.org/lists")).toBe("blocklist");
    expect(bounceReason("530 5.3.0 recipient declines mail from a@b.com [orthrus:DBL0]")).toBe("blocklist");
    expect(bounceReason("zerohungerwater.com suspects your message is spam and rejected it.")).toBe("spam");
    expect(bounceReason("Security or policy settings at fytertech.com have rejected your message.")).toBe("policy");
    expect(bounceReason("Email settings for wannawindow.net aren't set up correctly. Invalid MX or A/AAAA record")).toBe("missing");
    expect(bounceReason("", true)).toBe("sender");
  });

  it("ignores the quoted headers and Office 365's help text", () => {
    const o365 = {
      bounce_message: {
        text: "Your message to korey@tricoreig.com couldn't be delivered.\nkorey wasn't found at tricoreig.com.\n\nOriginal message headers:\nX-Microsoft-Antispam: BCL:0;\nAuthentication-Results: spf=pass; dkim=fail",
        html: "<p>korey wasn't found at tricoreig.com.</p><p>How to Fix It</p><p>For example, if the issue is related to an SPF failure, the reported error will usually include the acronym SPF</p>",
      },
    };
    expect(bounceCauseOf(o365)).toBe("missing");
    expect(bounceCauseOf({ bounce_message: { text: "", html: "<p>Remote server returned an error -&gt; 554 5.7.1 Email flagged as Spam</p>" } })).toBe("spam");
    expect(bounceCauseOf({ description: "550 5.1.1 user unknown" })).toBe("missing");
  });
});

describe("weekly review calls", () => {
  it("rests a domain with spam rejections and no human replies", () => {
    const j = judge(domain({ human: 0, causes: { spam: 30, blocklist: 4 } }));
    expect(j.verdict).toBe("rest");
    expect(j.why).toBe("34 spam/blocklist rejections, 4.3% of 800 sent, up from 0.25%, no human replies");
    expect(j.worse).toBe(true);
  });

  it("only watches it while it still gets human replies", () => {
    const j = judge(domain({ human: 3, causes: { spam: 30 } }));
    expect(j.verdict).toBe("watch");
    expect(j.why).toContain("3 human replies");
  });

  it("puts sender problems first, then idle and disconnected inboxes", () => {
    expect(judge(domain({ human: 0, causes: { sender: 15, spam: 40 } })).verdict).toBe("fix");
    expect(judge(domain({ sent: 0, disconnected: 4 })).why).toBe("Nothing sent; 4 of 14 inboxes disconnected");
    expect(judge(domain({ disconnected: 2, causes: { missing: 9 } })).verdict).toBe("fix");
    expect(judge(domain({ status: "warming", sent: 0 })).verdict).toBe("ok");
  });

  it("doesn't judge rates on a handful of emails, and doesn't blame the domain for dead addresses", () => {
    expect(judge(domain({ sent: 30, human: 0, causes: { spam: 12 } })).verdict).toBe("low");
    expect(judge(domain({ human: 0, bounces: 60, causes: { missing: 60 } })).verdict).toBe("ok");
    expect(judge(domain({ sent: 500, replies: 0, human: 0 })).verdict).toBe("watch");
  });

  it("flags campaigns whose bounces are mostly dead addresses", () => {
    expect(badLists([
      { id: 1, name: "A", clientName: null, bounces: 40, missing: 30 },
      { id: 2, name: "B", clientName: null, bounces: 40, missing: 10 },
      { id: 3, name: "C", clientName: null, bounces: 8, missing: 8 },
    ]).map((c) => c.name)).toEqual(["A"]);
  });
});
