import type { Metadata } from "next";
import { Suspense } from "react";
import { StatsView } from "@/components/stats/StatsView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { getReview, getStats, lastDays, listClients } from "@/lib/queries";
import { PRESETS, presetRange, type PresetKey } from "@/lib/range";

export const metadata: Metadata = { title: "Stats" };

export default function StatsPage({ searchParams }: PageProps<"/stats">) {
  return (
    <>
      <PageHead title="Performance" sub="Sent, replies and bounces per domain or per day, for any date range" />
      <div className="page-body">
        <Suspense fallback={<TableSkeleton rows={12} />}>
          <StatsData searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

async function StatsData({ searchParams }: { searchParams: PageProps<"/stats">["searchParams"] }) {
  await getCurrentUser();
  // Today unless a link asks for another range (?range=7d).
  const asked = (await searchParams).range;
  const key: PresetKey = typeof asked === "string" && asked !== "custom" && PRESETS.some((p) => p.key === asked) ? (asked as PresetKey) : "today";
  const { to: today } = await lastDays(1);
  const [from, to] = presetRange(key, today) ?? [today, today];
  const [data, review, clients] = await Promise.all([getStats(from, to), getReview(from, to), listClients()]);
  return <StatsView initial={data} initialReview={review} clients={clients} />;
}
