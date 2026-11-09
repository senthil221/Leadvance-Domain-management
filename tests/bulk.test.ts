import { describe, expect, it } from "vitest";
import { lineKey, summarizeBounces } from "../src/lib/bounce-detail";
import { matchPasted, pastedDomain } from "../src/lib/paste-select";
import { advise, byEsp, byTld, espName, judge, type ReviewDomain } from "../src/lib/review";

const domain = (over: Partial<ReviewDomain> = {}): ReviewDomain => ({
  id: "d1", name: "welvion.com", status: "active", clientId: null, clientName: "Qualifi", clientHue: null, tags: [],
  inboxes: 10, disconnected: 0, removed: 0, blacklisted: 0, sent: 800, replies: 4, human: 1, bounces: 20, ooo: 1, auto: 0, negative: 1, causes: {},
  prevSent: 800, prevHuman: 2, prevReplies: 3, prevBounces: 10, prevSpam: 2, ageDays: 200, connectedDays: 120, provider: "Hypertide", standing: "active", graceLeft: null,
  rep: 98, lowRepInboxes: 0, quietDays: 1, neverReplied: false, sentSinceReply: 100, slTags: [], esp: "OUTLOOK", tld: "com", ht: "live", replacedBy: null, lastSentOn: "2026-11-08", sendWeekends: false, idleDays: 0, ...over,
});

describe("paste to select", () => {
  it("reads domains out of addresses, links and stray punctuation", () => {
    expect(pastedDomain("John@Acme-Mail.com")).toBe("acme-mail.com");
    expect(pastedDomain("https://www.acmehq.co/path?x=1")).toBe("acmehq.co");
    expect(pastedDomain("<acme.io>,")).toBe("acme.io");
    expect(pastedDomain("acme.com.")).toBe("acme.com");
  });

  it("splits on any separator, drops repeats and sorts matched, not found and invalid", () => {
    const rows = [{ id: "1", name: "acme.com" }, { id: "2", name: "beta.co" }];
    const m = matchPasted("acme.com, jane@acme.com\nBETA.co; gamma.io  not_a_domain\t\t", rows);
    expect(m.matched.map((r) => r.id)).toEqual(["1", "2"]);
    expect(m.notFound).toEqual(["gamma.io"]);
    expect(m.invalid).toEqual(["not_a_domain"]);
    expect(m.tokens).toBe(4);
  });
});

describe("suggestions", () => {
  it("blames the list, not the domain, when most bounces are dead addresses", () => {
    const [first] = advise(judge(domain({ sent: 1000, bounces: 46, causes: { missing: 40, other: 6 } })));
    expect(first.tone).toBe("info");
    expect(first.text).toMatch(/4\.6% bounce.*87% are addresses that don't exist.*re-verify the list/);
  });

  it("puts our own setup first: tenant and DNS bounces", () => {
    const list = advise(judge(domain({ causes: { sender: 5, dns: 4 } })));
    expect(list[0]).toMatchObject({ tone: "danger" });
    expect(list[0].text).toMatch(/tenant/);
    expect(list[1].text).toMatch(/Validate DNS/);
  });

  it("says spam, reconnect and replace in words, and healthy when nothing's wrong", () => {
    expect(advise(judge(domain({ causes: { spam: 6 } })))[0].text).toMatch(/rejected as spam: lower the daily limit/);
    expect(advise(judge(domain({ inboxes: 0, disconnected: 5, sent: 0 })))[0].text).toMatch(/Reconnect/);
    expect(advise(judge(domain({ inboxes: 0, disconnected: 5, ht: "cancelled" })))[0].text).toMatch(/Delete its inboxes/);
    expect(advise(judge(domain({ bounces: 2 })))).toEqual([{ tone: "success", text: "Healthy: nothing to change" }]);
  });
});

describe("review by ESP and TLD", () => {
  it("names providers and groups by them", () => {
    expect([espName("OUTLOOK"), espName("GMAIL"), espName(null), espName("MIXED")]).toEqual(["Outlook", "Google", "Unknown", "Mixed"]);
    const list = [domain(), domain({ id: "d2", esp: "GMAIL", tld: "co" }), domain({ id: "d3", tld: "co", inboxes: 0, disconnected: 3 })].map(judge);
    expect(byEsp(list).map((r) => [r.name, r.domains])).toEqual([["Outlook", 2], ["Google", 1]]);
    expect(byTld(list).find((r) => r.id === "co")).toMatchObject({ name: ".co", domains: 2 });
  });
});

describe("bounce detail", () => {
  it("counts the same rejection once whatever the address or id", () => {
    expect(lineKey("5.1.1 <a@x.com> user unknown [BN8P220]")).toBe(lineKey("5.1.1 <b@y.org> user unknown [ZZ1]"));
  });

  it("sums causes, notices, campaigns and recipient providers", () => {
    const at = new Date("2026-10-30T10:00:00Z");
    const ev = (cause: string, text: string, campaignId: number, esp: string) => ({ cause, text, remote: null, campaignId, campaignName: `C${campaignId}`, esp, at });
    const d = summarizeBounces([
      ev("missing", "550 5.1.1 a@x.com: Recipient address rejected: User unknown", 1, "Google"),
      ev("missing", "550 5.1.1 b@y.com: Recipient address rejected: User unknown", 1, "Google"),
      ev("spam", "550 5.7.1 Message rejected as spam", 2, "Outlook"),
    ]);
    expect(d.total).toBe(3);
    expect(d.causes).toEqual([{ cause: "missing", n: 2 }, { cause: "spam", n: 1 }]);
    expect(d.lines[0]).toMatchObject({ cause: "missing", n: 2 });
    expect(d.campaigns[0]).toMatchObject({ id: 1, n: 2, missing: 2 });
    expect(d.recipients).toEqual([{ esp: "Google", n: 2, spam: 0 }, { esp: "Outlook", n: 1, spam: 1 }]);
  });
});
