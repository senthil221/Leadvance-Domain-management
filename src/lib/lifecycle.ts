import type { DomainRow } from "./queries";
import type { Tone } from "./status";
import { HT_DONE, inRecoveryPool, isHtCancelled } from "./states";

// Inventory wording for where a domain is in its life, where its nameservers
// point and what Hypertide knows about it. Shared by server and client code.

// Where a domain is in its life: sending, being set up, free in storage,
// cooling down (in storage but used too recently to pick again), replaced
// (draining or burned) or in recovery (resting, or in Hypertide's recovery pool).
export type Life = "active" | "setup" | "free" | "cooling" | "replaced" | "recovery" | "expired" | "unregistered";
export const LIFE: Record<Life, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "success" },
  setup: { label: "Setting up", tone: "info" },
  free: { label: "In storage", tone: "faint" },
  cooling: { label: "Cooling down", tone: "info" },
  replaced: { label: "Replaced", tone: "warning" },
  recovery: { label: "Recovery", tone: "violet" },
  expired: { label: "Expired", tone: "danger" },
  unregistered: { label: "Not registered", tone: "danger" },
};
export const LIFE_ORDER: Life[] = ["active", "setup", "free", "cooling", "replaced", "recovery", "expired", "unregistered"];
/** The Inventory tabs. */
export const LIFE_TABS: Life[] = ["active", "setup", "free", "cooling", "replaced", "recovery", "expired", "unregistered"];

export { inRecoveryPool };

/**
 * The Inventory tab for a domain: a view over domains.status (see
 * docs/state-machines.md), not a state of its own. Expired wins over
 * everything; storage splits on the reuse cool-down; draining and burned are
 * Replaced unless the domain sits in Hypertide's recovery pool.
 */
export function lifeOf(d: Pick<DomainRow, "status" | "htPayment"> & { coolingUntil?: Date | string | null; expired?: boolean; unregistered?: boolean }): Life {
  // Never registered (its registrar lists it with no expiry date): a tab of its own, whatever its status.
  if (d.unregistered) return "unregistered";
  // Past its renewal date, it's expired whatever else it says: never Active or Free.
  if (d.expired) return "expired";
  if (d.status === "in_storage") return d.coolingUntil ? "cooling" : "free";
  if (d.status === "provisioning" || d.status === "warming") return "setup";
  if (d.status === "active") return "active";
  return d.status === "resting" || inRecoveryPool(d.htPayment) ? "recovery" : "replaced";
}

// Who hosts a domain's DNS, from its nameserver names.
const HOSTS: [RegExp, string][] = [
  [/\.ns\.cloudflare\.com$/, "Cloudflare"], [/dnsimple/, "DNSimple"], [/porkbun/, "Porkbun"], [/domaincontrol\.com$/, "GoDaddy"],
  [/registrar-servers\.com$/, "Namecheap"], [/googledomains|ns-cloud/, "Google"], [/awsdns/, "AWS"], [/azure-dns/, "Azure"],
  [/unstoppable|ud-dns/, "Unstoppable"], [/hostinger|dns-parking/, "Hostinger"],
];
export function dnsHost(ns: string[]): string | null {
  if (!ns.length) return null;
  for (const [re, name] of HOSTS) if (ns.some((n) => re.test(n))) return name;
  const parts = ns[0].split(".");
  return parts.slice(-2).join(".");
}

// The nameservers registrars hand out by default. Mirrors ns_is_default() in the
// database, which decides what counts as free; tests keep the two in step.
const DEFAULT_NS = /porkbun|dyna-ns\.net|dynadot|spaceship\.net|ud-dns|unstoppable|registrar-servers\.com|domaincontrol\.com|dnsowl\.com|dns-parking\.com|hostinger/;
export const isDefaultNs = (ns: string[]) => ns.length > 0 && ns.every((n) => DEFAULT_NS.test(n.toLowerCase()));

/**
 * The nameserver cell: where the domain points (the DNS host), a status in
 * a word or two, the full pair for the tooltip and, when a person has to set
 * it, the pair to copy.
 */
export type Ns = { host: string | null; status: string; tone: Tone; title?: string; copy?: string[] };
export function nsOf(d: Pick<DomainRow, "nameservers" | "nsRequestStatus" | "nsRequestMessage" | "nsRequestTarget"> & Partial<Pick<DomainRow, "nameserversAnswering" | "nameserversCheckedAt" | "status">>): Ns {
  const ns = d.nameservers ?? [];
  const target = d.nsRequestTarget ?? undefined;
  const host = dnsHost(ns);
  const now = ns.length ? `Now: ${ns.join(", ")}` : "No nameservers found yet";
  switch (d.nsRequestStatus) {
    case "pending": case "running":
      return { host: target ? dnsHost(target) : host, status: "Switching", tone: "info", title: `Switching to ${target?.join(", ") ?? "the new pair"}. ${now}` };
    case "manual":
      return { host: dnsHost(target ?? []) ?? host, status: "Manual", tone: "warning", title: `${d.nsRequestMessage ?? "Set these by hand"}: ${target?.join(", ")}. ${now}`, copy: target };
    case "failed":
      return { host, status: "Failed", tone: "danger", title: `${d.nsRequestMessage ?? "The change failed"}. ${now}` };
    case "dry_run":
      return { host, status: "Dry run", tone: "faint", title: `Would switch to ${target?.join(", ")}. ${now}`, copy: target };
  }
  if (!ns.length) {
    return d.nameserversCheckedAt
      ? { host: null, status: "None", tone: "faint", title: "Looked up: public DNS, the registry and the registrar show no nameservers for this domain" }
      : { host: null, status: "Not checked", tone: "faint", title: "Not looked up yet" };
  }
  // Unused and as the registrar left it: nothing to serve yet, and that's fine.
  if (d.status === "in_storage" && isDefaultNs(ns)) {
    return { host, status: "Default", tone: "faint", title: `The registrar's default nameservers: not set up for sending yet. ${now}` };
  }
  if (d.nameserversAnswering === false) {
    return { host, status: "No zone", tone: "danger", title: `The domain points to ${ns.join(", ")}, but ${host ?? "that host"} has no DNS zone for it, so the domain doesn't resolve: no website, no email. Point it to its Hypertide pair (Set up) or create the zone at ${host ?? "that host"}.` };
  }
  if (isDefaultNs(ns)) return { host, status: "Default", tone: "faint", title: `The registrar's default nameservers: not set up for sending yet. ${now}` };
  return { host, status: "Live", tone: "success", title: now };
}

export function htOf(d: Pick<DomainRow, "htOrderStatus" | "htPayment">): { label: string; tone: Tone } | null {
  if (!d.htOrderStatus && !d.htPayment) return null;
  const pay = (d.htPayment ?? "").toLowerCase();
  if (inRecoveryPool(pay)) return { label: "Recovery pool", tone: "violet" };
  if (pay && !pay.startsWith("paid")) return { label: "Unpaid", tone: "warning" };
  if (d.htOrderStatus === HT_DONE) return { label: "Done", tone: "success" };
  // The API's "NPC" is what Hypertide's dashboard shows as Cancelled: no longer
  // billed. Either word reads the same here, as it does in the SQL.
  if (isHtCancelled(d.htOrderStatus)) return { label: "Cancelled", tone: "faint" };
  return { label: d.htOrderStatus ?? "Ordered", tone: "info" };
}

