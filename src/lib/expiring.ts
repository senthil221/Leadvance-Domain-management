import type { DomainRow } from "./queries";

// Domains in use whose registration is running out. The Active and Warming &
// setup tabs of Domains are what counts as in use; domains in storage or already
// replaced aren't being mailed from, so they aren't listed here.

export const EXPIRY_WINDOWS = [7, 14, 30, 60, 90] as const;
export const LONGEST_WINDOW = EXPIRY_WINDOWS[EXPIRY_WINDOWS.length - 1];

type Row = Pick<DomainRow, "status" | "daysToExpiry">;

export const isInUse = (d: Pick<DomainRow, "status">) => d.status === "active" || d.status === "warming" || d.status === "provisioning";

/** In use, and past its date, inside the longest window, or with no date to go on. */
export const isExpiryTracked = (d: Row) => isInUse(d) && (d.daysToExpiry === null || d.daysToExpiry <= LONGEST_WINDOW);

/** An expired domain is inside every window: it's the most urgent of all. */
export const isWithin = (d: Row, days: number) => d.daysToExpiry !== null && d.daysToExpiry <= days;

export function expiryLabel(days: number | null) {
  if (days === null) return "No date";
  if (days < 0) return `Expired ${-days}d ago`;
  if (days === 0) return "Expires today";
  return days === 1 ? "1 day" : `${days} days`;
}

export function expiryTone(days: number | null): "danger" | "warning" | "neutral" | "faint" {
  if (days === null) return "faint";
  if (days <= 7) return "danger";
  return days <= 30 ? "warning" : "neutral";
}

export function autoRenewOf(on: boolean | null): { label: string; tone: "success" | "danger" | "faint"; title: string } {
  if (on === true) return { label: "On", tone: "success", title: "The registrar should renew it, as long as the payment goes through" };
  if (on === false) return { label: "Off", tone: "danger", title: "It lapses on this date unless you renew it" };
  return { label: "Not known", tone: "faint", title: "The registrar doesn't say, so don't count on it renewing" };
}

/** Lapses unless someone acts: not on auto-renew and no replacement under way. */
export const needsAction = (d: Pick<DomainRow, "autoRenew" | "replacedById">) => d.autoRenew !== true && !d.replacedById;
