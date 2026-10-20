-- Manual Hypertide workflow: tags, queued nameserver changes, a mirror of the
-- Hypertide orders on the account, and replacements whose inboxes are
-- ordered by hand.

create index domains_tags_idx on domains using gin (tags);

-- ---------------------------------------------------------------------------
-- Nameserver changes, queued from the app and applied by the worker
-- ---------------------------------------------------------------------------

create table nameserver_requests (
  id          uuid primary key default gen_random_uuid(),
  domain_id   uuid not null references domains(id) on delete cascade,
  source      text not null check (source in ('hypertide', 'custom')),
  -- The pair to set: given for custom, filled in from Hypertide otherwise.
  target      text[],
  status      text not null default 'pending'
              check (status in ('pending', 'running', 'done', 'manual', 'dry_run', 'failed')),
  message     text,
  actor       text not null,
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index nameserver_requests_open_idx on nameserver_requests (created_at) where status in ('pending', 'running');
create index nameserver_requests_domain_idx on nameserver_requests (domain_id, created_at desc);
alter table nameserver_requests enable row level security;

-- ---------------------------------------------------------------------------
-- Hypertide orders (GET /orders/active and /orders/pending)
-- ---------------------------------------------------------------------------

create table hypertide_orders (
  id                text primary key,          -- Hypertide record id (rec…)
  domain_name       text not null,
  domain_id         uuid references domains(id) on delete set null,
  status            text,                      -- Todo / In progress / Done
  payment_status    text,                      -- Paid / Unpaid
  subscription_id   text,
  forwarding_domain text,
  sending_tool      text,
  organization_name text,
  ordered_on        date,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  -- No longer returned by Hypertide (cancelled or removed).
  gone_at           timestamptz
);
create index hypertide_orders_domain_idx on hypertide_orders (domain_id);
create index hypertide_orders_name_idx on hypertide_orders (domain_name);
alter table hypertide_orders enable row level security;

-- Inboxes for this batch are ordered on Hypertide by hand; the inbox step
-- waits for a person, or for the order to show Done in the Hypertide sync.
alter table replacement_batches add column manual_inboxes boolean not null default false;
