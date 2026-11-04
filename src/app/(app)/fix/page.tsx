import type { Metadata } from "next";
import { Suspense } from "react";
import { FixQueue } from "@/components/fix/FixQueue";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { FIX_KINDS, type FixKind } from "@/lib/fix-queue";
import { getFixQueue } from "@/lib/queries";

export const metadata: Metadata = { title: "Fix queue" };

type Search = { client?: string; kind?: string };

export default function FixPage({ searchParams }: { searchParams: Promise<Search> }) {
  return (
    <>
      <PageHead title="Fix queue" sub="Every problem on your live domains, worst first, with what to do next" />
      <div className="page-body">
        <Suspense fallback={<TableSkeleton rows={12} />}>
          <FixData searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

async function FixData({ searchParams }: { searchParams: Promise<Search> }) {
  await getCurrentUser();
  const search = await searchParams;
  const kind = FIX_KINDS.includes(search.kind as FixKind) ? (search.kind as FixKind) : null;
  return <FixQueue data={await getFixQueue()} startClient={search.client ?? ""} startKind={kind} />;
}
