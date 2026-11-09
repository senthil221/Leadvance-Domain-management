import "server-only";
import { sql } from "@/lib/db";

// Untracked replies for the page and the account managers' sheet, with the
// client and domain of the inbox each one came in on.

export type UntrackedRow = {
  id: string;
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

/** Open replies, newest first; with `handledDays`, also those handled in that many days. */
export async function listUntrackedReplies({ handledDays = 0, limit = 5000 } = {}): Promise<UntrackedRow[]> {
  return sql<UntrackedRow[]>`
    select u.id, u.subject, u.sender_name, u.sender_email, u.recipient_name, u.recipient_email, u.body,
      u.received_at, u.first_seen_at, u.handled_at, u.account_id, c.name as client, d.name as domain
    from untracked_replies u
    left join inboxes i on i.smartlead_account_id = u.account_id
    left join domains d on d.id = i.domain_id
    left join clients c on c.id = d.client_id
    where u.handled_at is null or u.handled_at > now() - make_interval(days => ${handledDays})
    order by coalesce(u.received_at, u.first_seen_at) desc
    limit ${limit}`;
}

/** When the untracked-replies job last finished, and how. */
export async function lastUntrackedSync() {
  const [row] = await sql<{ finishedAt: string | null; ok: boolean | null; error: string | null }[]>`
    select last_finished_at as finished_at, last_ok as ok, coalesce(last_error, last_detail->>'skipped') as error
    from job_state where job = 'untracked-replies'`;
  return row ?? null;
}
