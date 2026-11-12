import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations } from "../scripts/migrations";
import type { FixFact } from "../src/lib/fix-queue";
import { outcomeOf, REPLACE_OUTCOMES_SQL, REPLACE_STATS_SQL, replaceCsv, replaceList, severityOf, type OutcomeRow, type ReplaceStat } from "../src/lib/replace-list";

// Made-up domains only. A client's fleet is nine steady domains plus the one under test.
let seq = 0;
const fact = (over: Partial<FixFact> = {}): FixFact => ({
  domainId: `d${++seq}`, name: `d${seq}.com`, status: "active", standing: "active", current: true, orderLive: true, orderState: "active", provider: "Hypertide",
  graceLeft: null, clientId: "c1", clientName: "Client One", clientHue: 200, connected: 3, disconnected: 0, capacity: 45, lostCapacity: 0,
  warmupOff: 0, warmupBlocked: 0, lowRep: 0, rep: 98, sent7: 1000, replies7: 10, daysSent: 5, daysSinceSent: 0,
  bounces7: 3, dnsBounces: 0, senderBounces: 0, blockBounces: 0, spamBounces: 0,
  nameserversAnswering: true, dnsSpf: true, dnsDkim: true, dnsDmarc: true, dnsMx: true, listed: 0, daysToExpiry: 200, autoRenew: true, orderProblem: null, ...over,
});
const stat = (domainId: string, over: Partial<ReplaceStat> = {}): ReplaceStat => ({
  domainId, tld: "com", tags: null, sent7: 1000, replies7: 10, sentPrev: 1000, repliesPrev: 10, sent14: 2000, replies14: 20, human7: 0, ooo7: 0, human14: 0, ooo14: 0,
  sender7: 3, senderPrev: 3, missing7: 2, missingPrev: 2, bounces7: 6, sentY: 140, repliesY: 1, bouncesY: 1, senderY: 0, sendingDays: 60, beingReplaced: false, ...over,
});
/** Nine steady domains of one client, and the facts and stats for one more. */
function fleet(own: Partial<ReplaceStat> = {}, ownFact: Partial<FixFact> = {}, peers: Partial<ReplaceStat> = {}) {
  const facts = Array.from({ length: 9 }, () => fact());
  const stats = facts.map((f) => stat(f.domainId, peers));
  const me = fact(ownFact);
  return { facts: [...facts, me], stats: [...stats, stat(me.domainId, own)], id: me.domainId };
}
const callOf = (x: ReturnType<typeof fleet>) => { const r = replaceList(x.facts, x.stats); return { list: r, item: r.items.find((i) => i.domainId === x.id), call: r.calls.get(x.id)?.call }; };

describe("leaving good domains alone", () => {
  it("lists nothing when every domain looks like the others", () => {
    const { list, call } = callOf(fleet());
    expect(list.items).toEqual([]);
    expect(list).toMatchObject({ judged: 10, healthy: 10, early: 0 });
    expect(call).toBe("keep");
  });

  it("won't judge a domain on too little mail", () => {
    const { list, call } = callOf(fleet({ sent7: 150, sentPrev: 100, sent14: 250, sender7: 20, replies7: 0, replies14: 0 }));
    expect(list.items).toEqual([]);
    expect(call).toBe("early");
    expect(list.early).toBe(1);
    expect(list.calls.get(list.calls.keys().next().value!)?.reasons[0]).toBe("Nothing against it on 1,000 sent in 7 days");
  });

  it("never lists a domain for warm-up reputation, age or a few quiet days", () => {
    const quiet = fleet({ replies7: 6 }, { rep: 55, lowRep: 3 });
    const { item, list } = callOf(quiet);
    expect(item).toBeUndefined();
    expect(list.healthy).toBe(10);
  });

  it("doesn't replace anyone when the whole client had the same bad week, and says so", () => {
    const x = fleet({ sender7: 40 }, {}, { sender7: 40 });
    const { list } = callOf(x);
    expect(list.items).toEqual([]);
    expect(list.notes.map((n) => n.kind)).toEqual(["client", "provider"]);
    expect(list.notes[0].text).toContain("rose from 0.30% to 4.0%");
    expect(list.notes[0].text).toContain("list or copy");
  });

  it("needs a handful of bounces before their rate means anything", () => {
    expect(callOf(fleet({ sender7: 4 }, {}, { sender7: 0, senderPrev: 0 })).item).toBeUndefined();
  });

  it("ignores a gap that could be chance", () => {
    // 0.8% against 0.3% on 1,000 sent is 2.7 times, but not far enough apart to be sure.
    expect(callOf(fleet({ sender7: 8 })).item).toBeUndefined();
  });

  it("leaves out domains that aren't live senders", () => {
    const bad = { sender7: 60, replies7: 0 };
    for (const over of [{ standing: "grace" as const }, { status: "burned" }, { connected: 0, disconnected: 3 }, { orderLive: false }]) {
      const { item, list } = callOf(fleet(bad, over));
      expect(item).toBeUndefined();
      expect(list.judged).toBe(9);
    }
  });
});

