const intFmt = new Intl.NumberFormat("en-US");

export function int(n: number | null | undefined) {
  return n == null ? "—" : intFmt.format(n);
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

// One line from a job result, e.g. "420 accounts, 3 new domains".
/** How long something took: "under 1s", "42s", "3m 05s", "1h 12m". */
export function took(ms: number) {
  if (ms < 1000) return "under 1s";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

export function summarize(detail: Record<string, unknown> | null | undefined) {
  if (!detail) return null;
  if (typeof detail.skipped === "string") return `skipped: ${detail.skipped}`;
  const parts = Object.entries(detail)
    .filter(([, v]) => typeof v === "number")
    .map(([k, v]) => `${v} ${k.replace(/([A-Z])/g, " $1").toLowerCase()}`);
  if (typeof detail.note === "string" && detail.note) parts.push(detail.note);
  return parts.length ? parts.join(", ") : null;
}

/** An age in days as people say it: 45d, 8mo, 3.1y. */
export const ageLabel = (days: number | null) => (days == null ? null : days < 60 ? `${days}d` : days < 730 ? `${Math.round(days / 30)}mo` : `${(days / 365).toFixed(1)}y`);

/**
 * How long a domain's inboxes have been in Smartlead, from the day each was
 * added there (never from when the domain was bought). Inboxes added at
 * different times read as a range, "2–7mo", and the title says how many came
 * in on which day. Null when Smartlead gave no date for any of them.
 */
export function inboxAge(added: (Date | string | null | undefined)[], now = Date.now()) {
  const days = added.filter((a): a is Date | string => !!a).map((a) => Math.floor((now - new Date(a).getTime()) / 86_400_000)).filter((d) => Number.isFinite(d));
  if (!days.length) return null;
  const oldest = Math.max(...days), newest = Math.min(...days);
  const lo = ageLabel(newest)!, hi = ageLabel(oldest)!;
  const unit = (s: string) => s.replace(/^[\d.]+/, "");
  const label = lo === hi ? hi : unit(lo) === unit(hi) ? `${lo.slice(0, -unit(lo).length)}–${hi}` : `${lo}–${hi}`;
  // How many inboxes came in on each day, oldest first.
  const byDay = new Map<number, number>();
  for (const d of days) byDay.set(d, (byDay.get(d) ?? 0) + 1);
  const when = (d: number) => new Date(now - d * 86_400_000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const list = [...byDay].sort((a, b) => b[0] - a[0]);
  const parts = list.slice(0, 4).map(([d, k]) => `${k} on ${when(d)} (${ageLabel(d)} ago)`);
  const more = list.length > 4 ? `, and ${list.slice(4).reduce((a, [, k]) => a + k, 0)} on ${list.length - 4} other days` : "";
  const title = byDay.size === 1
    ? `Inboxes added to Smartlead on ${when(oldest)}, ${oldest} days ago`
    : `Inboxes added to Smartlead: ${parts.join(", ")}${more}`;
  return { oldest, newest, label, title };
}

/** A date that keeps its width down a column: Mar 05, 2027. */
export function fixedDate(d: Date | string | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric", timeZone: "UTC" });
}
