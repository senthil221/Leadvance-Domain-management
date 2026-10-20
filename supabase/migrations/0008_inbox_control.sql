-- Inbox control: more of Smartlead's inbox settings, a queue of setting
-- changes the worker pushes to Smartlead, and daily sending plans that
-- reshuffle (or re-pick) the daily limits of a set of inboxes every day.

alter table inboxes
  add column smartlead_tags   text[] not null default '{}',
  add column provider_type    text,           -- OUTLOOK / GMAIL / SMTP
  add column min_wait_mins    integer,        -- minimum minutes between campaign emails
  add column daily_sent       integer,        -- sent today, as Smartlead counts it
  add column campaign_count   integer,
  add column warmup_status    text,
  add column warmup_min       integer,        -- Smartlead picks a warmup count between min and max each day
  add column warmup_reply_rate integer;

-- ---------------------------------------------------------------------------
-- Setting changes queued for Smartlead
-- ---------------------------------------------------------------------------

create table inbox_setting_changes (
  id          uuid primary key default gen_random_uuid(),
  inbox_id    uuid not null references inboxes(id) on delete cascade,
  -- Any of: daily_limit, min_wait_mins, warmup_enabled, warmup_per_day,
  -- warmup_rampup, warmup_reply_rate.
  changes     jsonb not null,
  source      text not null default 'manual',   -- manual, or plan:<id>
  status      text not null default 'pending'
              check (status in ('pending', 'running', 'done', 'dry_run', 'failed')),
  error       text,
  actor       text not null,
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index inbox_setting_changes_open_idx on inbox_setting_changes (created_at) where status in ('pending', 'running');
create index inbox_setting_changes_inbox_idx on inbox_setting_changes (inbox_id, created_at desc);
alter table inbox_setting_changes enable row level security;

-- ---------------------------------------------------------------------------
-- Daily sending plans
-- ---------------------------------------------------------------------------

create table sending_plans (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  enabled     boolean not null default true,
  -- shuffle: the same total every day, split differently across inboxes.
  -- random_total: a new total every day between total_min and total_max.
  mode        text not null check (mode in ('shuffle', 'random_total')),
  total_min   integer not null check (total_min >= 0),
  total_max   integer not null check (total_max >= total_min),
  inbox_min   integer not null check (inbox_min >= 0),
  inbox_max   integer not null check (inbox_max >= inbox_min and inbox_max <= 1000),
  -- What it covers: a client's sending domains, or a fixed list of domains.
  client_id   uuid references clients(id) on delete cascade,
  domain_ids  uuid[] not null default '{}',
  run_hour    integer not null default 6 check (run_hour between 0 and 23),
  last_run_on date,
  last_result jsonb,
  created_by  text not null,
  created_at  timestamptz not null default now(),
  check (client_id is not null or cardinality(domain_ids) > 0)
);
alter table sending_plans enable row level security;
