import type { Metadata } from "next";
import { Suspense } from "react";
import { IcemailView, type IcemailTab } from "@/components/icemail/IcemailView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { getIcemailBoard } from "@/lib/icemail-db";

export const metadata: Metadata = { title: "Icemail" };

type Search = { tab?: string };

export default function IcemailPage({ searchParams }: { searchParams: Promise<Search> }) {
  return (
    <>
      <PageHead title="Icemail" sub="Wallet, what to do with each domain before it renews, and new inboxes on free domains" />
      <div className="page-body">
        <Suspense fallback={<TableSkeleton rows={10} />}>
          <Board searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

async function Board({ searchParams }: { searchParams: Promise<Search> }) {
  await getCurrentUser();
  const { tab } = await searchParams;
  const initialTab: IcemailTab = tab === "orders" || tab === "cancels" ? tab : "domains";
  return <IcemailView board={await getIcemailBoard()} dryRun={process.env.INTEGRATIONS_DRY_RUN !== "false"} initialTab={initialTab} />;
}
