import type { Metadata } from "next";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ReplacementsView } from "@/components/replacements/ReplacementsView";
import { PageHead, Skeleton } from "@/components/ui";
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
  const { rows, now } = await listReplacements();
  const running = rows.some((r) => !r.completedAt);
  return (
    <>
      {running ? <AutoRefresh seconds={10} /> : null}
      <ReplacementsView rows={rows} now={now}
        smartleadLive={Boolean(process.env.SMARTLEAD_API_KEY) && process.env.INTEGRATIONS_DRY_RUN === "false"} />
    </>
  );
}

function ReplacementsSkeleton() {
  return (
    <>
      <div className="ev-cards is-5">
        {Array.from({ length: 5 }, (_, i) => <div key={i} className="ev-card"><Skeleton w={80} h={11} /><Skeleton w={36} h={20} /></div>)}
      </div>
      {[0, 1].map((k) => (
        <div key={k} className="rp-item">
          <div className="rp-head"><Skeleton w={280} h={14} /></div>
          <div className="rp-track">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} w={90} h={12} />)}</div>
        </div>
      ))}
    </>
  );
}
