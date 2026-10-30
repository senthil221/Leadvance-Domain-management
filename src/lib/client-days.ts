// Clients by day: one row per client, and for each day it sent on its sent,
// reply rate without out-of-office replies (Smartlead's own count) and reply
// rate with them. The same layout as the weekly client sheet, so it pastes in.

export type DayFigures = { sent: number; slReplies: number; replies: number };
export type ClientDays = { key: string; name: string; hue: number | null; days: Record<string, DayFigures>; total: DayFigures };
export type ClientDayTable = { days: string[]; clients: ClientDays[]; total: ClientDays };

type Domain = { id: string; clientId: string | null; clientName: string | null; clientHue: number | null };
type Day = DayFigures & { d: string; day: string };

const zero = (): DayFigures => ({ sent: 0, slReplies: 0, replies: 0 });
const add = (a: DayFigures, b: DayFigures) => { a.sent += b.sent; a.slReplies += b.slReplies; a.replies += b.replies; };
export const rr = (n: number, sent: number) => (sent > 0 ? (100 * n) / sent : null);

/**
 * Sums the domains' days per client. Only days something was sent on get a
 * column (weekends drop out); the totals still count replies that came in on
 * the others. Clients are in name order, the ones without a client last.
 */
export function clientDays(domains: Domain[], days: Day[]): ClientDayTable {
  const of = new Map(domains.map((d) => [d.id, d]));
  const clients = new Map<string, ClientDays>();
  const total: ClientDays = { key: "total", name: "Grand total", hue: null, days: {}, total: zero() };
  const sending = new Set<string>();
  for (const x of days) {
    const d = of.get(x.d);
    if (!d) continue;
    const key = d.clientId ?? "";
    let c = clients.get(key);
    if (!c) {
      c = { key, name: d.clientName ?? "No client", hue: d.clientHue, days: {}, total: zero() };
      clients.set(key, c);
    }
    for (const r of [c, total]) {
      add((r.days[x.day] ??= zero()), x);
      add(r.total, x);
    }
    if (x.sent > 0) sending.add(x.day);
  }
  return {
    days: [...sending].sort(),
    clients: [...clients.values()].sort((a, b) => (a.key === "" ? 1 : 0) - (b.key === "" ? 1 : 0) || a.name.localeCompare(b.name)),
    total,
  };
}

const pct = (v: number | null) => (v == null ? "" : `${v.toFixed(2)}%`);
/** A cell Google Sheets pastes as plain text. */
const cell = (v: string | number) => {
  const t = String(v).replace(/[\t\r\n]+/g, " ").trim();
  return /^[=+\-@]/.test(t) ? `'${t}` : t;
};

/** Tab-separated, ready to paste into Google Sheets: a row of dates, a row of column names, a row per client and the grand total. */
export function clientDaySheet(t: ClientDayTable): string {
  const figures = (f: DayFigures | undefined) => {
    const v = f ?? zero();
    return [v.sent, pct(rr(v.slReplies, v.sent)), pct(rr(v.replies, v.sent))];
  };
  const dates = ["", ...t.days.flatMap((d) => [d, "", ""]), "Grand total", "", ""];
  const head = ["Client", ...[...t.days, "total"].flatMap(() => ["Sent", "RR", "RR incl. OOO"])];
  const row = (c: ClientDays) => [c.name, ...t.days.flatMap((d) => figures(c.days[d])), ...figures(c.total)];
  return [dates, head, ...t.clients.map(row), row(t.total)].map((r) => r.map(cell).join("\t")).join("\n");
}
