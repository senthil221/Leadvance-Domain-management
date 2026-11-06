import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { InventoryView } from "@/components/inventory/InventoryView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { int } from "@/lib/format";
import { listClients, listDomains } from "@/lib/queries";

export const metadata: Metadata = { title: "Free domains" };

export default function FreeDomainsPage() {
  return (
    <>
      <PageHead title="Domains" sub="Bought and never touched: no email vendor, no inboxes, no orders, not expired, and on the registrar's default nameservers or none" />
      <div className="page-body">
        <Suspense fallback={<TableSkeleton rows={8} />}>
          <FreeDomains />
        </Suspense>
      </div>
    </>
  );
}

async function FreeDomains() {
  await getCurrentUser();
  const [domains, clients] = await Promise.all([listDomains(), listClients()]);
  const free = domains.filter((d) => d.isFree);
  // In storage but not free: say why, so the two numbers can be squared.
  const rest = domains.filter((d) => d.status === "in_storage" && !d.expired && !d.isFree);
  const used = rest.filter((d) => d.everUsed).length;
  const pointed = rest.length - used;

  return (
    <>
      <InventoryView domains={free} clients={clients} freeOnly />
      {rest.length ? (
        <p className="text-[12.5px] text-muted">
          {int(rest.length)} more in storage aren&apos;t counted as free:{" "}
          {used ? `${int(used)} used before` : null}{used && pointed ? ", " : null}{pointed ? `${int(pointed)} pointed at other nameservers` : null}.{" "}
          <Link href="/inventory?view=free" className="hover:underline">See them in Inventory</Link>
        </p>
      ) : null}
    </>
  );
}
