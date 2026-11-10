import type { Metadata } from "next";
import { Suspense } from "react";
import { PlacementView } from "@/components/placement/PlacementView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { lastSeedSync, listSeeds } from "@/lib/placement-seeds-db";
import { nextSaturday } from "@/lib/placement-tests";
import { listBatches, statsTimezone, testCandidates } from "@/lib/placement-tests-db";

export const metadata: Metadata = { title: "Placement" };

export default function PlacementPage() {
  return (
    <>
      <PageHead title="Placement" sub="Test whether a domain's emails reach the inbox: seeds whose auto-reply says the person has left answer only when the mail didn't go to spam" />
      <div className="page-body">
        <Suspense fallback={<TableSkeleton rows={12} />}>
          <PlacementData />
        </Suspense>
      </div>
    </>
  );
}

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

async function PlacementData() {
  await getCurrentUser();
  const [seeds, seedSync, batches, candidates, timezone, [testRun]] = await Promise.all([
    listSeeds(), lastSeedSync(), listBatches(), testCandidates(), statsTimezone(),
    sql<{ finishedAt: string | null; ok: boolean | null; error: string | null }[]>`
      select last_finished_at as finished_at, last_ok as ok, last_error as error from job_state where job = 'placement-tests'`,
  ]);
  return (
    <PlacementView
      seeds={seeds.map((s) => ({
        ...s, firstReplyAt: iso(s.firstReplyAt)!, lastReplyAt: iso(s.lastReplyAt)!, personRepliedAt: iso(s.personRepliedAt),
        bouncedAt: iso(s.bouncedAt), checkedAt: iso(s.checkedAt),
      }))}
      seedSync={seedSync ? { ...seedSync, finishedAt: iso(seedSync.finishedAt) } : null}
      batches={batches}
      candidates={candidates}
      testRun={testRun ? { ...testRun, finishedAt: iso(testRun.finishedAt) } : null}
      saturday={nextSaturday(timezone)}
      timezone={timezone} />
  );
}
