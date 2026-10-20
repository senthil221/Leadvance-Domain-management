import type { Metadata } from "next";
import { Suspense } from "react";
import { StatsView } from "@/components/stats/StatsView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { getStats, listClients } from "@/lib/queries";

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
  // The last 7 days in the stats timezone, today included.
  const [{ from, to }] = await sql<{ from: string; to: string }[]>`
    with t as (select (now() at time zone coalesce((select value #>> '{}' from settings where key = 'stats_timezone'), 'UTC'))::date as d)
    select to_char(d - 6, 'YYYY-MM-DD') as from, to_char(d, 'YYYY-MM-DD') as to from t`;
  const [data, clients] = await Promise.all([getStats(from, to), listClients()]);
  return <StatsView initial={data} clients={clients} />;
}
