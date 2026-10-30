import type { Metadata } from "next";
import { Suspense } from "react";
import { EventsView } from "@/components/activity/EventsView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { getEvents, thisWeek } from "@/lib/queries";

export const metadata: Metadata = { title: "Replies" };

export default function RepliesPage() {
  return (
    <>
      <PageHead title="Performance" sub="Replies by client and domain, sorted into human, out of office and the rest" />
      <div className="page-body">
        <Suspense fallback={<TableSkeleton rows={10} />}>
          <RepliesData />
        </Suspense>
      </div>
    </>
  );
}

async function RepliesData() {
  await getCurrentUser();
  const { from, to } = await thisWeek(); // Monday to today; the date picker changes it
  return <EventsView kind="reply" initial={await getEvents("reply", from, to)} />;
}
