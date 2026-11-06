import type { Metadata } from "next";
import { Suspense } from "react";
import { ExpiringView } from "@/components/inventory/ExpiringView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { isExpiryTracked } from "@/lib/expiring";
import { listDomains } from "@/lib/queries";

export const metadata: Metadata = { title: "Expiring" };

export default function ExpiringPage() {
  return (
    <>
      <PageHead title="Domains" sub="Active and warming domains running out, soonest first, so you can renew or replace them in time" />
      <div className="page-body">
        <Suspense fallback={<TableSkeleton rows={8} />}>
          <Expiring />
        </Suspense>
      </div>
    </>
  );
}

async function Expiring() {
  await getCurrentUser();
  const domains = await listDomains();
  return <ExpiringView domains={domains.filter(isExpiryTracked)} free={domains.filter((d) => d.isFree).length} />;
}
