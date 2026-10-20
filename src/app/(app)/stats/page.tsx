import type { Metadata } from "next";
import { Suspense } from "react";
import { StatsView } from "@/components/stats/StatsView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { listClients, listDomainStats } from "@/lib/queries";

export const metadata: Metadata = { title: "Stats" };

export default function StatsPage() {
  return (
    <>
      <PageHead title="Stats" sub="Sent, replies and bounces per domain, against the period before" />
      <div className="page-body">
        <Suspense fallback={<TableSkeleton rows={12} />}>
          <StatsData />
        </Suspense>
      </div>
    </>
  );
}

async function StatsData() {
  await getCurrentUser();
  const [rows, clients] = await Promise.all([listDomainStats(), listClients()]);
  return <StatsView rows={rows} clients={clients} />;
}