describe("catching bad domains", () => {
  it("replaces on one week when sender bounces are three times the client's others", () => {
    const { item } = callOf(fleet({ sender7: 12 }));
    expect(item).toMatchObject({ call: "replace", next: "Replace it this week", canReplace: true, tld: "com", perDay: 200 });
    expect(item!.reasons[0]).toBe("Spam, policy and block list bounces 1.2% of 1,000 sent in 7 days, 4.0× the client's other domains (0.30%)");
  });

  it("watches at twice the others, and replaces when the week before was the same", () => {
    const once = callOf(fleet({ sent7: 2000, sender7: 16 }));
    expect(once.item).toMatchObject({ call: "watch" });
    expect(once.item!.next).toContain("moves to Replace");
    const twice = callOf(fleet({ sent7: 2000, sender7: 16, sentPrev: 2000, senderPrev: 16 }));
    expect(twice.item).toMatchObject({ call: "replace" });
    expect(twice.item!.reasons[1]).toBe("The week before too: 0.80% against 0.30%");
  });

  it("replaces when replies of any kind are half the others' or less", () => {
    const { item } = callOf(fleet({ sent7: 2000, replies7: 4 }));
    expect(item).toMatchObject({ call: "replace" });
    expect(item!.reasons[0]).toBe("Replies of any kind 0.20% of 2,000 sent in 7 days, the client's other domains got 1.0%");
  });

  it("looks at 14 days when a week is too little mail to show a reply gap", () => {
    // 2 replies on 700 sent isn't clear in a week; 4 on 1,400 in a fortnight is.
    const { item } = callOf(fleet({ sent7: 700, replies7: 2, sent14: 1400, replies14: 4, sender7: 2 }));
    expect(item).toMatchObject({ call: "replace" });
    expect(item!.reasons[0]).toContain("sent in 14 days");
  });

  it("judges a domain that sends little on its last 14 days as one", () => {
    // 200 a week is too thin for a week alone. Twelve sender bounces on 400 in a fortnight is ten times the others.
    const thin = { sent7: 200, sentPrev: 200, sent14: 400, replies7: 2, repliesPrev: 2, replies14: 4 };
    const bad = callOf(fleet({ ...thin, sender7: 7, senderPrev: 5 }));
    expect(bad.item).toMatchObject({ call: "replace" });
    expect(bad.item!.reasons[0]).toBe("Spam, policy and block list bounces 3.0% of 400 sent in 14 days, 10.0× the client's other domains (0.30%)");
    expect(bad.item!.short).toBe("Spam/block bounces 3.0% vs 0.30% · 10.0× · 14 days");
    expect(callOf(fleet({ ...thin, sender7: 1, senderPrev: 0 })).call).toBe("keep");
    // Six bounces is five times the others, but too few to replace on: one strict company can refuse that many at once.
    const few = callOf(fleet({ ...thin, sender7: 3, senderPrev: 3 }));
    expect(few.item).toMatchObject({ call: "watch" });
    expect(few.item!.next).toContain("sends too little to be sure yet");
    // Silent on real volume across the fortnight.
    const silent = callOf(fleet({ sent7: 250, sentPrev: 750, sent14: 1000, replies7: 0, repliesPrev: 0, replies14: 0 }));
    expect(silent.item).toMatchObject({ call: "replace" });
    expect(silent.item!.reasons[0]).toContain("sent in 14 days");
    expect(silent.item!.short).toMatch(/^Replies 0.00% vs [0-9.]+% · 14 days$/);
  });

  it("doesn't read a domain that has only just started as quiet", () => {
    expect(callOf(fleet({ sent7: 2000, replies7: 4, sendingDays: 9 })).item).toBeUndefined();
    expect(callOf(fleet({ sent7: 2000, replies7: 4, sendingDays: null })).item).toBeUndefined();
  });

  it("replaces a block listed domain now, whatever its numbers", () => {
    const { item, list } = callOf(fleet({}, { listed: 2 }));
    expect(item).toMatchObject({ call: "replace_now" });
    expect(item!.reasons[0]).toBe("On 2 block lists");
    expect(list.items[0].domainId).toBe(item!.domainId);
  });

  it("still catches a bad domain when another in the same client is worse", () => {
    const peers = Array.from({ length: 9 }, () => fact());
    const awful = fact({ sent7: 5000 }), bad = fact({ sent7: 2000 });
    const r = replaceList([...peers, awful, bad], [...peers.map((f) => stat(f.domainId)), stat(awful.domainId, { sent7: 5000, sender7: 400 }), stat(bad.domainId, { sent7: 2000, sender7: 16 })]);
    expect(r.calls.get(awful.domainId)?.call).toBe("replace");
    expect(r.notes).toEqual([]);
    // Against the nine steady ones it's 2.6 times (rounded down): the awful one doesn't count as normal.
    expect(r.calls.get(bad.domainId)).toMatchObject({ call: "watch" });
    expect(r.calls.get(bad.domainId)!.reasons[0]).toContain("2.6× the client's other domains (0.30%)");
  });

  it("compares like with like: the domains on the same tag, when they sent enough", () => {
    // One client, two groups: Outlook inboxes that rarely get a reply, and Google ones that do.
    const outlook = Array.from({ length: 5 }, () => fact()), google = Array.from({ length: 5 }, () => fact());
    const stats = [...outlook.map((f) => stat(f.domainId, { tags: "one outlook", sent7: 2000, replies7: 4 })), ...google.map((f) => stat(f.domainId, { tags: "one google", sent7: 2000, replies7: 24 }))];
    const r = replaceList([...outlook, ...google], stats);
    // Against the whole client every Outlook domain would look half as good. Against its own group, none does.
    expect(r.items).toEqual([]);
    const worse = replaceList([...outlook, ...google], [...stats.slice(0, 9), stat(google[4].domainId, { tags: "one google", sent7: 2000, replies7: 3 })]);
    expect(worse.items).toHaveLength(1);
    expect(worse.items[0]).toMatchObject({ call: "replace", tags: "one google" });
    expect(worse.items[0].reasons[0]).toBe("Replies of any kind 0.15% of 2,000 sent in 7 days, the other domains on its tag got 1.2%");
  });

  it("falls back to the client when its tag has too little to compare with", () => {
    const peers = Array.from({ length: 9 }, () => fact());
    const me = fact();
    const r = replaceList([...peers, me], [...peers.map((f) => stat(f.domainId, { tags: "main" })), stat(me.domainId, { tags: "side", sender7: 12 })]);
    expect(r.items[0].reasons[0]).toContain("4.0× the client's other domains (0.30%)");
  });

  it("compares with all live domains when the client's others sent too little", () => {
    const big = Array.from({ length: 9 }, () => fact({ clientId: "c2", clientName: "Client Two" }));
    const lone = fact({ clientId: "c3", clientName: "Client Three" });
    const r = replaceList([...big, lone], [...big.map((f) => stat(f.domainId)), stat(lone.domainId, { sender7: 12 })]);
    expect(r.items[0].reasons[0]).toContain("4.0× all other live domains (0.30%)");
  });
});

