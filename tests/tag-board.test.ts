import { describe, expect, it } from "vitest";
import { buildTags, fillPick, fillPlan, freeState, parseTargets, sameSender, senderOff, type BoardDomain } from "../src/lib/tag-board";
import { setupLabel, type SetupRow } from "../src/lib/replacement-setups";

const dom = (name: string, over: Partial<BoardDomain> = {}): BoardDomain => ({
  id: name, name, status: "active", clientName: null, clientHue: null, expiresAt: null, graceDaysLeft: null, beingReplaced: false,
  warmupStartedAt: null, warmupDays: null, warmupDoneAt: null, connected: 3, disconnected: 0, volume: 45, sentToday: 0, rep: 98,
  ageDays: 30, esp: "OUTLOOK", senders: [{ name: "Amelia Wren", count: 3 }], tags: [], marks: [], campaigns: [], ...over,
});

describe("tag board", () => {
  it("groups domains by tag, ignoring marks and case, and adds up volume, inboxes and the main sender", () => {
    const tags = buildTags([
      dom("a.com", { tags: ["Qualifi", "New"], campaigns: [1, 2] }),
      dom("b.com", { tags: ["qualifi"], volume: 30, disconnected: 1, senders: [{ name: "Amelia Wren", count: 2 }], campaigns: [1] }),
      dom("c.com", { tags: ["Westshore"], senders: [{ name: "Steve K", count: 3 }] }),
      dom("d.com", { tags: ["Replaced"] }),
    ], { qualifi: 100, kapable: 50 });
    const q = tags.find((t) => t.key === "qualifi")!;
    expect(q.domains.map((d) => d.name)).toEqual(["a.com", "b.com"]);
    expect(q).toMatchObject({ volume: 75, connected: 6, disconnected: 1, sender: "Amelia Wren", target: 100 });
    expect(q.campaigns).toEqual([{ id: 1, domains: 2 }, { id: 2, domains: 1 }]);
    // A tag with a target and no domain yet still shows, so it can be filled.
    expect(tags.find((t) => t.key === "kapable")).toMatchObject({ volume: 0, target: 50 });
    // Marks are never tags.
    expect(tags.some((t) => t.key === "replaced" || t.key === "new")).toBe(false);
  });

  it("gives each tag the client most of its domains belong to, and none to the pool", () => {
    const tags = buildTags([
      dom("a.com", { tags: ["1-Qualifi"], clientName: "Qualifi" }),
      dom("b.com", { tags: ["1-Qualifi"], clientName: "Qualifi" }),
      dom("c.com", { tags: ["1-Qualifi"], clientName: "Westshore" }),
      dom("d.com", { tags: ["Free"], clientName: "Qualifi" }),
      dom("e.com", { tags: ["Unassigned"] }),
    ], { kapable: 50 });
    const q = tags.find((t) => t.key === "1-qualifi")!;
    expect(q.client).toBe("Qualifi");
    expect(q.clients).toEqual([{ name: "Qualifi", domains: 2 }, { name: "Westshore", domains: 1 }]);
    expect(tags.find((t) => t.key === "free")?.client).toBeNull();
    expect(tags.find((t) => t.key === "unassigned")?.client).toBeNull();
    expect(tags.find((t) => t.key === "kapable")).toMatchObject({ client: null, clients: [] });
  });

  it("puts a domain in the pool when it's tagged Free or warmup and nothing else, connected and not being replaced", () => {
    expect(freeState(dom("a.com", { tags: ["Free"] }))).toEqual({ free: true, ready: true });
    expect(freeState(dom("a.com", { tags: ["warmup", "New"] })).free).toBe(true);
    expect(freeState(dom("a.com", { tags: ["Free", "warmup"] })).free).toBe(true);
    // Untagged isn't the pool; neither is a domain already on a client tag.
    expect(freeState(dom("a.com")).free).toBe(false);
    expect(freeState(dom("a.com", { tags: ["Free", "Qualifi"] })).free).toBe(false);
    expect(freeState(dom("a.com", { tags: ["Free"], beingReplaced: true })).free).toBe(false);
    expect(freeState(dom("a.com", { tags: ["Free"], status: "draining" })).free).toBe(false);
    expect(freeState(dom("a.com", { tags: ["Free"], connected: 0 })).free).toBe(false);
    const warming = dom("a.com", { tags: ["warmup"], status: "warming", warmupStartedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), warmupDays: 12 });
    expect(freeState(warming)).toEqual({ free: true, ready: false });
  });

  it("fills to a target with the tag's sender first, then reputation, at the tag's limit per inbox", () => {
    const pool = [
      dom("other.com", { tags: ["Free"], senders: [{ name: "Laura Benz", count: 3 }], rep: 100 }),
      dom("same-low.com", { tags: ["Free"], rep: 95 }),
      dom("same-high.com", { tags: ["warmup"], rep: 99 }),
      dom("zero.com", { tags: ["Free"], volume: 0, connected: 0, rep: 100 }),
      dom("warming.com", { tags: ["warmup"], warmupStartedAt: new Date().toISOString(), warmupDays: 12 }),
    ];
    // Own limits: 45 a day each.
    expect(fillPick(pool, "Amelia Wren", 60)).toEqual(["same-high.com", "same-low.com"]);
    expect(fillPick(pool, "Amelia Wren", 100)).toEqual(["same-high.com", "same-low.com", "other.com"]);
    // On a tag sending 40 an inbox, each 3-inbox domain adds 120.
    expect(fillPick(pool, "Amelia Wren", 100, 40)).toEqual(["same-high.com"]);
    expect(fillPick(pool, "Amelia Wren", 0)).toEqual([]);
    expect(sameSender(dom("x.com", { senders: [{ name: "amelia  wren", count: 1 }] }), "Amelia Wren")).toBe(true);
  });

  it("counts a tag's domains with an inbox under another sender name", () => {
    const mixed = dom("mixed.com", { tags: ["Qualifi"], senders: [{ name: "Amelia Wren", count: 2 }, { name: "Steve K", count: 1 }] });
    const unnamed = dom("unnamed.com", { tags: ["Qualifi"], senders: [{ name: "Amelia Wren", count: 2 }, { name: "No sender name", count: 1 }] });
    const [q] = buildTags([dom("a.com", { tags: ["Qualifi"] }), dom("b.com", { tags: ["Qualifi"] }), mixed, unnamed], {});
    expect(q.sender).toBe("Amelia Wren");
    expect(q.offSender).toBe(1);
    expect(senderOff(mixed, "Amelia Wren")).toBe(true);
    expect(senderOff(unnamed, "Amelia Wren")).toBe(false);
  });

  it("plans every tag below target from the pool, biggest shortfall first, each pool domain once", () => {
    const domains = [
      dom("q1.com", { tags: ["Qualifi"], campaigns: [7] }), dom("q2.com", { tags: ["Qualifi"], campaigns: [7] }),
      dom("w1.com", { tags: ["Westshore"], senders: [{ name: "Steve K", count: 3 }] }),
      dom("p1.com", { tags: ["Free"] }), dom("p2.com", { tags: ["Free"], senders: [{ name: "Steve K", count: 3 }] }),
      dom("p3.com", { tags: ["warmup"], rep: 90 }),
    ];
    const tags = buildTags(domains, { qualifi: 120, westshore: 90, kapable: 40 });
    // The pool tags come last and never take a target.
    expect(tags.map((t) => t.key)).toEqual(["qualifi", "westshore", "kapable", "free", "warmup"]);
    expect(tags.find((t) => t.key === "free")).toMatchObject({ pool: true, target: null });
    const pool = domains.filter((d) => freeState(d).free);
    const plan = fillPlan(tags, pool);
    // Westshore needs 45 and Kapable 40 (no domains yet, so pool limits), Qualifi 30; Westshore takes the Steve K domain.
    expect(plan.map((s) => [s.tag.key, s.domains.map((d) => d.name)])).toEqual([
      ["westshore", ["p2.com"]],
      ["kapable", ["p1.com"]],
      ["qualifi", ["p3.com"]],
    ]);
    expect(plan[2]).toMatchObject({ adds: 45, after: 135, campaignIds: [7] });
  });

  it("reads saved targets, dropping anything that isn't a positive number", () => {
    expect(parseTargets({ "Qualifi ": 6000, west: 0, bad: "x", neg: -5 })).toEqual({ qualifi: 6000 });
    expect(parseTargets(null)).toEqual({});
    expect(parseTargets([1, 2])).toEqual({});
  });
});

