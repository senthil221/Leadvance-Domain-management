import { describe, expect, it } from "vitest";
import { bounceCauseOf, bounceReason } from "../src/lib/bounces";
import { matchPreset, monday, presetRange, previousLabel, previousRange } from "../src/lib/range";
import { badLists, byClient, bySmartleadTag, judge, sheetRows, type ReviewDomain } from "../src/lib/review";
import { slShort, slState, slText } from "../src/lib/smartlead-state";

const domain = (over: Partial<ReviewDomain> = {}): ReviewDomain => ({
  id: "d1", name: "welvion.com", status: "active", clientId: null, clientName: "Qualifi", clientHue: null, tags: [],
  inboxes: 10, disconnected: 0, removed: 0, blacklisted: 0, sent: 800, replies: 4, human: 1, bounces: 20, ooo: 1, auto: 0, negative: 1, causes: {},
  prevSent: 800, prevHuman: 2, prevReplies: 3, prevBounces: 10, prevSpam: 2, ageDays: 200, connectedDays: 120, provider: "Hypertide", standing: "active", graceLeft: null,
  rep: 98, lowRepInboxes: 0, quietDays: 1, neverReplied: false, sentSinceReply: 100, slTags: [], esp: "OUTLOOK", tld: "com", ht: "live", replacedBy: null, ...over,
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
    expect(bounceReason("Remote server returned an error -> 550 Sender (welvion.com) has no A, AAAA, or MX DNS records.")).toBe("dns");
    expect(bounceReason("550 5.7.509 Access denied, sending domain welvion.com does not pass DMARC verification")).toBe("dns");
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
  it("sets aside a domain whose inboxes were all deleted in Smartlead, whatever last week looked like", () => {
    const j = judge(domain({ inboxes: 0, disconnected: 0, removed: 14, human: 0, causes: { spam: 40 } }));
    expect(j.verdict).toBe("gone");
    expect(j.why).toBe("Every inbox (14 inboxes) was deleted in Smartlead");
    // Some inboxes still there: judged as usual.
    expect(judge(domain({ inboxes: 0, disconnected: 3, removed: 11 })).verdict).not.toBe("gone");
    expect(sheetRows([judge(domain({ inboxes: 0, disconnected: 0, removed: 14 }))]).split("\n")[1].split("\t").at(-4)).toBe("Deleted in Smartlead");
  });

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
    expect(judge(domain({ status: "warming", sent: 0 })).verdict).toBe("warming");
    expect(judge(domain({ status: "warming", sent: 800 })).verdict).toBe("ok");
  });

  it("doesn't judge rates on a handful of emails, and doesn't blame the domain for dead addresses", () => {
    expect(judge(domain({ sent: 30, human: 0, causes: { spam: 12 } })).verdict).toBe("low");
    expect(judge(domain({ human: 0, bounces: 60, causes: { missing: 60 } })).verdict).toBe("ok");
    expect(judge(domain({ sent: 500, replies: 0, human: 0 })).verdict).toBe("ok");
  });

  it("tags the evidence and replaces a domain with two strikes", () => {
    const j = judge(domain({ human: 0, rep: 84, lowRepInboxes: 3, quietDays: 9, sentSinceReply: 1200 }));
    expect(j.verdict).toBe("rest");
    expect(j.chips.map((c) => c.text)).toEqual(["Rep 84", "No reply 9d"]);
    expect(j.why).toBe("Warmup reputation 84.0 (3 inboxes under 90), no reply of any kind for 9 days (1,200 sent since); 0 human replies");
    expect(judge(domain({ rep: 84 })).verdict).toBe("watch");
    expect(judge(domain({ quietDays: 4, sentSinceReply: 500 })).chips[0]).toMatchObject({ text: "No reply 4d", tone: "warning" });
    expect(judge(domain({ quietDays: 12, neverReplied: true, sentSinceReply: 900 })).chips[0].text).toBe("No reply 12+d");
    expect(judge(domain({ quietDays: 9, sentSinceReply: 120 })).chips).toEqual([]);
  });

  it("replaces a domain that got not one reply, not even an out of office, on real volume", () => {
    const j = judge(domain({ sent: 640, replies: 0, human: 0, quietDays: 5, sentSinceReply: 900 }));
    expect(j.verdict).toBe("rest");
    expect(j.chips).toEqual([expect.objectContaining({ key: "silent", text: "No response · 640 sent", tone: "danger" })]);
    expect(j.why).toBe("Not one reply on 640 sent, not even an out of office");
    // Out-of-office replies alone show it lands: no strike at all.
    expect(judge(domain({ sent: 640, replies: 3, human: 0, quietDays: 1, sentSinceReply: 80 })).verdict).toBe("ok");
    // Too few sent, or replies still due from the last day or two: not yet.
    expect(judge(domain({ sent: 250, replies: 0, human: 0, quietDays: 5, sentSinceReply: 250 })).chips).toEqual([]);
    expect(judge(domain({ sent: 640, replies: 0, human: 0, quietDays: 2, sentSinceReply: 640 })).verdict).toBe("ok");
  });

  it("only watches two strikes while human replies still come in", () => {
    const j = judge(domain({ human: 2, rep: 86, causes: { spam: 6 }, prevSpam: 6, quietDays: 1 }));
    expect(j.chips.map((c) => c.key)).toEqual(["spam", "lowrep"]);
    expect(j.verdict).toBe("watch");
  });

  it("tells tenant and DNS problems apart", () => {
    const j = judge(domain({ causes: { dns: 5 }, disconnected: 1 }));
    expect(j.verdict).toBe("fix");
    expect(j.chips.map((c) => c.text)).toEqual(["DNS 5", "Disconnected 1/11"]);
    expect(judge(domain({ causes: { sender: 2, dns: 1 } })).chips.map((c) => c.key)).toEqual(["tenant", "dns"]);
    expect(judge(domain({ causes: { sender: 2 } })).chips).toEqual([]);
  });

  it("keeps fully disconnected domains out of idle and fix", () => {
    const j = judge(domain({ inboxes: 0, disconnected: 52, sent: 0, causes: { sender: 4 } }));
    expect(j.verdict).toBe("dead");
    expect(j.why).toBe("52 of 52 inboxes disconnected");
    expect(judge(domain({ sent: 0, disconnected: 3 })).verdict).toBe("idle");
  });

  it("sends disconnected domains Hypertide is done with to delete, the rest to reconnect", () => {
    const gone = { inboxes: 0, disconnected: 50, sent: 0 };
    const c = judge(domain({ ...gone, ht: "cancelled" }));
    expect(c.verdict).toBe("drop");
    expect(c.why).toBe("Cancelled on Hypertide, 50 of 50 inboxes disconnected");
    expect(c.chips[0]).toMatchObject({ key: "ended", text: "Hypertide cancelled", tone: "danger" });
    const r = judge(domain({ ...gone, ht: "replaced", replacedBy: "newco.com" }));
    expect([r.verdict, r.chips[0].text]).toEqual(["drop", "Replaced → newco.com"]);
    // Missing from Hypertide's order list isn't proof: it misses live domains too.
    const none = judge(domain({ ...gone, ht: "none" }));
    expect([none.verdict, none.why, none.chips[0].text]).toEqual(["dead", "No Hypertide order on this account, 50 of 50 inboxes disconnected", "No Hypertide order"]);
    expect(judge(domain({ ...gone, ht: "gone" })).verdict).toBe("dead");
    expect(judge(domain({ ...gone, ht: "live" })).verdict).toBe("dead");
    expect(judge(domain({ ...gone, ht: null })).verdict).toBe("dead");
    // Still has live inboxes: flagged, but judged as usual.
    const live = judge(domain({ ht: "cancelled" }));
    expect([live.verdict, live.chips[0].tone]).toEqual(["ok", "warning"]);
    expect(judge(domain({ ht: "none" })).chips).toEqual([]);
  });

  it("puts the clients with most to fix or replace first", () => {
    const rows = byClient([
      judge(domain({ id: "a", clientId: "q", clientName: "Qualifi" })),
      judge(domain({ id: "b", clientId: "m", clientName: "Mvinix", causes: { sender: 5 } })),
      judge(domain({ id: "c", clientId: null, clientName: null })),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Mvinix", "No client", "Qualifi"]);
    expect(rows[0].counts.fix).toBe(1);
  });

  it("copies rows Google Sheets splits into columns, with a header", () => {
    const [head, row] = sheetRows([judge(domain({ inboxes: 0, disconnected: 52, slTags: ["Remove", "-old"] }))]).split("\n");
    expect(head.split("\t").slice(0, 3)).toEqual(["Domain", "Call", "Reason"]);
    const cols = row.split("\t");
    expect(cols.length).toBe(head.split("\t").length);
    expect(cols.slice(0, 3)).toEqual(["welvion.com", "Disconnected", "52 of 52 inboxes disconnected"]);
    expect(cols.slice(4, 6)).toEqual(["Outlook", ".com"]);
    expect(cols[6]).toBe("Remove, -old");
    expect(cols[7]).toBe("Live");
    expect(sheetRows([judge(domain({ ht: "replaced", replacedBy: "newco.com" }))]).split("\n")[1].split("\t")[7]).toBe("Replaced by newco.com");
    expect(sheetRows([judge(domain({ slTags: ["=cmd"] }))]).split("\n")[1].split("\t")[6]).toBe("'=cmd");
  });

  it("counts a domain under each of its Smartlead tags", () => {
    const rows = bySmartleadTag([
      judge(domain({ id: "a", slTags: ["Q-Outlook 1", "Remove"], inboxes: 0, disconnected: 3 })),
      judge(domain({ id: "b", slTags: ["Q-Outlook 1"] })),
      judge(domain({ id: "c" })),
    ]);
    expect(rows.map((r) => [r.name, r.domains, r.counts.dead])).toEqual([["Q-Outlook 1", 2, 1], ["Remove", 1, 1], ["No tag", 1, 0]]);
  });

  it("flags campaigns whose bounces are mostly dead addresses", () => {
    expect(badLists([
      { id: 1, name: "A", clientName: null, bounces: 40, missing: 30 },
      { id: 2, name: "B", clientName: null, bounces: 40, missing: 10 },
      { id: 3, name: "C", clientName: null, bounces: 8, missing: 8 },
    ]).map((c) => c.name)).toEqual(["A"]);
  });
});

describe("Smartlead status now", () => {
  const c = (slConnected: number, slDisconnected: number, slRemoved: number) => ({ slConnected, slDisconnected, slRemoved });
  it("reads live, partly disconnected, disconnected, deleted and never there", () => {
    expect([c(5, 0, 2), c(3, 2, 0), c(0, 4, 1), c(0, 0, 6), c(0, 0, 0)].map(slState)).toEqual(["live", "partial", "disconnected", "deleted", "none"]);
    expect(slText(c(5, 0, 2))).toBe("Live · 5");
    expect(slText(c(3, 2, 0))).toBe("2 of 5 disconnected");
    expect(slText(c(0, 4, 1))).toBe("Disconnected · 4");
    expect(slText(c(0, 0, 6))).toBe("Deleted in Smartlead");
    expect([c(5, 0, 2), c(3, 2, 0), c(0, 4, 1), c(0, 0, 6), c(0, 0, 0)].map(slShort)).toEqual(["Live · 5", "2 of 5 off", "Disconnected · 4", "Deleted", "—"]);
  });
});
