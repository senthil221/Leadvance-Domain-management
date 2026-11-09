import { sql } from "@/lib/db";
import { parseTargets, type BoardCampaign, type BoardDomain } from "@/lib/tag-board";

/**
 * Every domain with inboxes in Smartlead, rolled up for Smartlead → Tags.
 * Aggregates are read once per table (not per domain), so this stays quick
 * on thousands of domains.
 */
export async function loadTagBoard() {
  const [domains, campaigns, [t]] = await Promise.all([
    sql<BoardDomain[]>`
      with inb as (
        select * from inboxes where status <> 'removed' and smartlead_account_id is not null
      ), agg as (
        select domain_id,
          count(*) filter (where status = 'connected')::int as connected,
          count(*) filter (where status = 'disconnected')::int as disconnected,
          coalesce(sum(daily_limit) filter (where status = 'connected'), 0)::int as volume,
          coalesce(sum(daily_sent), 0)::int as sent_today,
          avg(warmup_reputation) filter (where status = 'connected')::float8 as rep,
          floor(extract(epoch from now() - min(smartlead_created_at)) / 86400)::int as age_days,
          mode() within group (order by provider_type) as esp
        from inb group by domain_id
      ), snd as (
        select domain_id, jsonb_agg(jsonb_build_object('name', name, 'count', n) order by n desc, name) as senders
        from (select domain_id, coalesce(nullif(trim(sender_name), ''), 'No sender name') as name, count(*)::int as n
              from inb group by 1, 2) s
        group by domain_id
      ), tg as (
        select domain_id, array_agg(distinct t order by t) as tags from inb cross join unnest(smartlead_tags) t group by domain_id
      ), cp as (
        select i.domain_id, array_agg(distinct ci.campaign_id) as campaigns
        from campaign_inboxes ci join inb i on i.id = ci.inbox_id group by i.domain_id
      )
      select d.id, d.name, d.status, c.name as client_name, c.hue as client_hue,
        d.expires_at::text as expires_at, grace_days_left(d.status, d.draining_since) as grace_days_left,
        domain_being_replaced(d.id) as being_replaced,
        d.warmup_started_at::text as warmup_started_at, d.warmup_days, d.warmup_done_at::text as warmup_done_at,
        agg.connected, agg.disconnected, agg.volume, agg.sent_today, agg.rep, agg.age_days, agg.esp,
        coalesce(snd.senders, '[]'::jsonb) as senders, coalesce(tg.tags, '{}') as tags, d.tags as marks,
        coalesce(cp.campaigns, '{}') as campaigns
      from agg join domains d on d.id = agg.domain_id
      left join clients c on c.id = d.client_id
      left join snd on snd.domain_id = d.id
      left join tg on tg.domain_id = d.id
      left join cp on cp.domain_id = d.id
      where d.status in ('active', 'warming', 'provisioning', 'draining')
      order by d.name`,
    sql<BoardCampaign[]>`
      select id, name, status from campaigns
      where id in (select distinct campaign_id from campaign_inboxes) order by name`,
    sql<{ v: string }[]>`select value::text as v from settings where key = 'tag_targets'`,
  ]);
  // bigint campaign ids arrive as strings.
  for (const d of domains) d.campaigns = d.campaigns.map(Number);
  for (const c of campaigns) c.id = Number(c.id);
  return { domains, campaigns, targets: parseTargets(t ? JSON.parse(t.v) : null) };
}
