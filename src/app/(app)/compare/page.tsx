import type { Metadata } from "next";
import { Suspense } from "react";
import { CompareView } from "@/components/compare/CompareView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { getReview, thisWeek } from "@/lib/queries";

export const metadata: Metadata = { title: "Compare" };

export default function ComparePage() {
  return (
    <>
      <PageHead title="Performance" sub="Compare TLDs, providers, ESPs, tags, clients and domain ages, to see what's working and what isn't" />
      <div className="page-body">
        <Suspense fallback={<TableSkeleton rows={10} />}>
          <CompareData />
        </Suspense>
      </div>
    </>
  );
}

async function CompareData() {
  await getCurrentUser();
  const { from, to } = await thisWeek(); // Monday to today; the date picker changes it
  return <CompareView initial={await getReview(from, to)} />;
}