describe("not wasting a replacement", () => {
  // The others get 0.80% human and out-of-office replies: 2 human and 6 out-of-office on 1,000 sent each.
  const answered = { human7: 2, ooo7: 6, human14: 4, ooo14: 12 };

  it("keeps a domain whose bounces are high but whose human and out-of-office replies keep up, on Watch", () => {
    const { item } = callOf(fleet({ sender7: 12, human7: 2, ooo7: 7 }, {}, answered));
    expect(item).toMatchObject({ call: "watch", replies: { human: 2, ooo: 7, sent: 1000, peerHuman: 18, peerOoo: 54, peerSent: 9000, days: 7, who: "the client's others", healthy: true } });
    expect(item!.next).toContain("its mail is landing");
    expect(item!.signals.map((s) => [s.head, s.tone])).toEqual([["4.0× more spam/block bounces", "danger"], ["Replies holding up", "success"]]);
    expect(item!.reasons[1]).toBe("Human and out-of-office replies 0.90% of 1,000 sent in 7 days, the client's other domains got 0.80%: its mail is landing, so its bounces alone don't replace it");
  });

  it("keeps it on Watch even when the bounces ran two weeks, as long as the replies hold", () => {
    expect(callOf(fleet({ sent7: 2000, sender7: 16, sentPrev: 2000, senderPrev: 16, human7: 4, ooo7: 14 }, {}, answered)).item).toMatchObject({ call: "watch", replies: { healthy: true } });
  });

  it("replaces at ten times the others' bounces, however well it's answered", () => {
    const { item } = callOf(fleet({ sender7: 40, human7: 3, ooo7: 9 }, {}, answered));
    expect(item).toMatchObject({ call: "replace", replies: { healthy: true } });
    expect(item!.signals.map((s) => [s.head, s.tone])).toEqual([["13.3× more spam/block bounces", "danger"], ["Replies holding up, bounces over 10×", "info"]]);
    expect(item!.reasons[1]).toContain("whatever its replies");
    // Just under: kept.
    expect(callOf(fleet({ sender7: 26, human7: 3, ooo7: 9 }, {}, answered)).item).toMatchObject({ call: "watch" });
  });

  it("still replaces on bounces when its replies are under the others'", () => {
    const { item } = callOf(fleet({ sender7: 12, human7: 1, ooo7: 4 }, {}, answered));
    expect(item).toMatchObject({ call: "replace", replies: { human: 1, ooo: 4, healthy: false } });
    expect(item!.signals.some((s) => s.tone === "success")).toBe(false);
  });

  it("needs a few replies before calling them healthy", () => {
    expect(callOf(fleet({ sender7: 12, ooo7: 2 }, {}, { ooo7: 2 })).item).toMatchObject({ call: "replace", replies: { healthy: false } });
  });

  it("replaces a block listed domain now, however well it's answered", () => {
    expect(callOf(fleet({ human7: 5, ooo7: 10 }, { listed: 1 }, answered)).item).toMatchObject({ call: "replace_now" });
  });

  it("puts each domain's human and out-of-office replies in the CSV", () => {
    const r = replaceList(...((x) => [x.facts, x.stats] as const)(fleet({ sender7: 12, human7: 1, ooo7: 4 }, {}, answered)));
    expect(replaceCsv(r.items).split("\n")[1]).toContain(",0.10%,0.40%,0.80%,");
  });

  it("says fix first when its own setup is failing", () => {
    const { item } = callOf(fleet({ sender7: 12 }, { nameserversAnswering: false }));
    expect(item).toMatchObject({ call: "fix" });
    expect(item!.reasons[0]).toBe("DNS down: Its nameservers don't answer");
    expect(item!.reasons[1]).toContain("Spam, policy and block list bounces");
    expect(item!.next).toContain("Fix the nameservers");
  });

  it("leaves a setup problem with normal numbers to the fix queue", () => {
    expect(callOf(fleet({}, { connected: 2, disconnected: 1, lostCapacity: 15 })).item).toBeUndefined();
  });

  it("blames the list when the bounces are addresses that don't exist", () => {
    const { item } = callOf(fleet({ missing7: 30, bounces7: 34 }));
    expect(item).toMatchObject({ call: "list" });
    expect(item!.reasons[0]).toBe("30 bounces to addresses that don't exist, 3.0% of 1,000 sent against 0.20% for the client's other domains");
    expect(item!.next).toContain("Re-verify the list");
  });

  it("mentions smaller problems without letting them decide", () => {
    const { item } = callOf(fleet({ sender7: 12, missing7: 30, bounces7: 45 }, { warmupOff: 2, rep: 70 }));
    expect(item).toMatchObject({ call: "replace", also: ["Bad list too", "Low reputation", "Warm-up off"] });
  });

  it("doesn't call a few block list bounces being block listed", () => {
    expect(callOf(fleet({ sender7: 12 }, { blockBounces: 6 })).item).toMatchObject({ call: "replace", also: ["Block list bounces"] });
    expect(callOf(fleet({}, { listed: 1, blockBounces: 6 })).item).toMatchObject({ call: "replace_now", also: [] });
  });

  it("won't offer a domain that's already being replaced", () => {
    expect(callOf(fleet({ sender7: 12, beingReplaced: true })).item).toMatchObject({ call: "replace", canReplace: false });
  });
});

