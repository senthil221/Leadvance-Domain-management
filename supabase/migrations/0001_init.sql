-- Domain Engine: core schema.
-- Domains, inboxes, clients and vendors; the domain state machine with its
-- audit trail; webhook events and daily stats; health rules and alerts; and
-- replacement batches, which double as the lineage record.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type domain_status as enum (
  'in_storage', 'provisioning', 'warming', 'active', 'draining', 'burned', 'resting'
);
create type vendor_kind as enum ('registrar', 'inbox_provider');
create type event_kind as enum ('sent', 'reply', 'bounce');
create type reply_class as enum ('human', 'ooo', 'auto', 'negative');
create type replacement_reason as enum (
  'high_bounce', 'low_replies', 'low_reputation', 'blacklisted', 'client_request', 'other'
);
create type step_status as enum ('pending', 'running', 'done', 'failed', 'skipped', 'manual');
create type alert_status as enum ('open', 'snoozed', 'resolved');

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Inventory
-- ---------------------------------------------------------------------------

create table vendors (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  kind          vendor_kind not null,
  api_supported boolean not null default false,
  created_at    timestamptz not null default now()
);

create table clients (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null unique,
  -- One fixed hue (0-360) per client, used for its chip everywhere in the UI.
  hue                 smallint not null default 250 check (hue between 0 and 360),
  smartlead_client_id bigint unique,
  notes               text,
  archived_at         timestamptz,
  created_at          timestamptz not null default now()
);