describe("setting-up label on Warming up", () => {
  const row = (over: Partial<SetupRow>): SetupRow => ({
    domainId: "x", domain: "new.com", status: "provisioning", clientName: null, clientHue: null, oldDomain: "old.com", tags: ["New"],
    stepNameservers: "done", stepInboxes: "done", stepSmartlead: "pending", htOperation: null, lastError: null, inboxes: 0, expected: 3,
    dnsSpf: null, dnsDkim: null, dnsDmarc: null, dnsMx: null, nsAnswering: null, startedAt: "2026-11-09", ...over,
  });
  it("says where the new domain is", () => {
    expect(setupLabel(row({ stepNameservers: "failed" }))).toEqual({ text: "Nameservers need you", attention: true });
    expect(setupLabel(row({ stepNameservers: "running" })).text).toBe("Setting nameservers");
    expect(setupLabel(row({ stepInboxes: "running", htOperation: "completed" })).text).toBe("Hypertide creating inboxes");
    expect(setupLabel(row({ stepInboxes: "manual" }))).toEqual({ text: "Inboxes need you", attention: true });
    expect(setupLabel(row({})).text).toBe("Waiting for Smartlead");
    expect(setupLabel(row({ inboxes: 2 })).text).toBe("In Smartlead: 2 of 3");
    expect(setupLabel(row({ stepSmartlead: "done" })).text).toBe("Waiting for DNS");
  });
});