describe("many at once", () => {
  it("warns that it's probably the campaign when a third of a client's domains are flagged together", () => {
    const steady = Array.from({ length: 6 }, () => fact());
    const bad = Array.from({ length: 3 }, () => fact());
    const r = replaceList([...steady, ...bad], [...steady.map((f) => stat(f.domainId)), ...bad.map((f) => stat(f.domainId, { sender7: 15 }))]);
    expect(r.items.map((i) => i.call)).toEqual(["replace", "replace", "replace"]);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0].text).toContain("3 of its 9 sending domains are flagged at once");
  });
});

describe("a whole tag that's worse than everyone", () => {
  // One client, two tags of five: a steady one, and one under test.
  const twoTags = (bad: Partial<ReplaceStat>, worst: Partial<ReplaceStat> = bad) => {
    const good = Array.from({ length: 5 }, () => fact()), weak = Array.from({ length: 5 }, () => fact());
    const stats = [...good.map((f) => stat(f.domainId, { tags: "steady" })), ...weak.map((f, i) => stat(f.domainId, { tags: "weak", ...(i === 4 ? worst : bad) }))];
    return { list: replaceList([...good, ...weak], stats), good, weak };
  };

  it("judges a tag's domains against the healthy tags when its spam and block bounces are high all over", () => {
    // Every domain on the tag bounces at 1.2%, four times the steady tag: against each other none stands out.
    const { list, weak } = twoTags({ sender7: 12, senderPrev: 12 });
    expect(list.notes[0]).toMatchObject({ kind: "tag", name: "Client One · weak" });
    expect(list.notes[0].text).toBe("Spam, policy and block list bounces 1.2% across its 5 domains (1.2% the week before), 4.0× all other live domains (0.30%). Its domains are judged against the healthy tags instead of each other. Check the links in its copy before replacing many of them");
    expect(weak.map((f) => list.calls.get(f.domainId)?.call)).toEqual(["replace", "replace", "replace", "replace", "replace"]);
    expect(list.items[0].reasons[0]).toContain("4.0× live domains on healthy tags (0.30%)");
    // At a glance: what's wrong in words, then the numbers and what they're set against.
    expect(list.items[0].signals[0]).toEqual({ head: "4.0× more spam/block bounces", detail: "1.2% vs 0.30% for healthy tags · 2 weeks running", tone: "danger" });
    expect(list.notes[0]).toMatchObject({ short: "4.0× more spam/block bounces than all other domains (1.2% vs 0.30%)", action: "Check the links in its copy" });
    // The AI is told the whole tag is weak, in numbers, without the client's or the tag's name.
    const notes = list.calls.get(weak[0].domainId)?.tagNotes ?? [];
    expect(notes).toEqual([list.notes[0].text]);
    expect(notes.join(" ")).not.toMatch(/Client One|weak/);
  });

  it("only notes a tag that gets few replies, without replacing its domains on it", () => {
    // Outlook inboxes can rightly get fewer replies than Google ones: the tag is named, its domains aren't replaced for it.
    const { list, good, weak } = twoTags({ replies7: 1, replies14: 2, repliesPrev: 1 });
    expect(list.items).toEqual([]);
    expect(list.notes).toHaveLength(1);
    expect(list.notes[0].text).toBe("Replies of any kind 0.10% across its 5 domains, against 1.0% for the client's other domains. With so few bounces the mail is delivered but not answered: likely the spam folder. Test placement on a few before replacing them all");
    const row = list.domains.find((d) => d.domainId === weak[0].domainId)!;
    expect(row).toMatchObject({ call: "keep", weakTag: "Tag replies 0.10% vs 1.0%" });
    expect(severityOf(row)).toBe("weak");
    expect(severityOf(list.domains.find((d) => d.domainId === good[0].domainId)!)).toBe("ok");
  });

  it("keeps a tag weak until it falls well under the bar", () => {
    // 1.7× the steady tag: under the 2× that makes a tag weak, over the 1.5× that keeps it so.
    const good = Array.from({ length: 5 }, () => fact()), weak = Array.from({ length: 5 }, () => fact());
    const big = (tags: string, sender: number) => ({ tags, sent7: 5000, sentPrev: 5000, sent14: 10000, sender7: sender, senderPrev: sender });
    const stats = [...good.map((f) => stat(f.domainId, big("steady", 15))), ...weak.map((f) => stat(f.domainId, big("weak", 25)))];
    const key = `${weak[0].clientId}|weak`;
    const fresh = replaceList([...good, ...weak], stats);
    expect(fresh.notes).toEqual([]);
    expect(fresh.weakBounceTags).toEqual([]);
    const kept = replaceList([...good, ...weak], stats, 2, new Set([key]));
    expect(kept.weakBounceTags).toEqual([key]);
    expect(kept.notes[0].text).toContain("and stay so until it falls under 1.5×");
    // Back near the steady tag: dropped.
    const calm = [...good.map((f) => stat(f.domainId, big("steady", 15))), ...weak.map((f) => stat(f.domainId, big("weak", 18)))];
    expect(replaceList([...good, ...weak], calm, 2, new Set([key])).weakBounceTags).toEqual([]);
  });

  it("leaves a steady tag alone", () => {
    expect(twoTags({}).list.notes).toEqual([]);
  });
});

