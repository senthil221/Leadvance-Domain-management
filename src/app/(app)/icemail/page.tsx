import type { Metadata } from "next";
import { Suspense } from "react";
import { IcemailView } from "@/components/icemail/IcemailView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { getIcemailBoard } from "@/lib/icemail-db";

export const metadata: Metadata = { title: "Icemail" };

export default function IcemailPage() {
  return (
    <>
      <PageHead title="Icemail" sub="Wallet, what to do with each domain before it renews, and new inboxes on free domains" />
      <div className="page-body">
        <Suspense fallback={<TableSkeleton rows={10} />}>
          <Board />
        </Suspense>
      </div>
    </>
  );
}

async function Board() {
  await getCurrentUser();
  return <IcemailView board={await getIcemailBoard()} dryRun={process.env.INTEGRATIONS_DRY_RUN !== "false"} />;
}
