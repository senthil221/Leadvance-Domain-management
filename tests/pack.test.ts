import { describe, expect, it } from "vitest";
import { packRows, unpackRows } from "../src/lib/pack";

type Row = { id: string; domainId: string; email: string; domain: string; status: string; born: Date | null; tags: string[] };
const born = new Date("2026-09-01T00:00:00Z");
const rows: Row[] = [
  { id: "1", domainId: "d1", email: "a@one.com", domain: "one.com", status: "active", born, tags: ["New"] },
  { id: "2", domainId: "d1", email: "b@one.com", domain: "one.com", status: "active", born, tags: ["New"] },
  { id: "3", domainId: "d2", email: "c@two.com", domain: "two.com", status: "warming", born: null, tags: [] },
];

describe("packing rows by group", () => {
  it("sends each group's fields once and gives back the same rows, in order", () => {
    const p = packRows(rows, "domainId", ["domain", "status", "born", "tags"] as const);
    expect(Object.keys(p.groups)).toEqual(["d1", "d2"]);
    expect(p.rows[0]).toEqual({ id: "1", domainId: "d1", email: "a@one.com" });
    expect(unpackRows(p)).toEqual(rows);
  });

  it("gives back the same rows after the trip to the browser (JSON-like copy)", () => {
    const p = packRows(rows, "domainId", ["domain", "status"] as const);
    const copy = structuredClone(p);
    expect(unpackRows(copy)).toEqual(rows);
  });

  it("is smaller than the rows when a group has many of them", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ ...rows[0], id: String(i), email: `x${i}@one.com` }));
    const p = packRows(many, "domainId", ["domain", "status", "born", "tags"] as const);
    expect(JSON.stringify(p).length).toBeLessThan(0.8 * JSON.stringify(many).length);
  });
});
