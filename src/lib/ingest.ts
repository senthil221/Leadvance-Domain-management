import type postgres from "postgres";
import { bounceCauseOf } from "./bounces";
import type { ParsedEvent } from "./smartlead-events";

// Stores one parsed webhook event, linking it to its inbox, domain, campaign
// and client where we know them. The sending domain's client wins: Smartlead's
// own clients on campaigns are often a sender's name (merged clients resolve
// to the client they were merged into). Duplicate deliveries are ignored. Shared by
// the webhook route and tests, so it takes the connection as an argument and
// only reads single-word result columns (safe with or without camel-casing).
export async function ingestEvent(sql: postgres.Sql | postgres.TransactionSql, e: ParsedEvent, payload: unknown) {
  const rows = await sql`
    with inbox as (
      select i.id, i.domain_id from inboxes i
      where (${e.inboxEmail}::text is not null and i.email = ${e.inboxEmail})
         or (${e.smartleadAccountId}::bigint is not null and i.smartlead_account_id = ${e.smartleadAccountId})
      order by (i.email = ${e.inboxEmail}) desc nulls last
      limit 1
    ),
    dom as (
      select d.id, d.client_id from domains d
      where d.id = (select domain_id from inbox) or d.name = ${e.domainName}
      order by (d.id = (select domain_id from inbox)) desc nulls last
      limit 1
    ),
    cli as (
      select coalesce(
        (select client_id from dom),
        (select coalesce(x.merged_into, x.id) from campaigns c join clients x on x.id = c.client_id where c.id = ${e.campaignId}),
        (select coalesce(cl.merged_into, cl.id) from clients cl where cl.smartlead_client_id = ${e.smartleadClientId})
      ) as id
    )
    insert into email_events (
      dedupe_key, kind, occurred_at, domain_name, domain_id, inbox_email, inbox_id, campaign_id, campaign_name,
      client_id, lead_email, sequence_number, reply_class, subject, preview, payload, bounce_cause
    ) values (
      ${e.dedupeKey}, ${e.kind}::event_kind, ${e.occurredAt}, ${e.domainName}, (select id from dom), ${e.inboxEmail},
      (select id from inbox), ${e.campaignId}, ${e.campaignName}, (select id from cli), ${e.leadEmail}, ${e.sequenceNumber},
      ${e.replyClass}::reply_class, ${e.subject}, ${e.preview}, ${sql.json(payload as postgres.JSONValue)},
      ${e.kind === "bounce" ? bounceCauseOf(payload) : null}
    )
    on conflict (dedupe_key) do nothing
    returning id`;
  return rows.length > 0;
}
