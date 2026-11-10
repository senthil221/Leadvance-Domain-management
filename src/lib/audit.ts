import type { DomainStatus } from "./status";

/** A TLD as IANA lists them: letters, or an xn-- label. Anything else (".com-old") isn't a domain name. */
export const isRealTld = (tld: string) => /^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/i.test(tld);
/** A Microsoft tenant name (*.onmicrosoft.com): Microsoft holds it, no registry has it on its own. */
export const isTenantName = (name: string) => /\.onmicrosoft\.com$/i.test(name);

// The domain audit's rules: what is wrong with a domain, from what its
// registrar account lists and what the registry (RDAP) says. Shared by server
// and client code; the numbers come from listDomainAudit().

export type AuditRow = {
  id: string;
  name: string;
  tld: string | null;
  status: DomainStatus;
  clientName: string | null;
  clientHue: number | null;
  /** The registrar the app has (from the account it was synced from, or entered). */
  registrar: string | null;
  registrarAccount: string | null;
  expiresAt: Date | null;
  /** Its registrar account lists it with no expiry date. */
  unregistered: boolean;
  /** Not on its registrar account's last full list. */
  gone: boolean;
  accountListedAt: Date | null;
  registrarSeenAt: Date | null;
  /** What still uses it (inboxes, setup, a Hypertide order…), or null. */
  inUse: string | null;
  inboxCount: number;
  registryCheckedAt: Date | null;
  registryFound: boolean | null;
  registryExpiresAt: Date | null;
  registryRegistrar: string | null;
  registryStatus: string[];
  registryError: string | null;
  archivedAt: Date | null;
  archivedReason: string | null;
  archivedBy: string | null;
};

export type IssueKey =
  | "bad_name" | "unregistered" | "gone" | "dropped" | "deleting" | "expired_unused"
  | "expired_in_use" | "other_registrar" | "registrar_differs" | "expiry_differs";

/** Groups in the order shown. `archive`: the domains are ones we don't want, so the group offers Archive. */
export const ISSUES: Record<IssueKey, { label: string; tone: "danger" | "warning" | "info"; archive: boolean; hint: string }> = {
  bad_name: { label: "Not a real domain", tone: "danger", archive: true, hint: "The name doesn't end in a real TLD (.com-old, .com-1): an entry left over from renaming, not a domain anyone can own." },
  unregistered: { label: "Not registered", tone: "danger", archive: true, hint: "The registrar account lists them, but they were never registered: no expiry date there, and the registry has no record. Ask the registrar for a refund or to register them; archive them meanwhile." },
  gone: { label: "Gone from the registrar", tone: "danger", archive: true, hint: "No longer on their registrar account's list: transferred away, deleted or dropped." },
  dropped: { label: "Not at the registry", tone: "danger", archive: true, hint: "The registry has no record of them: they lapsed and were deleted, or never existed." },
  deleting: { label: "Being deleted", tone: "warning", archive: true, hint: "Past expiry and in the registry's redemption or pending-delete period. Restore them at the registrar if you still want them." },
  expired_unused: { label: "Expired, not used", tone: "warning", archive: true, hint: "Past their expiry date with nothing on them." },
  expired_in_use: { label: "Expired, still in use", tone: "danger", archive: false, hint: "Past their expiry date while inboxes or orders are still on them: renew them or replace them." },
  other_registrar: { label: "Registrar not connected", tone: "info", archive: false, hint: "The registry says they're at a registrar the app has no account for, so their dates and nameservers aren't synced. Connect that account in Settings → Connections." },
  registrar_differs: { label: "Registrar differs", tone: "warning", archive: false, hint: "The registry names a different registrar from the one the app has: the domain was transferred." },
  expiry_differs: { label: "Expiry differs", tone: "info", archive: false, hint: "The registry's expiry date isn't the registrar account's. A .com past expiry shows a year on at the registry until the registrar deletes it." },
};
export const ISSUE_ORDER = Object.keys(ISSUES) as IssueKey[];

