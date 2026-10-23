import type { Metadata } from "next";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ReplacementsView } from "@/components/replacements/ReplacementsView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { listReplacements } from "@/lib/queries";

export const metadata: Metadata = { title: "Replacements" };

export default function ReplacementsPage() {
  return (
    <>
      <PageHead title="Domains" sub="Every swap from Hypertide to Smartlead, with warmup and the old domain's grace period" />
      <div className="page-body">
        <Suspense fallback={<ReplacementsSkeleton />}>
          <Replacements />
        </Suspense>
      </div>
    </>
  );
}

async function Replacements() {
  await getCurrentUser();
  const { rows, now, graceDays } = await listReplacements();
  const running = rows.some((r) => !r.completedAt);
  return (
    <>
      {running ? <AutoRefresh seconds={10} /> : null}
      <ReplacementsView rows={rows} now={now} graceDays={graceDays}
        smartleadLive={Boolean(process.env.SMARTLEAD_API_KEY) && process.env.INTEGRATIONS_DRY_RUN === "false"} />
    </>
  );
}

function ReplacementsSkeleton() {
  return <TableSkeleton rows={6} />;
}
