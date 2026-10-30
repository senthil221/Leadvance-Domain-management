import type { Metadata } from "next";
import { Suspense } from "react";
import { StatsView } from "@/components/stats/StatsView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { getReview, getStats, listClients, thisWeek } from "@/lib/queries";

export const metadata: Metadata = { title: "Stats" };

export default function StatsPage() {
  return (
    <>
      <PageHead title="Performance" sub="Sent, replies and bounces per domain or per day, for any date range" />
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
  const { from, to } = await thisWeek(); // Monday to today; the date picker changes it
  const [data, review, clients] = await Promise.all([getStats(from, to), getReview(from, to), listClients()]);
  return <StatsView initial={data} initialReview={review} clients={clients} />;
}
