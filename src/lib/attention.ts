import type postgres from "postgres";

/**
 * How many domains are on Smartlead's Needs attention list, for the sidebar
 * badge. The same rules as reasonsOf in InboxesView: an active or warming
 * domain with a disconnected inbox, warmup blocked or off, an inbox under 90
 * reputation, a missing DNS record or no DNS zone, a blacklist listing, or an
 * open health alert.
 */
export async function attentionDomainCount(sql: postgres.Sql) {
  const [r] = await sql<{ n: number }[]>`
    select count(*)::int as n from domains d
    where d.status in ('active', 'warming')
      and exists (select 1 from inboxes i where i.domain_id = d.id and i.status <> 'removed')
      and (
        exists (select 1 from inboxes i where i.domain_id = d.id and i.status = 'disconnected')
        or exists (
          select 1 from inboxes i where i.domain_id = d.id and i.status <> 'removed' and (
            coalesce(i.warmup_blocked_reason, '') <> '' or coalesce(i.warmup_status, '') ~* 'BLOCK|INACTIVE|PAUSE'
            or i.warmup_enabled is not true or i.warmup_reputation < 90))
        or d.nameservers_answering = false
        or d.dns_spf = false or d.dns_dkim = false or d.dns_dmarc = false or d.dns_mx = false
        or coalesce(d.blacklist_domain_count, 0) + coalesce(d.blacklist_ip_count, 0) > 0
        or exists (select 1 from alerts a where a.domain_id = d.id and a.status = 'open')
      )`;
  return r.n;
}
