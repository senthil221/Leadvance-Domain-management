const intFmt = new Intl.NumberFormat("en-US");

export function int(n: number | null | undefined) {
  return n == null ? "—" : intFmt.format(n);
}

export function pct(n: number | null | undefined, digits = 1) {
  return n == null ? "—" : `${n.toFixed(digits)}%`;
}

export function initials(name: string) {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase();
}

const DAY = 86_400_000;

export function daysSince(d: Date | string | null | undefined, now = Date.now()) {
  if (!d) return null;
  return Math.max(0, Math.floor((now - new Date(d).getTime()) / DAY));
}

// "3m ago", "5h ago", "4d ago", then a short date. Times are shown in UTC on
// the server render; they are coarse enough that this never jumps.
export function ago(d: Date | string | null | undefined, now = Date.now()) {
  if (!d) return "—";
  const ms = now - new Date(d).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / 3_600_000)}h ago`;
  if (ms < 30 * DAY) return `${Math.floor(ms / DAY)}d ago`;
  return shortDate(d);
}

export function shortDate(d: Date | string | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
