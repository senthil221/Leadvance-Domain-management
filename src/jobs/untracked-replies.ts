import type postgres from "postgres";
import type { Smartlead } from "../integrations/smartlead";
import { parseReply, repliesOf, type UntrackedReply } from "../lib/untracked-replies";

// Untracked replies: every page of Smartlead's master-inbox list, kept in
// untracked_replies. A reply seen before is refreshed; one that is no longer on
// the list is marked handled, but only after a complete read, so a failed or
// cut-short run never marks anything.

export async function syncUntrackedReplies(sql: postgres.Sql, smartlead: Pick<Smartlead, "untrackedReplies">, { pageSize = 50, maxPages = 400 } = {}) {
  const byId = new Map<string, UntrackedReply>();
  let complete = false;
  let pages = 0;
  for (; pages < maxPages; pages++) {
    const page = await smartlead.untrackedReplies(pages * pageSize, pageSize);
    const rows = repliesOf(page);
    if (!rows) throw new Error(`Smartlead's untracked replies came back without a list of replies: ${JSON.stringify(page).slice(0, 200)}`);
    for (const r of rows) {
      const reply = parseReply(r);
      if (reply) byId.set(reply.id, reply);
    }
    if (rows.length < pageSize) { complete = true; pages++; break; }
  }

  let added = 0;
  for (const r of byId.values()) {
    const [row] = await sql<{ inserted: boolean }[]>`
      insert into untracked_replies (id, account_id, subject, sender_name, sender_email, recipient_name, recipient_email, body, received_at)
      values (${r.id}, ${r.accountId}, ${r.subject}, ${r.senderName}, ${r.senderEmail}, ${r.recipientName}, ${r.recipientEmail}, ${r.body}, ${r.receivedAt})
      on conflict (id) do update set
        account_id = coalesce(excluded.account_id, untracked_replies.account_id),
        subject = coalesce(excluded.subject, untracked_replies.subject),
        sender_name = coalesce(excluded.sender_name, untracked_replies.sender_name),
        sender_email = coalesce(excluded.sender_email, untracked_replies.sender_email),
        recipient_name = coalesce(excluded.recipient_name, untracked_replies.recipient_name),
        recipient_email = coalesce(excluded.recipient_email, untracked_replies.recipient_email),
        body = coalesce(excluded.body, untracked_replies.body),
        received_at = coalesce(excluded.received_at, untracked_replies.received_at),
        last_seen_at = now(),
        handled_at = null
      returning (xmax = 0) as inserted`;
    if (row?.inserted) added++;
  }

  let handled = 0;
  if (complete) {
    const ids = [...byId.keys()];
    const gone = await sql`update untracked_replies set handled_at = now()
      where handled_at is null and not (id = any(${ids}::text[]))`;
    handled = gone.count;
  }
  return { open: byId.size, added, handled, pages, ...(complete ? {} : { incomplete: `stopped after ${maxPages} pages` }) };
}
