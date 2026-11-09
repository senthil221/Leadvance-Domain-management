import type { Metadata } from "next";
import { Suspense } from "react";
import { FreeDomainsView } from "@/components/inventory/FreeDomainsView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { FREE_MIN_DAYS } from "@/lib/expiring";
import { listClients, listDomains } from "@/lib/queries";

export const metadata: Metadata = { title: "Free domains" };

export default function FreeDomainsPage() {
  return (
    <>
      <PageHead title="Domains" sub="Bought and never touched: no email vendor, inboxes or orders, not expired, on default nameservers or none" />
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
  // Never used, but running out too soon to be worth warming up.
  const expiring = rest.filter((d) => !d.everUsed && d.daysToExpiry !== null && d.daysToExpiry <= FREE_MIN_DAYS).length;

  return (
    <FreeDomainsView domains={free} clients={clients} used={used} expiring={expiring} pointed={rest.length - used - expiring} />
  );
}
