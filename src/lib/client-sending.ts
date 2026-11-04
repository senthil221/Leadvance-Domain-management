import { addDays, toDate } from "./range";

// A client's daily sending held against what they were promised. Today doesn't
// count until it's over, and weekends only for clients that send on them.
// Shared by server and client.

export type SendDay = { day: string; sent: number; replies: number; human: number; bounces: number; /** Domains that sent that day. */ senders: number };

/** met/short: judged against the promise. off: not a promised day. today: not over yet. open: no promise set. */
export type DayState = "met" | "short" | "off" | "today" | "open";

export const isWeekend = (day: string) => { const d = toDate(day).getUTCDay(); return d === 0 || d === 6; };
export const isSendingDay = (day: string, weekends: boolean) => weekends || !isWeekend(day);

export function dayState(day: string, sent: number, promised: number | null, weekends: boolean, today: string): DayState {
  if (day >= today) return "today";
  if (!promised) return isSendingDay(day, weekends) ? "open" : "off";
  if (!isSendingDay(day, weekends)) return "off";
  return sent >= promised ? "met" : "short";
}

export type PromiseReport = {
  /** Finished sending days in the range. */ days: number;
  met: number; short: number;
  /** Emails owed on the days that fell short. Days over the promise don't pay it back. */ shortfall: number;
  /** Average on those days. */ avg: number | null;
  /** How much of the promised volume went out. */ delivered: number | null;
  /** The last finished sending day. */ last: { day: string; sent: number } | null;
};

export function promiseReport(days: Pick<SendDay, "day" | "sent">[], promised: number | null, weekends: boolean, today: string): PromiseReport {
  const counted = days.filter((d) => d.day < today && isSendingDay(d.day, weekends));
  const sent = counted.reduce((a, d) => a + d.sent, 0);
  const met = promised ? counted.filter((d) => d.sent >= promised).length : 0;
  const shortfall = promised ? counted.reduce((a, d) => a + Math.max(0, promised - d.sent), 0) : 0;
  const lastDay = counted.at(-1);
  return {
    days: counted.length, met, short: promised ? counted.length - met : 0, shortfall,
    avg: counted.length ? sent / counted.length : null,
    delivered: promised && counted.length ? (100 * sent) / (promised * counted.length) : null,
    last: lastDay ? { day: lastDay.day, sent: lastDay.sent } : null,
  };
}

/** Percent change, or null when there's nothing to compare with. */
export const change = (now: number | null, before: number | null) => (now != null && before ? (100 * (now - before)) / before : null);

/** One line on where a client stands, for the top of its page and the list. */
export function promiseVerdict(r: PromiseReport, promised: number | null, capacity: number): { tone: "success" | "warning" | "danger" | "faint"; text: string } {
  if (!promised) return { tone: "faint", text: "No promised volume set yet" };
  if (!r.days) return { tone: "faint", text: "No finished sending days in this range" };
  const int = (n: number) => Math.round(n).toLocaleString("en-US");
  if (capacity < promised) {
    return { tone: "danger", text: `Connected inboxes can only send ${int(capacity)} a day, ${int(promised - capacity)} under the promise, so it can't be met without adding inboxes` };
  }
  if (r.short === 0) return { tone: "success", text: `Met the promise on all ${r.days} sending days` };
  const of = `${r.met} of ${r.days} sending days`;
  return (r.delivered ?? 0) >= 90
    ? { tone: "warning", text: `Met on ${of}, ${int(r.shortfall)} emails short in total` }
    : { tone: "danger", text: `Met on only ${of}: ${int(r.shortfall)} emails short, ${Math.round(r.delivered ?? 0)}% of what was promised went out` };
}

/** The days a client is listed on: every day of the window, with no gaps. */
export function fillDays(rows: { day: string; sent: number }[], from: string, to: string) {
  const by = new Map(rows.map((r) => [r.day, r.sent]));
  const out: { day: string; sent: number }[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ day: d, sent: by.get(d) ?? 0 });
  return out;
}
