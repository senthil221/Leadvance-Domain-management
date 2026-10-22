// Day ranges as YYYY-MM-DD strings in the stats timezone; "today" comes from the server.

export const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
export const fmt = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => fmt(new Date(toDate(s).getTime() + n * 86_400_000));
export const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000) + 1;
export const nice = (s: string) => toDate(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
export const weekday = (s: string) => toDate(s).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });

export type PresetKey = "today" | "yesterday" | "7d" | "14d" | "30d" | "month" | "lastmonth" | "custom";
export function presetRange(k: PresetKey, today: string): [string, string] | null {
  const t = toDate(today);
  switch (k) {
    case "today": return [today, today];
    case "yesterday": return [addDays(today, -1), addDays(today, -1)];
    case "7d": return [addDays(today, -6), today];
    case "14d": return [addDays(today, -13), today];
    case "30d": return [addDays(today, -29), today];
    case "month": return [fmt(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1))), today];
    case "lastmonth": return [fmt(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1))), fmt(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0)))];
    default: return null;
  }
}
export const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "today", label: "Today" }, { key: "yesterday", label: "Yesterday" }, { key: "7d", label: "7 days" },
  { key: "14d", label: "14 days" }, { key: "30d", label: "30 days" }, { key: "month", label: "This month" },
  { key: "lastmonth", label: "Last month" }, { key: "custom", label: "Custom" },
];
