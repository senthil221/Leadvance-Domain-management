import type { Metadata } from "next";
import { Suspense } from "react";
import { SeedsView } from "@/components/placement/SeedsView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { lastSeedSync, listSeeds } from "@/lib/placement-seeds-db";

export const metadata: Metadata = { title: "Placement" };

export default function PlacementPage() {
  return (
    <>
      <PageHead title="Placement" sub="Addresses whose auto-reply says the person has left. Nobody reads them, so whether they auto-reply shows if an email reached the inbox" />
      <div className="page-body">
        <Suspense fallback={<TableSkeleton rows={12} />}>
          <SeedsData />
        </Suspense>
      </div>
    </>
  );
}

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

async function SeedsData() {
  await getCurrentUser();
  const [seeds, sync] = await Promise.all([listSeeds(), lastSeedSync()]);
  return (
    <SeedsView
      seeds={seeds.map((s) => ({
        ...s, firstReplyAt: iso(s.firstReplyAt)!, lastReplyAt: iso(s.lastReplyAt)!, personRepliedAt: iso(s.personRepliedAt),
        bouncedAt: iso(s.bouncedAt), checkedAt: iso(s.checkedAt),
      }))}
      lastSync={sync ? { ...sync, finishedAt: iso(sync.finishedAt) } : null} />
  );
}
