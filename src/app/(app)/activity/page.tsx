import type { Metadata } from "next";
import { Suspense } from "react";
import { RepliesView } from "@/components/activity/RepliesView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { listReplies } from "@/lib/queries";

export const metadata: Metadata = { title: "Replies" };

export default function RepliesPage() {
  return (
    <>
      <PageHead title="Replies" sub="Every reply from Smartlead, sorted into human, out of office and the rest" />
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
  return <RepliesView replies={await listReplies()} />;
}
