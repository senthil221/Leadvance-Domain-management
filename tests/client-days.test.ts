import { describe, expect, it } from "vitest";
import { clientDays, clientDaySheet } from "../src/lib/client-days";

const domains = [
  { id: "a", clientId: "q", clientName: "Qualifi", clientHue: 1 },
  { id: "b", clientId: "q", clientName: "Qualifi", clientHue: 1 },
  { id: "c", clientId: "b", clientName: "Beebee", clientHue: 2 },
  { id: "d", clientId: null, clientName: null, clientHue: null },
];
const days = [
  { d: "a", day: "2026-10-26", sent: 800, slReplies: 1, replies: 3 },
  { d: "b", day: "2026-10-26", sent: 200, slReplies: 1, replies: 2 },
  { d: "c", day: "2026-10-26", sent: 400, slReplies: 0, replies: 2 },
  { d: "a", day: "2026-10-27", sent: 500, slReplies: 0, replies: 0 },
  // A Saturday reply to a Friday send: in the totals, no column of its own.
  { d: "a", day: "2026-10-31", sent: 0, slReplies: 0, replies: 1 },
  { d: "d", day: "2026-10-27", sent: 100, slReplies: 0, replies: 1 },
];

describe("clientDays", () => {
  it("sums each client's domains per day, in name order, no client last", () => {
    const t = clientDays(domains, days);
    expect(t.days).toEqual(["2026-10-26", "2026-10-27"]);
    expect(t.clients.map((c) => c.name)).toEqual(["Beebee", "Qualifi", "No client"]);
    const q = t.clients[1];
    expect(q.days["2026-10-26"]).toEqual({ sent: 1000, slReplies: 2, replies: 5 });
    expect(q.total).toEqual({ sent: 1500, slReplies: 2, replies: 6 });
    expect(t.total.total).toEqual({ sent: 2000, slReplies: 2, replies: 9 });
  });

  it("copies as the weekly sheet: dates, column names, one row per client, grand total", () => {
    const lines = clientDaySheet(clientDays(domains, days)).split("\n").map((l) => l.split("\t"));
    expect(lines[0]).toEqual(["", "2026-10-26", "", "", "2026-10-27", "", "", "Grand total", "", ""]);
    expect(lines[1]).toEqual(["Client", "Sent", "RR", "RR incl. OOO", "Sent", "RR", "RR incl. OOO", "Sent", "RR", "RR incl. OOO"]);
    expect(lines[2]).toEqual(["Beebee", "400", "0.00%", "0.50%", "0", "", "", "400", "0.00%", "0.50%"]);
    expect(lines[3]).toEqual(["Qualifi", "1000", "0.20%", "0.50%", "500", "0.00%", "0.00%", "1500", "0.13%", "0.40%"]);
    expect(lines[5][0]).toBe("Grand total");
    expect(lines).toHaveLength(6);
  });
});