describe("every domain", () => {
  it("lists every live domain worst first, with yesterday's numbers", () => {
    const peers = Array.from({ length: 9 }, () => fact());
    const bad = fact({ name: "bad.com" }), quiet = fact({ name: "quiet.com" }), off = fact({ name: "off.com", orderLive: false });
    const r = replaceList([...peers, bad, quiet, off], [
      ...peers.map((f) => stat(f.domainId)), stat(bad.domainId, { sender7: 12, sentY: 150, repliesY: 0, bouncesY: 4, senderY: 3 }),
      stat(quiet.domainId, { sent7: 100, sent14: 150 }), stat(off.domainId),
    ]);
    expect(r.domains).toHaveLength(11);
    expect(r.domains[0]).toMatchObject({ name: "bad.com", call: "replace", short: "Spam/block bounces 1.2% vs 0.33% · 3.6×", sentY: 150, repliesY: 0, bouncesY: 4, senderY: 3, sent7: 1000, sender7: 12 });
    expect(r.domains[10]).toMatchObject({ name: "quiet.com", call: "early", short: "150 sent in 14 days" });
    expect(r.domains.slice(1, 10).every((d) => d.call === "keep" && d.short === "" && d.weakTag === null)).toBe(true);
  });
});

describe("the list", () => {
  it("puts the most urgent call first, then the most mail", () => {
    const peers = Array.from({ length: 9 }, () => fact());
    const a = fact({ name: "watch.com", sent7: 2000 }), b = fact({ name: "small.com" }), c = fact({ name: "big.com", sent7: 3000 }), d = fact({ name: "listed.com", listed: 1 });
    const r = replaceList([...peers, a, b, c, d], [...peers.map((f) => stat(f.domainId)), stat(a.domainId, { sent7: 2000, sender7: 16 }), stat(b.domainId, { sender7: 12 }), stat(c.domainId, { sent7: 3000, sender7: 36 }), stat(d.domainId)]);
    expect(r.items.map((i) => i.name)).toEqual(["listed.com", "big.com", "small.com", "watch.com"]);
    expect(r.items.map((i) => i.call)).toEqual(["replace_now", "replace", "replace", "watch"]);
    expect(r.items[1].perDay + r.items[2].perDay).toBe(800);
    const csv = replaceCsv(r.items).split("\n");
    expect(csv[0]).toBe("Domain,Client,Tag,Provider,Call,Why,Next step,Sent in 7 days,Sends a day,Human replies,Out-of-office replies,Others' human + out-of-office,Also");
    expect(csv[1]).toContain("listed.com,Client One,,Hypertide,Replace now,On 1 block list,");
  });
});

