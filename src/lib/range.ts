// Day ranges as YYYY-MM-DD strings in the stats timezone; "today" comes from the server.

export const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
export const fmt = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => fmt(new Date(toDate(s).getTime() + n * 86_400_000));
export const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000) + 1;
export const nice = (s: string) => toDate(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
export const weekday = (s: string) => toDate(s).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });

/** The Monday of the week a day is in (weeks run Monday to Sunday). */
export const monday = (s: string) => addDays(s, -((toDate(s).getUTCDay() + 6) % 7));
/**
 * The days a range is compared with: the same weekdays as many weeks back as
 * the range covers, so Mon–Wed is set against last Mon–Wed.
 */
export function previousRange(from: string, to: string): [string, string] {
  const back = 7 * Math.ceil(daysBetween(from, to) / 7);
  return [addDays(from, -back), addDays(to, -back)];
}

export type PresetKey = "today" | "yesterday" | "week" | "2weeks" | "7d" | "14d" | "30d" | "month" | "lastmonth" | "custom";
export function presetRange(k: PresetKey, today: string): [string, string] | null {
  const t = toDate(today);
  switch (k) {
    case "today": return [today, today];
    case "yesterday": return [addDays(today, -1), addDays(today, -1)];
    case "week": return [monday(today), today];
    case "2weeks": return [addDays(monday(today), -7), today];
    case "7d": return [addDays(today, -6), today];
    case "14d": return [addDays(today, -13), today];
    case "30d": return [addDays(today, -29), today];
    case "month": return [fmt(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1))), today];
    case "lastmonth": return [fmt(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1))), fmt(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0)))];
    default: return null;
  }
}
/** Which preset a range is, for showing it in the picker; "custom" when none. */
export function matchPreset(from: string, to: string, today: string): PresetKey {
  for (const p of PRESETS) {
    const r = presetRange(p.key, today);
    if (r && r[0] === from && r[1] === to) return p.key;
  }
  return "custom";
}
/** "the same days last week", or N weeks back for longer ranges. */
export function previousLabel(from: string, to: string) {
  const weeks = Math.ceil(daysBetween(from, to) / 7);
  return weeks === 1 ? "the same days last week" : `the same days ${weeks} weeks before`;
}

export const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "today", label: "Today" }, { key: "yesterday", label: "Yesterday" },
  { key: "week", label: "This week" }, { key: "2weeks", label: "This and last week" },
  { key: "7d", label: "Last 7 days" }, { key: "14d", label: "Last 14 days" }, { key: "30d", label: "30 days" }, { key: "month", label: "This month" },
  { key: "lastmonth", label: "Last month" }, { key: "custom", label: "Custom" },
];
