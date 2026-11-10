import type { Metadata } from "next";
import { Suspense } from "react";
import { AuditView } from "@/components/inventory/AuditView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { getDomainAudit } from "@/lib/queries";

export const metadata: Metadata = { title: "Audit" };

export default function AuditPage() {
  return (
    <>
      <PageHead title="Domains" sub="Every domain checked against its registrar account and the registry: what isn't really ours any more, to archive, and what doesn't add up" />
      <div className="page-body">
        <Suspense fallback={<TableSkeleton rows={8} />}>
          <Audit />
        </Suspense>
      </div>
    </>
  );
}

async function Audit() {
  await getCurrentUser();
  const { rows, accounts, progress } = await getDomainAudit();
  return <AuditView rows={rows} accounts={accounts} progress={progress} today={new Date().toISOString().slice(0, 10)} />;
}
