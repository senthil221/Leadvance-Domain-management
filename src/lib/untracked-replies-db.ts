import "server-only";
import { sql } from "@/lib/db";

// Untracked replies for the page and the account managers' sheet, with the
// client and domain of the inbox each one came in on. `kind` is set by the
// database (untracked_kind): 'reply' to a campaign email ("Re: For …"),
// 'bounce', or 'other' (warm-up traffic and stray mail).

export type UntrackedKind = "reply" | "bounce" | "other";

export type UntrackedRow = {
  id: string;
  kind: UntrackedKind;
  subject: string | null;
  senderName: string | null;
  senderEmail: string | null;
  recipientName: string | null;
  recipientEmail: string | null;
  body: string | null;
  receivedAt: string | null;
  firstSeenAt: string;
  handledAt: string | null;
  accountId: number | null;
  client: string | null;
  domain: string | null;
};

/**
 * Replies newest first. `view`: waiting campaign replies, waiting bounces and
 * other mail, or campaign replies handled in the last `handledDays` days.
 */
export async function listUntrackedReplies({ view = "replies", handledDays = 14, limit = 20_000 }: {
  view?: "replies" | "other" | "handled"; handledDays?: number; limit?: number;
} = {}): Promise<UntrackedRow[]> {
  const where = view === "replies" ? sql`u.handled_at is null and u.kind = 'reply'`
    : view === "other" ? sql`u.handled_at is null and u.kind <> 'reply'`
    : sql`u.kind = 'reply' and u.handled_at > now() - make_interval(days => ${handledDays})`;
  return sql<UntrackedRow[]>`
    select u.id, u.kind, u.subject, u.sender_name, u.sender_email, u.recipient_name, u.recipient_email, u.body,
      u.received_at, u.first_seen_at, u.handled_at, u.account_id, c.name as client, d.name as domain
    from untracked_replies u
    left join inboxes i on i.smartlead_account_id = u.account_id
    left join domains d on d.id = i.domain_id
    left join clients c on c.id = d.client_id
    where ${where}
    order by coalesce(u.received_at, u.first_seen_at) desc
    limit ${limit}`;
}

/** How many are in each view. */
export async function countUntracked(handledDays = 14) {
  const [row] = await sql<{ replies: number; other: number; handled: number }[]>`
    select count(*) filter (where handled_at is null and kind = 'reply')::int as replies,
      count(*) filter (where handled_at is null and kind <> 'reply')::int as other,
      count(*) filter (where kind = 'reply' and handled_at > now() - make_interval(days => ${handledDays}))::int as handled
    from untracked_replies`;
  return row ?? { replies: 0, other: 0, handled: 0 };
}

/** When the untracked-replies job last finished, and how. */
export async function lastUntrackedSync() {
  const [row] = await sql<{ finishedAt: string | null; ok: boolean | null; error: string | null }[]>`
    select last_finished_at as finished_at, last_ok as ok, coalesce(last_error, last_detail->>'skipped') as error
    from job_state where job = 'untracked-replies'`;
  return row ?? null;
}
