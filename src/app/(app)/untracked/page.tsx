import type { Metadata } from "next";
import { Suspense } from "react";
import { UntrackedView, type UntrackedItem } from "@/components/untracked/UntrackedView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { countUntracked, lastUntrackedSync, listUntrackedReplies, type UntrackedRow } from "@/lib/untracked-replies-db";

export const metadata: Metadata = { title: "Untracked replies" };

const HANDLED_DAYS = 14;
/** Bounces and warm-up mail can run to thousands: the page shows the latest only. */
const OTHER_SHOWN = 300;
/** Text sent to the page for each reply; the sheet gets it whole. */
const BODY_SHOWN = 6000;

export default function UntrackedPage() {
  return (
    <>
      <PageHead title="Smartlead" sub="Replies to campaign emails that Smartlead couldn't tie to a lead, read every 15 minutes and copied to the account managers' sheet" />
      <div className="page-body">
        <Suspense fallback={<TableSkeleton rows={12} />}>
          <UntrackedData />
        </Suspense>
      </div>
    </>
  );
}

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

function item(r: UntrackedRow): UntrackedItem {
  return {
    id: r.id, kind: r.kind, subject: r.subject, senderName: r.senderName, senderEmail: r.senderEmail,
    recipientName: r.recipientName, recipientEmail: r.recipientEmail,
    body: r.body && r.body.length > BODY_SHOWN ? `${r.body.slice(0, BODY_SHOWN)}…` : r.body,
    receivedAt: iso(r.receivedAt), firstSeenAt: iso(r.firstSeenAt)!, handledAt: iso(r.handledAt),
    client: r.client, domain: r.domain,
  };
}

async function UntrackedData() {
  await getCurrentUser();
  const [replies, other, handled, counts, sync] = await Promise.all([
    listUntrackedReplies({ view: "replies" }),
    listUntrackedReplies({ view: "other", limit: OTHER_SHOWN }),
    listUntrackedReplies({ view: "handled", handledDays: HANDLED_DAYS, limit: 1000 }),
    countUntracked(HANDLED_DAYS),
    lastUntrackedSync(),
  ]);
  return (
    <UntrackedView
      handledDays={HANDLED_DAYS}
      counts={counts}
      lastSync={sync ? { ...sync, finishedAt: iso(sync.finishedAt) } : null}
      replies={replies.map(item)} other={other.map(item)} handled={handled.map(item)} />
  );
}