create table domains (
  id                uuid primary key default gen_random_uuid(),
  name              text not null unique check (name = lower(name) and name ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$'),
  tld               text generated always as (substring(name from '\.([a-z0-9-]+)$')) stored,
  registrar_id      uuid references vendors(id),
  inbox_provider_id uuid references vendors(id),
  client_id         uuid references clients(id),
  status            domain_status not null default 'in_storage',
  purchased_at      date,
  expires_at        date,
  cost_cents        integer check (cost_cents >= 0),
  nameservers       text[] not null default '{}',
  active_since      timestamptz,
  draining_since    timestamptz,
  burned_at         timestamptz,
  tags              text[] not null default '{}',
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index domains_status_idx on domains (status);
create index domains_client_idx on domains (client_id);
create index domains_storage_pick_idx on domains (tld, purchased_at) where status = 'in_storage';
create trigger domains_touch before update on domains
  for each row execute function touch_updated_at();

create table inboxes (
  id                   uuid primary key default gen_random_uuid(),
  domain_id            uuid not null references domains(id) on delete cascade,
  email                text not null unique check (email = lower(email)),
  sender_name          text,
  provider_ref         text,
  smartlead_account_id bigint unique,
  warmup_enabled       boolean,
  warmup_per_day       integer,
  warmup_rampup        integer,
  daily_limit          integer,
  warmup_reputation    numeric(5, 2),
  status               text not null default 'pending'
                       check (status in ('pending', 'connected', 'disconnected', 'removed')),
  -- Settings changed in the app but not yet confirmed by Smartlead.
  pending_changes      jsonb,
  last_synced_at       timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index inboxes_domain_idx on inboxes (domain_id);
create trigger inboxes_touch before update on inboxes
  for each row execute function touch_updated_at();

create table campaigns (
  id        bigint primary key, -- Smartlead campaign id
  name      text not null,
  client_id uuid references clients(id),
  status    text,
  synced_at timestamptz not null default now()
);

create table campaign_inboxes (
  campaign_id bigint not null references campaigns(id) on delete cascade,
  inbox_id    uuid not null references inboxes(id) on delete cascade,
  primary key (campaign_id, inbox_id)
);

-- ---------------------------------------------------------------------------
-- State machine
-- ---------------------------------------------------------------------------

create table domain_transitions (
  from_status domain_status not null,
  to_status   domain_status not null,
  primary key (from_status, to_status)
);
insert into domain_transitions (from_status, to_status) values
  ('in_storage',   'provisioning'),
  ('provisioning', 'warming'),
  ('provisioning', 'in_storage'),  -- setup cancelled
  ('warming',      'active'),
  ('warming',      'draining'),
  ('active',       'draining'),
  ('draining',     'burned'),
  ('draining',     'active'),      -- replacement rolled back
  ('burned',       'resting'),
  ('resting',      'in_storage');

create table domain_status_history (
  id          bigint generated always as identity primary key,
  domain_id   uuid not null references domains(id) on delete cascade,
  from_status domain_status,
  to_status   domain_status not null,
  reason      text,
  actor       text not null default 'system',
  batch_id    uuid,
  forced      boolean not null default false,
  at          timestamptz not null default now()
);
create index domain_status_history_domain_idx on domain_status_history (domain_id, at desc);

-- The only way to change a domain's status. Rejects moves that are not in
-- domain_transitions unless forced, and a forced move must give a reason.
create or replace function transition_domain(
  p_domain_id uuid,
  p_to        domain_status,
  p_reason    text default null,
  p_actor     text default 'system',
  p_batch_id  uuid default null,
  p_force     boolean default false
) returns domains
language plpgsql as $$
declare
  d      domains;
  v_from domain_status;
begin
  select * into d from domains where id = p_domain_id for update;
  if not found then
    raise exception 'domain % not found', p_domain_id using errcode = 'no_data_found';
  end if;
  if d.status = p_to then
    return d;
  end if;
  v_from := d.status;
  if not exists (select 1 from domain_transitions where from_status = d.status and to_status = p_to) then
    if not p_force then
      raise exception 'cannot move % from % to %', d.name, d.status, p_to using errcode = 'check_violation';
    end if;
    if coalesce(btrim(p_reason), '') = '' then
      raise exception 'a forced status change needs a reason' using errcode = 'check_violation';
    end if;
  end if;

  update domains set
    status         = p_to,
    active_since   = case when p_to = 'active' then coalesce(case when d.status = 'draining' then d.active_since end, now()) else active_since end,
    draining_since = case when p_to = 'draining' then now() when p_to = 'active' then null else draining_since end,
    burned_at      = case when p_to = 'burned' then now() else burned_at end,
    client_id      = case when p_to = 'in_storage' then null else client_id end
  where id = p_domain_id
  returning * into d;

  insert into domain_status_history (domain_id, from_status, to_status, reason, actor, batch_id, forced)
  values (p_domain_id, v_from, p_to, p_reason, p_actor, p_batch_id, p_force);

  return d;
end $$;

-- New domains start their history with a row of their own.
create or replace function domains_log_insert() returns trigger
language plpgsql as $$
begin
  insert into domain_status_history (domain_id, from_status, to_status, reason, actor)
  values (new.id, null, new.status, 'added to inventory', coalesce(current_setting('app.actor', true), 'system'));
  return new;
end $$;
create trigger domains_log_insert after insert on domains
  for each row execute function domains_log_insert();

-- ---------------------------------------------------------------------------
-- Events and stats
-- ---------------------------------------------------------------------------

create table email_events (
  id               bigint generated always as identity primary key,
  dedupe_key       text not null unique,
  kind             event_kind not null,
  occurred_at      timestamptz not null,
  domain_name      text,
  domain_id        uuid references domains(id) on delete set null,
  inbox_email      text,
  inbox_id         uuid references inboxes(id) on delete set null,
  campaign_id      bigint,
  campaign_name    text,
  client_id        uuid references clients(id) on delete set null,
  lead_email       text,
  sequence_number  integer,
  reply_class      reply_class,
  class_overridden boolean not null default false,
  subject          text,
  preview          text,
  recipient_esp    text,
  payload          jsonb not null default '{}',
  received_at      timestamptz not null default now()
);
create index email_events_domain_idx on email_events (domain_id, occurred_at desc);
create index email_events_kind_idx on email_events (kind, occurred_at desc);

create table domain_daily_stats (
  domain_id         uuid not null references domains(id) on delete cascade,
  day               date not null,
  sent              integer not null default 0,
  replies           integer not null default 0,
  human_replies     integer not null default 0,
  ooo               integer not null default 0,
  auto_replies      integer not null default 0,
  negative          integer not null default 0,
  bounces           integer not null default 0,
  warmup_reputation numeric(5, 2),
  primary key (domain_id, day)
);
create index domain_daily_stats_day_idx on domain_daily_stats (day);

-- ---------------------------------------------------------------------------
-- Health
-- ---------------------------------------------------------------------------

create table health_rules (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  metric      text not null check (metric in (
                'bounce_rate', 'reply_rate', 'human_reply_rate', 'human_replies', 'bounces', 'warmup_reputation')),
  comparison  text not null check (comparison in ('gt', 'gte', 'lt', 'lte', 'eq')),
  threshold   numeric not null,
  min_sent    integer not null default 0 check (min_sent >= 0),
  window_days integer not null default 7 check (window_days between 1 and 90),
  severity    text not null default 'warning' check (severity in ('warning', 'critical')),
  enabled     boolean not null default true,
  created_at  timestamptz not null default now()
);

create table alerts (
  id            uuid primary key default gen_random_uuid(),
  domain_id     uuid not null references domains(id) on delete cascade,
  rule_id       uuid not null references health_rules(id) on delete cascade,
  value         numeric,
  status        alert_status not null default 'open',
  opened_at     timestamptz not null default now(),
  snoozed_until timestamptz,
  resolved_at   timestamptz,
  note          text
);
create unique index alerts_one_live_idx on alerts (domain_id, rule_id) where status <> 'resolved';

-- ---------------------------------------------------------------------------
-- Replacements (lineage)
-- ---------------------------------------------------------------------------

create table replacement_batches (
  id           uuid primary key default gen_random_uuid(),
  reason       replacement_reason not null,
  note         text,
  actor        text not null,
  status       text not null default 'running' check (status in ('running', 'completed', 'partial', 'cancelled')),
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

create table replacement_items (
  id              uuid primary key default gen_random_uuid(),
  batch_id        uuid not null references replacement_batches(id) on delete cascade,
  client_id       uuid references clients(id),
  old_domain_id   uuid not null references domains(id),
  new_domain_id   uuid not null references domains(id) unique,
  step_nameservers step_status not null default 'pending',
  step_inboxes     step_status not null default 'pending',
  step_smartlead   step_status not null default 'pending',
  step_campaigns   step_status not null default 'pending',
  last_error      text,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  unique (batch_id, old_domain_id),
  check (old_domain_id <> new_domain_id)
);
create index replacement_items_old_idx on replacement_items (old_domain_id);

-- Picks free domains from storage and locks them for this transaction, so two
-- people replacing at once never get the same domain. Prefers a TLD when given.
create or replace function reserve_storage_domains(p_count integer, p_prefer_tld text default null)
returns setof domains
language sql as $$
  select * from domains
  where status = 'in_storage'
  order by (tld is not distinct from p_prefer_tld) desc, purchased_at nulls last, created_at, name
  limit p_count
  for update skip locked
$$;

-- Starts a replacement: pairs each old domain with a new one, moves the new
-- ones to provisioning under the old domain's client, and records the batch.
create or replace function start_replacement(
  p_old_ids uuid[],
  p_new_ids uuid[],
  p_reason  replacement_reason,
  p_note    text,
  p_actor   text
) returns uuid
language plpgsql as $$
declare
  v_batch uuid;
  i       integer;
  v_old   domains;
  v_new   domains;
begin
  if coalesce(array_length(p_old_ids, 1), 0) = 0 then
    raise exception 'pick at least one domain to replace' using errcode = 'check_violation';
  end if;
  if array_length(p_old_ids, 1) <> coalesce(array_length(p_new_ids, 1), 0) then
    raise exception 'need one new domain for each old domain' using errcode = 'check_violation';
  end if;

  insert into replacement_batches (reason, note, actor)
  values (p_reason, nullif(btrim(p_note), ''), p_actor)
  returning id into v_batch;

  for i in 1 .. array_length(p_old_ids, 1) loop
    select * into v_old from domains where id = p_old_ids[i] for update;
    select * into v_new from domains where id = p_new_ids[i] for update;
    if v_old.id is null or v_new.id is null then
      raise exception 'domain not found' using errcode = 'no_data_found';
    end if;
    if v_old.status not in ('active', 'warming') then
      raise exception '% is % and cannot be replaced', v_old.name, v_old.status using errcode = 'check_violation';
    end if;
    if v_new.status <> 'in_storage' then
      raise exception '% is no longer in storage', v_new.name using errcode = 'check_violation';
    end if;
    if exists (
      select 1 from replacement_items ri join replacement_batches rb on rb.id = ri.batch_id
      where ri.old_domain_id = v_old.id and rb.status = 'running' and ri.completed_at is null
    ) then
      raise exception '% is already being replaced', v_old.name using errcode = 'check_violation';
    end if;

    update domains set client_id = v_old.client_id, inbox_provider_id = coalesce(inbox_provider_id, v_old.inbox_provider_id)
    where id = v_new.id;
    perform transition_domain(v_new.id, 'provisioning', 'replacing ' || v_old.name, p_actor, v_batch);

    insert into replacement_items (batch_id, client_id, old_domain_id, new_domain_id)
    values (v_batch, v_old.client_id, v_old.id, v_new.id);
  end loop;

  return v_batch;
end $$;

-- ---------------------------------------------------------------------------
-- Settings and logs
-- ---------------------------------------------------------------------------

create table settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
insert into settings (key, value) values
  ('drain_days', '7'),
  ('storage_low_threshold', '20');

create table sync_runs (
  id          bigint generated always as identity primary key,
  job         text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  detail      jsonb
);

create table api_calls (
  id          bigint generated always as identity primary key,
  service     text not null,
  method      text not null,
  path        text not null,
  status      integer,
  duration_ms integer,
  error       text,
  dry_run     boolean not null default false,
  at          timestamptz not null default now()
);
create index api_calls_at_idx on api_calls (at desc);

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------

-- Rolling 7-day health per domain, the numbers the tables and rules read.
create view domain_health_7d as
select
  d.id as domain_id,
  coalesce(sum(s.sent), 0)::int          as sent,
  coalesce(sum(s.replies), 0)::int       as replies,
  coalesce(sum(s.human_replies), 0)::int as human_replies,
  coalesce(sum(s.ooo), 0)::int           as ooo,
  coalesce(sum(s.bounces), 0)::int       as bounces,
  case when coalesce(sum(s.sent), 0) > 0 then round(100.0 * sum(s.bounces) / sum(s.sent), 2) end       as bounce_rate,
  case when coalesce(sum(s.sent), 0) > 0 then round(100.0 * sum(s.replies) / sum(s.sent), 2) end       as reply_rate,
  case when coalesce(sum(s.sent), 0) > 0 then round(100.0 * sum(s.human_replies) / sum(s.sent), 2) end as human_reply_rate,
  (select ds.warmup_reputation from domain_daily_stats ds
    where ds.domain_id = d.id and ds.warmup_reputation is not null
    order by ds.day desc limit 1)                                                                      as warmup_reputation
from domains d
left join domain_daily_stats s on s.domain_id = d.id and s.day > current_date - 7
group by d.id;

-- ---------------------------------------------------------------------------
-- Row-level security: on for every table with no policies, so the public
-- PostgREST roles see nothing. The app talks to Postgres directly from the
-- server with its own role.
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'vendors', 'clients', 'domains', 'inboxes', 'campaigns', 'campaign_inboxes',
    'domain_transitions', 'domain_status_history', 'email_events', 'domain_daily_stats',
    'health_rules', 'alerts', 'replacement_batches', 'replacement_items',
    'settings', 'sync_runs', 'api_calls'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;
