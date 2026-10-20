-- Phase 2: data from Smartlead. Webhook events land in email_events; the
-- worker stores Smartlead's per-domain daily numbers here, then
-- rollup_daily_stats() merges both into domain_daily_stats.

-- Smartlead's own per-domain sent/replied/bounced counts for a day, as
-- returned by its domain-wise analytics. Keyed by name so it works before the
-- domain is in inventory.
create table smartlead_domain_daily (
  domain_name text not null,
  day         date not null,
  sent        integer not null default 0,
  replies     integer not null default 0,
  bounces     integer not null default 0,
  synced_at   timestamptz not null default now(),
  primary key (domain_name, day)
);

-- When each worker job last ran, so the schedule survives restarts.
create table job_state (
  job              text primary key,
  last_started_at  timestamptz,
  last_finished_at timestamptz,
  last_ok          boolean,
  last_error       text,
  last_detail      jsonb
);

alter table smartlead_domain_daily enable row level security;
alter table job_state enable row level security;

create index email_events_unresolved_idx on email_events (domain_name) where domain_id is null;
create index inboxes_account_idx on inboxes (smartlead_account_id) where smartlead_account_id is not null;

insert into settings (key, value) values ('stats_timezone', '"UTC"') on conflict do nothing;

-- The vendors in use, so synced domains and inboxes have someone to point at.
insert into vendors (name, kind, api_supported) values
  ('Porkbun', 'registrar', true),
  ('Unstoppable Domains', 'registrar', true),
  ('Hypertide', 'inbox_provider', true)
on conflict (name) do nothing;

-- Rebuilds daily stats from p_from onwards (in the stats timezone): webhook
-- events give replies (by class) and bounces; sent is the larger of the
-- webhook count and Smartlead's analytics, so either source is enough.
-- Today's row also carries the domain's current average warmup reputation.
-- Days with no new data are left alone, so backfilled history is kept.
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
      count(*) filter (where kind = 'reply' and reply_class = 'human')    as human,
      count(*) filter (where kind = 'reply' and reply_class = 'ooo')      as ooo,
      count(*) filter (where kind = 'reply' and reply_class = 'auto')     as auto,
      count(*) filter (where kind = 'reply' and reply_class = 'negative') as negative,
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

-- Retires domains whose drain period (settings.drain_days) is over.
create or replace function retire_drained_domains()
returns integer
language plpgsql as $$
declare
  v_days integer := coalesce((select (value #>> '{}')::int from settings where key = 'drain_days'), 7);
  d      record;
  n      integer := 0;
begin
  for d in
    select id from domains
    where status = 'draining' and draining_since < now() - make_interval(days => v_days)
    for update skip locked
  loop
    perform transition_domain(d.id, 'burned', format('drain period of %s days over', v_days), 'system');
    n := n + 1;
  end loop;
  return n;
end $$;
