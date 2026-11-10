import type { Metadata } from "next";
import { Suspense } from "react";
import { CompareView } from "@/components/compare/CompareView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { DIMS, type Dim } from "@/lib/compare";
import { getCompareDaily, getReview, lastDays } from "@/lib/queries";

export const metadata: Metadata = { title: "Compare" };

type Search = { client?: string; dim?: string; group?: string };

export default function ComparePage({ searchParams }: { searchParams: Promise<Search> }) {
  return (
    <>
      <PageHead title="Performance" sub="Compare TLDs, providers, ESPs, tags, clients and domain ages, to see what's working and why" />
      <div className="page-body">
        <Suspense fallback={<TableSkeleton rows={10} />}>
          <CompareData searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

async function CompareData({ searchParams }: { searchParams: Promise<Search> }) {
  await getCurrentUser();
  const search = await searchParams;
  // Today by default; the date picker changes it.
  const { from, to } = await lastDays(1);
  const [initial, daily] = await Promise.all([getReview(from, to), getCompareDaily(from, to)]);
  const dim = DIMS.includes(search.dim as Dim) ? (search.dim as Dim) : undefined;
  return <CompareView initial={initial} initialDaily={daily} startClient={search.client ?? ""} startDim={dim} startGroup={search.group ?? null} />;
}
