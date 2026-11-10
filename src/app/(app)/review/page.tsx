import type { Metadata } from "next";
import { Suspense } from "react";
import { ReviewView } from "@/components/review/ReviewView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { getReview, listClients, lastDays } from "@/lib/queries";

export const metadata: Metadata = { title: "Weekly review" };

export default function ReviewPage() {
  return (
    <>
      <PageHead title="Performance" sub="Which domains to fix, rest or watch, and why" />
      <div className="page-body">
        <Suspense fallback={<TableSkeleton rows={12} />}>
          <ReviewData />
        </Suspense>
      </div>
    </>
  );
}

async function ReviewData() {
  await getCurrentUser();
  const { from, to } = await lastDays(1); // Today; the date picker changes it
  const [data, clients] = await Promise.all([getReview(from, to), listClients()]);
  return <ReviewView initial={data} clients={clients} />;
}
