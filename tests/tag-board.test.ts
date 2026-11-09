import { describe, expect, it } from "vitest";
import { buildTags, fillPick, freeState, parseTargets, sameSender, type BoardDomain } from "../src/lib/tag-board";
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

  it("calls a domain free when it's connected, on no tag and not being replaced; ready once warmed up", () => {
    expect(freeState(dom("a.com"))).toEqual({ free: true, ready: true });
    expect(freeState(dom("a.com", { tags: ["New"] })).free).toBe(true);
    expect(freeState(dom("a.com", { tags: ["Qualifi"] })).free).toBe(false);
    expect(freeState(dom("a.com", { beingReplaced: true })).free).toBe(false);
    expect(freeState(dom("a.com", { status: "draining" })).free).toBe(false);
    expect(freeState(dom("a.com", { connected: 0 })).free).toBe(false);
    const warming = dom("a.com", { status: "warming", warmupStartedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), warmupDays: 12 });
    expect(freeState(warming)).toEqual({ free: true, ready: false });
  });

  it("fills to a target with the tag's sender first, then reputation, skipping domains that send nothing", () => {
    const free = [
      dom("other.com", { senders: [{ name: "Laura Benz", count: 3 }], rep: 100 }),
      dom("same-low.com", { rep: 95 }),
      dom("same-high.com", { rep: 99 }),
      dom("zero.com", { volume: 0, rep: 100 }),
      dom("warming.com", { warmupStartedAt: new Date().toISOString(), warmupDays: 12 }),
    ];
    expect(fillPick(free, "Amelia Wren", 60)).toEqual(["same-high.com", "same-low.com"]);
    expect(fillPick(free, "Amelia Wren", 100)).toEqual(["same-high.com", "same-low.com", "other.com"]);
    expect(fillPick(free, "Amelia Wren", 0)).toEqual([]);
    expect(sameSender(dom("x.com", { senders: [{ name: "amelia  wren", count: 1 }] }), "Amelia Wren")).toBe(true);
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