// Registrar names as the registry writes them ("Dynadot Inc", "Spaceship, Inc.",
// "Unstoppable Domains Inc.") against the app's ("Dynadot", "Unstoppable Domains").
const KNOWN = ["unstoppable", "dynadot", "spaceship", "porkbun", "namecheap", "godaddy", "namesilo", "cloudflare", "hostinger", "gandi", "tucows", "enom", "squarespace", "ionos"];
export function registrarKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const s = name.toLowerCase().replace(/[^a-z0-9 ]/g, " ");
  return KNOWN.find((k) => s.includes(k)) ?? s.split(/\s+/).filter(Boolean)[0] ?? null;
}

const dayOf = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const daysBetween = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const DELETING = ["redemption period", "pending delete", "pending restore"];

/** Every problem with a domain, most serious first; empty when it's fine. */
export function auditIssues(d: AuditRow, today = new Date().toISOString().slice(0, 10)): IssueKey[] {
  const out: IssueKey[] = [];
  if (d.archivedAt) return out;
  if (!isRealTld(d.tld ?? d.name.split(".").pop() ?? "")) return ["bad_name"];
  if (isTenantName(d.name)) return out;
  const atRegistrar = d.registrar && d.registrarAccount;
  if (d.unregistered || (d.registryFound === false && atRegistrar && !d.gone)) out.push("unregistered");
  if (d.gone) out.push("gone");
  if (d.registryFound === false && !out.includes("unregistered")) out.push("dropped");
  if (d.registryFound && d.registryStatus.some((s) => DELETING.includes(s))) out.push("deleting");
  const exp = dayOf(d.expiresAt);
  const regExp = dayOf(d.registryExpiresAt);
  // Expired by the registrar's date, or by the registry's when the app has none.
  const expired = (exp ?? regExp) !== null && (exp ?? regExp)! < today;
  if (expired && !out.length) out.push(d.inUse ? "expired_in_use" : "expired_unused");
  if (d.registryFound && d.registryRegistrar) {
    const theirs = registrarKey(d.registryRegistrar);
    const ours = registrarKey(d.registrar);
    if (!ours) out.push("other_registrar");
    else if (theirs && theirs !== ours) out.push("registrar_differs");
  }
  if (exp && regExp && daysBetween(exp, regExp) > 1 && !out.some((k) => k !== "other_registrar" && k !== "registrar_differs")) out.push("expiry_differs");
  return out;
}

/** The first issue decides the group a domain is listed under. */
export const mainIssue = (d: AuditRow, today?: string) => auditIssues(d, today)[0] ?? null;

/** One line on what's wrong, in words. */
export function issueText(k: IssueKey, d: AuditRow): string {
  const acct = [d.registrar, d.registrarAccount].filter(Boolean).join(" · ") || "its registrar";
  const fmt = (v: Date | null) => (v ? new Date(v).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "?");
  switch (k) {
    case "bad_name": return `.${d.tld ?? d.name.split(".").pop()} isn't a real ending`;
    case "unregistered":
      return d.unregistered ? `${acct} lists it with no expiry date${d.registryFound === false ? "; the registry has no record" : ""}` : `${acct} lists it, but the registry has no record`;
    case "gone": return `Not on ${acct}'s list any more${d.accountListedAt ? ` (read ${fmt(d.accountListedAt)})` : ""}`;
    case "dropped": return `The .${d.tld ?? d.name.split(".").pop()} registry has no record of it`;
    case "deleting": return `Registry: ${d.registryStatus.filter((s) => DELETING.includes(s)).join(", ")}`;
    case "expired_unused": return `Expired ${fmt(d.expiresAt ?? d.registryExpiresAt)}, nothing on it`;
    case "expired_in_use": return `Expired ${fmt(d.expiresAt ?? d.registryExpiresAt)}, ${d.inUse}`;
    case "other_registrar": return `At ${d.registryRegistrar}, not connected`;
    case "registrar_differs": return `Registry: ${d.registryRegistrar}; the app has ${d.registrar}`;
    case "expiry_differs": return `Registry: ${fmt(d.registryExpiresAt)}; ${acct}: ${fmt(d.expiresAt)}`;
  }
}
