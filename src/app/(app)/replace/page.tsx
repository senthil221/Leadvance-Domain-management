import type { Metadata } from "next";
import { Suspense } from "react";
import { ReplaceList } from "@/components/replace/ReplaceList";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { getReplaceList } from "@/lib/queries";

export const metadata: Metadata = { title: "Replace list" };

export default function ReplacePage() {
  return (
    <>
      <PageHead title="Replace list" sub="The sending domains worth replacing this week, with the numbers behind each call" />
      <div className="page-body">
        <Suspense fallback={<TableSkeleton rows={10} />}>
          <ReplaceData />
        </Suspense>
      </div>
    </>
  );
}

async function ReplaceData() {
  await getCurrentUser();
  return <ReplaceList data={await getReplaceList()} />;
}
