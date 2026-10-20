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

type Ns = { label: string; tone: Tone; title?: string; copy?: string[] };
export function nsOf(d: Pick<DomainRow, "nameservers" | "nsRequestStatus" | "nsRequestMessage" | "nsRequestTarget">): Ns {
  const target = d.nsRequestTarget ?? undefined;
  switch (d.nsRequestStatus) {
    case "pending": case "running": return { label: "Updating…", tone: "info" };
    case "manual": return { label: "Set by hand", tone: "warning", title: `${d.nsRequestMessage ?? ""}: ${target?.join(", ")}`, copy: target };
    case "failed": return { label: "Update failed", tone: "danger", title: d.nsRequestMessage ?? undefined };
    case "dry_run": return { label: "Dry run", tone: "faint", title: `Would set ${target?.join(", ")}`, copy: target };
  }
  const ns = d.nameservers ?? [];
  if (!ns.length) return { label: "Not checked", tone: "faint" };
  const title = ns.join(", ");
  if (ns.every((n) => n.endsWith(".ns.cloudflare.com"))) return { label: "Cloudflare", tone: "success", title };
  if (ns.some((n) => n.includes("porkbun"))) return { label: "Porkbun default", tone: "faint", title };
  return { label: "Other", tone: "faint", title };
}

export function htOf(d: Pick<DomainRow, "htOrderStatus" | "htPayment">): { label: string; tone: Tone } | null {
  if (!d.htOrderStatus && !d.htPayment) return null;
  if (d.htPayment && d.htPayment !== "Paid") return { label: "Unpaid", tone: "warning" };
  if (d.htOrderStatus === "Done") return { label: "Done", tone: "success" };
  return { label: d.htOrderStatus ?? "Ordered", tone: "info" };
}

