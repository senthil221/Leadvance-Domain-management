import type { Metadata } from "next";
import { Suspense } from "react";
import { InboxesView } from "@/components/inboxes/InboxesView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { listClients, listInboxes, listSendingPlans } from "@/lib/queries";

export const metadata: Metadata = { title: "Inboxes" };

export default function InboxesPage() {
  return (
    <>
      <PageHead title="Inboxes" sub="Sending inboxes in Smartlead with their warmup and daily limits" />
      <div className="page-body">
        <Suspense fallback={<TableSkeleton rows={12} />}>
          <InboxesData />
        </Suspense>
      </div>
    </>
  );
}

async function InboxesData() {
  await getCurrentUser();
  const [inboxes, clients, plans, [tz]] = await Promise.all([
    listInboxes(), listClients(), listSendingPlans(),
    sql<{ tz: string | null }[]>`select value #>> '{}' as tz from settings where key = 'stats_timezone'`,
  ]);
  return (
    <InboxesView inboxes={inboxes} clients={clients} plans={plans} timezone={tz?.tz || "UTC"}
      smartleadConnected={Boolean(process.env.SMARTLEAD_API_KEY)} dryRun={process.env.INTEGRATIONS_DRY_RUN !== "false"} />
  );
}
