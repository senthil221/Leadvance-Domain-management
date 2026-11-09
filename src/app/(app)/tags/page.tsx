import type { Metadata } from "next";
import { Suspense } from "react";
import { TagsView } from "@/components/tags/TagsView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { jwtProblem } from "@/integrations/smartlead-app";
import { loadTagBoard } from "@/lib/tag-board-db";

export const metadata: Metadata = { title: "Tags" };

export default function TagsPage() {
  return (
    <>
      <PageHead title="Smartlead" sub="Every tag with its domains, sender and volume a day; push free domains onto a tag to reach its target" />
      <div className="page-body">
        <Suspense fallback={<TableSkeleton rows={12} />}>
          <TagsData />
        </Suspense>
      </div>
    </>
  );
}

async function TagsData() {
  await getCurrentUser();
  const board = await loadTagBoard();
  const jwt = process.env.SMARTLEAD_JWT?.trim().replace(/^bearer\s+/i, "");
  return (
    <TagsView {...board} dryRun={process.env.INTEGRATIONS_DRY_RUN !== "false"}
      appProblem={jwt ? jwtProblem(jwt) : "Changing tags needs a Smartlead token: save SMARTLEAD_JWT on the server."} />
  );
}