describe("whether a replacement paid off", () => {
  const row = (over: Partial<OutcomeRow> = {}): OutcomeRow => ({
    oldId: "o", oldName: "old.com", newId: "n", newName: "new.com", clientName: "Client One", clientHue: 200, day: "2026-10-20",
    oldSent: 2000, oldReplies: 10, oldBounces: 80, newSent: 2000, newReplies: 12, newBounces: 30, ...over,
  });
  it("waits until both have sent enough", () => {
    expect(outcomeOf(row({ newSent: 120, newBounces: 1, newReplies: 0 }))).toBe("early");
    expect(outcomeOf(row({ oldSent: 100 }))).toBe("early");
  });
  it("calls it better, worse, mixed or no real change", () => {
    expect(outcomeOf(row())).toBe("better");
    expect(outcomeOf(row({ newBounces: 140 }))).toBe("worse");
    expect(outcomeOf(row({ newBounces: 30, newReplies: 1, oldReplies: 20 }))).toBe("mixed");
    expect(outcomeOf(row({ newBounces: 78, newReplies: 11 }))).toBe("same");
  });
});

describe("the numbers from the database", () => {
  let pg: PGlite;
  const toCamel = <T,>(r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.replace(/_(\w)/g, (_, c: string) => c.toUpperCase()), v])) as T;
  const add = async (name: string) => (await pg.query<{ id: string }>(`insert into domains (name, status) values ($1, 'active') returning id`, [name])).rows[0].id;

  beforeAll(async () => {
    pg = await PGlite.create();
    await pg.exec("set timezone = 'UTC'");
    for (const m of loadMigrations()) await pg.exec(m.sql);
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it("adds up this week and the week before, and sorts bounces by who they blame", async () => {
    const id = await add("weeks.com");
    await pg.query(`insert into domain_daily_stats (domain_id, day, sent, replies, human_replies, ooo) values
      ($1, current_date, 100, 2, 1, 1), ($1, current_date - 6, 200, 1, 0, 1), ($1, current_date - 7, 400, 5, 1, 1), ($1, current_date - 13, 50, 1, 0, 0), ($1, current_date - 14, 999, 9, 5, 4), ($1, current_date - 40, 10, 0, 0, 0)`, [id]);
    await pg.query(`insert into email_events (dedupe_key, kind, occurred_at, domain_id, bounce_cause) values
      ('r1', 'bounce', now(), $1, 'spam'), ('r2', 'bounce', now() - interval '2 days', $1, 'policy'), ('r3', 'bounce', now() - interval '3 days', $1, 'blocklist'),
      ('r4', 'bounce', now() - interval '1 day', $1, 'missing'), ('r5', 'bounce', now() - interval '1 day', $1, 'full'), ('r6', 'bounce', now() - interval '1 day', $1, null),
      ('r7', 'bounce', now() - interval '9 days', $1, 'spam'), ('r8', 'bounce', now() - interval '10 days', $1, 'missing'), ('r9', 'bounce', now() - interval '30 days', $1, 'spam'),
      ('r10', 'reply', now(), $1, null)`, [id]);
    await pg.query(`insert into inboxes (domain_id, email, status, smartlead_tags) values
      ($1, 'a@weeks.com', 'connected', '{"Main Group", "New"}'), ($1, 'b@weeks.com', 'connected', '{" side ", "main group", "Replaced", ""}'), ($1, 'c@weeks.com', 'removed', '{"gone"}')`, [id]);
    const rows = (await pg.query<Record<string, unknown>>(REPLACE_STATS_SQL)).rows.map((r) => toCamel<ReplaceStat>(r));
    expect(rows.find((r) => r.domainId === id)).toEqual({
      domainId: id, tld: "com", tags: "main group + side", sent7: 300, replies7: 3, sentPrev: 450, repliesPrev: 6, sent14: 750, replies14: 9, human7: 1, ooo7: 2, human14: 2, ooo14: 3,
      sender7: 3, senderPrev: 1, missing7: 1, missingPrev: 1, bounces7: 6, sentY: 0, repliesY: 0, bouncesY: 0, senderY: 0, sendingDays: 40, beingReplaced: false,
    });
  });

  it("counts yesterday on its own", async () => {
    const id = await add("yesterday.com");
    await pg.query(`insert into domain_daily_stats (domain_id, day, sent, replies, bounces) values ($1, current_date - 1, 210, 2, 5), ($1, current_date, 90, 1, 1), ($1, current_date - 2, 200, 4, 0)`, [id]);
    await pg.query(`insert into email_events (dedupe_key, kind, occurred_at, domain_id, bounce_cause) values
      ('y1', 'bounce', (current_date - 1)::timestamp + interval '10 hours', $1, 'spam'), ('y2', 'bounce', (current_date - 1)::timestamp + interval '11 hours', $1, 'missing'),
      ('y3', 'bounce', current_date::timestamp + interval '1 minute', $1, 'policy')`, [id]);
    const rows = (await pg.query<Record<string, unknown>>(REPLACE_STATS_SQL)).rows.map((r) => toCamel<ReplaceStat>(r));
    expect(rows.find((r) => r.domainId === id)).toMatchObject({ sentY: 210, repliesY: 2, bouncesY: 5, senderY: 1, sent7: 500, sender7: 2 });
  });

  it("leaves out a domain that sent nothing in 14 days", async () => {
    const id = await add("idle.com");
    await pg.query(`insert into domain_daily_stats (domain_id, day, sent) values ($1, current_date - 20, 500), ($1, current_date, 0)`, [id]);
    const rows = (await pg.query<Record<string, unknown>>(REPLACE_STATS_SQL)).rows.map((r) => toCamel<ReplaceStat>(r));
    expect(rows.some((r) => r.domainId === id)).toBe(false);
  });

  it("sets an old domain's last 14 days against its replacement's numbers since", async () => {
    const oldId = await add("before.com"), newId = await add("after.com");
    const { rows: [b] } = await pg.query<{ id: string }>(`insert into replacement_batches (reason, actor, status) values ('high_bounce', 'made-up@example.com', 'completed') returning id`);
    await pg.query(`insert into replacement_items (batch_id, old_domain_id, new_domain_id, created_at, completed_at) values ($1, $2, $3, now() - interval '10 days', now() - interval '10 days')`, [b.id, oldId, newId]);
    await pg.query(`insert into domain_daily_stats (domain_id, day, sent, replies, bounces) values
      ($1, current_date - 11, 400, 2, 30), ($1, current_date - 24, 300, 1, 20), ($1, current_date - 25, 999, 9, 99), ($1, current_date - 9, 50, 0, 5),
      ($2, current_date - 10, 100, 1, 1), ($2, current_date - 1, 500, 6, 4), ($2, current_date - 11, 77, 7, 7)`, [oldId, newId]);
    const rows = (await pg.query<Record<string, unknown>>(REPLACE_OUTCOMES_SQL)).rows.map((r) => toCamel<OutcomeRow>(r));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ oldName: "before.com", newName: "after.com", oldSent: 700, oldReplies: 3, oldBounces: 50, newSent: 600, newReplies: 7, newBounces: 5 });
    expect(outcomeOf(rows[0])).toBe("better");
  });
});
