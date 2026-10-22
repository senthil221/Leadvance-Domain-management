import type { Metadata } from "next";
import { Suspense } from "react";
import { EventsView } from "@/components/activity/EventsView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { getEvents, lastDays } from "@/lib/queries";

export const metadata: Metadata = { title: "Bounces" };

export default function BouncesPage() {
  return (
    <>
      <PageHead title="Performance" sub="Bounces by client and domain, with the reason from each bounce notice" />
      <div className="page-body">
        <Suspense fallback={<TableSkeleton rows={10} />}>
          <BouncesData />
        </Suspense>
      </div>
    </>
  );
}

async function BouncesData() {
  await getCurrentUser();
  const { from, to } = await lastDays(7);
  return <EventsView kind="bounce" initial={await getEvents("bounce", from, to)} />;
}
