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
      <PageHead title="Replace list" sub="Which sending domains to replace, from the last 7 days up to today. Check it any day" />
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
