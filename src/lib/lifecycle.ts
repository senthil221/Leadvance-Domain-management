import type { DomainRow } from "./queries";
import type { Tone } from "./status";

// Inventory wording for where a domain is in its life, where its nameservers
// point and what Hypertide knows about it. Shared by server and client code.

export type Life = "free" | "setup" | "active" | "replaced" | "retired";
export const LIFE: Record<Life, { label: string; tone: Tone }> = {
  free: { label: "Free", tone: "faint" },
  setup: { label: "Setting up", tone: "info" },
  active: { label: "Active", tone: "success" },
  replaced: { label: "Replaced", tone: "warning" },
  retired: { label: "Retired", tone: "danger" },
};
export const LIFE_ORDER: Life[] = ["free", "setup", "active", "replaced", "retired"];

export function lifeOf(d: Pick<DomainRow, "status" | "replacedById">): Life {
  if (d.status === "in_storage") return "free";
  if (d.status === "provisioning" || d.status === "warming") return "setup";
  if (d.status === "active") return "active";
  return d.replacedById ? "replaced" : "retired";
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

/**
 * The nameserver cell: where the domain points (the DNS host), a status in
 * a word or two, the full pair for the tooltip and, when a person has to set
 * it, the pair to copy.
 */
export type Ns = { host: string | null; status: string; tone: Tone; title?: string; copy?: string[] };
export function nsOf(d: Pick<DomainRow, "nameservers" | "nsRequestStatus" | "nsRequestMessage" | "nsRequestTarget"> & Partial<Pick<DomainRow, "nameserversAnswering">>): Ns {
  const ns = d.nameservers ?? [];
  const target = d.nsRequestTarget ?? undefined;
  const host = dnsHost(ns);
  const now = ns.length ? `Now: ${ns.join(", ")}` : "No nameservers found yet";
  switch (d.nsRequestStatus) {
    case "pending": case "running":
      return { host: target ? dnsHost(target) : host, status: "Switching", tone: "info", title: `Switching to ${target?.join(", ") ?? "the new pair"}. ${now}` };
    case "manual":
      return { host: dnsHost(target ?? []) ?? host, status: "Set at registrar", tone: "warning", title: `${d.nsRequestMessage ?? "Set these by hand"}: ${target?.join(", ")}. ${now}`, copy: target };
    case "failed":
      return { host, status: "Switch failed", tone: "danger", title: `${d.nsRequestMessage ?? "The change failed"}. ${now}` };
    case "dry_run":
      return { host, status: "Dry run", tone: "faint", title: `Would switch to ${target?.join(", ")}. ${now}`, copy: target };
  }
  if (!ns.length) return { host: null, status: "Not checked", tone: "faint" };
  if (d.nameserversAnswering === false) {
    return { host, status: "No DNS zone", tone: "danger", title: `The domain points to ${ns.join(", ")}, but ${host ?? "that host"} has no DNS zone for it, so the domain doesn't resolve: no website, no email. Point it to its Hypertide pair (Set up) or create the zone at ${host ?? "that host"}.` };
  }
  if (host === "Porkbun") return { host, status: "Parked", tone: "faint", title: `Porkbun's default nameservers: not set up for sending yet. ${now}` };
  return { host, status: "Live", tone: "success", title: now };
}

export function htOf(d: Pick<DomainRow, "htOrderStatus" | "htPayment">): { label: string; tone: Tone } | null {
  if (!d.htOrderStatus && !d.htPayment) return null;
  const pay = (d.htPayment ?? "").toLowerCase();
  if (pay.includes("recovery")) return { label: "Recovery pool", tone: "violet" };
  if (pay && !pay.startsWith("paid")) return { label: "Unpaid", tone: "warning" };
  if (d.htOrderStatus === "Done") return { label: "Done", tone: "success" };
  // NPC: Hypertide is waiting for the domain's nameservers to change.
  if (d.htOrderStatus === "NPC") return { label: "Waiting for NS", tone: "warning" };
  return { label: d.htOrderStatus ?? "Ordered", tone: "info" };
}

