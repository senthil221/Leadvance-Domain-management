import type { Metadata } from "next";
import { Suspense } from "react";
import { UntrackedView } from "@/components/untracked/UntrackedView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { lastUntrackedSync, listUntrackedReplies } from "@/lib/untracked-replies-db";

export const metadata: Metadata = { title: "Untracked replies" };

const HANDLED_DAYS = 14;

export default function UntrackedPage() {
  return (
    <>
      <PageHead title="Smartlead" sub="Replies Smartlead couldn't tie to a campaign lead, read every 15 minutes and copied to the account managers' sheet" />
      <div className="page-body">
        <Suspense fallback={<TableSkeleton rows={12} />}>
          <UntrackedData />
        </Suspense>
      </div>
    </>
  );
}

async function UntrackedData() {
  await getCurrentUser();
  const [rows, sync] = await Promise.all([listUntrackedReplies({ handledDays: HANDLED_DAYS }), lastUntrackedSync()]);
  const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
  return (
    <UntrackedView
      handledDays={HANDLED_DAYS}
      lastSync={sync ? { ...sync, finishedAt: iso(sync.finishedAt) } : null}
      rows={rows.map((r) => ({
        id: r.id, subject: r.subject, senderName: r.senderName, senderEmail: r.senderEmail,
        recipientName: r.recipientName, recipientEmail: r.recipientEmail, body: r.body,
        receivedAt: iso(r.receivedAt), firstSeenAt: iso(r.firstSeenAt)!, handledAt: iso(r.handledAt),
        client: r.client, domain: r.domain,
      }))} />
  );
}
