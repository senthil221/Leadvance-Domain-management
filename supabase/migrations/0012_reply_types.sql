-- More reply types: a referral to someone else, the wrong person, and an
-- unsubscribe request. Daily stats count referrals with human (positive)
-- replies, and wrong-person and unsubscribe replies with not interested.
alter type reply_class add value if not exists 'referral';
alter type reply_class add value if not exists 'wrong_person';
alter type reply_class add value if not exists 'unsubscribe';

create or replace function rollup_daily_stats(p_from date, p_tz text default 'UTC')
returns integer
language plpgsql as $$
declare
  n integer;
  v_today date := (now() at time zone p_tz)::date;
begin
  update email_events e set domain_id = d.id, client_id = coalesce(e.client_id, d.client_id)
  from domains d
  where e.domain_id is null and e.domain_name = d.name;

  with ev as (
    select domain_id, (occurred_at at time zone p_tz)::date as day,
      count(*) filter (where kind = 'sent')                              as sent,
      count(*) filter (where kind = 'reply')                             as replies,
      count(*) filter (where kind = 'reply' and reply_class::text in ('human', 'referral')) as human,
      count(*) filter (where kind = 'reply' and reply_class = 'ooo')      as ooo,
      count(*) filter (where kind = 'reply' and reply_class = 'auto')     as auto,
      count(*) filter (where kind = 'reply' and reply_class::text in ('negative', 'wrong_person', 'unsubscribe')) as negative,
      count(*) filter (where kind = 'bounce')                            as bounces
    from email_events
    where domain_id is not null and occurred_at >= (p_from::timestamp at time zone p_tz)
    group by 1, 2
  ),
  api as (
    select d.id as domain_id, s.day, s.sent
    from smartlead_domain_daily s join domains d on d.name = s.domain_name
    where s.day >= p_from
  ),
  keys as (
    select domain_id, day from ev
    union select domain_id, day from api
  )
  -- Replies and bounces come only from events, so they are recounted; sent
  -- never goes down, so a day imported from elsewhere keeps its volume.
  insert into domain_daily_stats as s (domain_id, day, sent, replies, human_replies, ooo, auto_replies, negative, bounces)
  select k.domain_id, k.day,
    greatest(coalesce(ev.sent, 0), coalesce(api.sent, 0)),
    coalesce(ev.replies, 0), coalesce(ev.human, 0), coalesce(ev.ooo, 0), coalesce(ev.auto, 0),
    coalesce(ev.negative, 0), coalesce(ev.bounces, 0)
  from keys k
  left join ev  on ev.domain_id = k.domain_id and ev.day = k.day
  left join api on api.domain_id = k.domain_id and api.day = k.day
  on conflict (domain_id, day) do update set
    sent          = greatest(excluded.sent, s.sent),
    replies       = case when exists (select 1 from ev where ev.domain_id = excluded.domain_id and ev.day = excluded.day) then excluded.replies else s.replies end,
    human_replies = case when exists (select 1 from ev where ev.domain_id = excluded.domain_id and ev.day = excluded.day) then excluded.human_replies else s.human_replies end,
    ooo           = case when exists (select 1 from ev where ev.domain_id = excluded.domain_id and ev.day = excluded.day) then excluded.ooo else s.ooo end,
    auto_replies  = case when exists (select 1 from ev where ev.domain_id = excluded.domain_id and ev.day = excluded.day) then excluded.auto_replies else s.auto_replies end,
    negative      = case when exists (select 1 from ev where ev.domain_id = excluded.domain_id and ev.day = excluded.day) then excluded.negative else s.negative end,
    bounces       = case when exists (select 1 from ev where ev.domain_id = excluded.domain_id and ev.day = excluded.day) then excluded.bounces else s.bounces end;
  get diagnostics n = row_count;

  -- Today's average warmup reputation, touching nothing else on the row.
  if v_today >= p_from then
    insert into domain_daily_stats as s (domain_id, day, warmup_reputation)
    select i.domain_id, v_today, round(avg(i.warmup_reputation), 2)
    from inboxes i join domains d on d.id = i.domain_id
    where i.status = 'connected' and i.warmup_reputation is not null and d.status in ('warming', 'active', 'draining')
    group by i.domain_id
    on conflict (domain_id, day) do update set warmup_reputation = excluded.warmup_reputation;
  end if;
  return n;
end $$;
