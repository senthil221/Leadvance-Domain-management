-- Placement tests: a batch of domains, each sending two small Smartlead
-- campaigns to placement seeds (the client's real first email, and a short
-- neutral note), next to a control domain that is known to land. A seed's
-- auto-reply means the email reached the inbox. The placement-tests job builds
-- the campaigns in Smartlead step by step, reads who was sent what and who
-- auto-replied, and stops each campaign once its replies have had 48 hours.

create table placement_batches (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'running' check (status in ('running', 'done', 'cancelled')),
  starts_at timestamptz not null,          -- when the campaigns may start sending
  seeds_per_campaign integer not null,
  created_by text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

-- Each domain in a batch: one being tested, or the control it is measured against.
create table placement_domains (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references placement_batches(id) on delete cascade,
  domain_id uuid not null references domains(id) on delete cascade,
  role text not null check (role in ('test', 'control')),
  client_id uuid references clients(id) on delete set null,
  control_id uuid references placement_domains(id) on delete set null, -- for a tested domain: its control
  unique (batch_id, domain_id)
);

create table placement_campaigns (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references placement_batches(id) on delete cascade,
  placement_domain_id uuid not null references placement_domains(id) on delete cascade,
  variant text not null check (variant in ('sales', 'neutral')),
  name text not null,
  subject text not null,
  body text not null,
  source_campaign_id bigint,               -- the client campaign the copy and settings came from
  settings jsonb not null default '{}',    -- Smartlead campaign settings copied from it
  account_ids bigint[] not null,           -- the Smartlead email accounts that send it
  smartlead_campaign_id bigint unique,
  -- The next thing to do in Smartlead; 'sending' once started, 'closed' once stopped after the wait.
  step text not null default 'create' check (step in
    ('create', 'settings', 'schedule', 'sequence', 'accounts', 'leads', 'start', 'sending', 'closed', 'failed', 'cancelled')),
  attempts integer not null default 0,
  last_error text,
  leads_added integer,
  started_at timestamptz,
  polled_at timestamptz,
  closed_at timestamptz,
  unique (placement_domain_id, variant)
);
create index placement_campaigns_open_idx on placement_campaigns (step) where step not in ('closed', 'failed', 'cancelled');

-- One seed in one campaign: whether it was sent, auto-replied or bounced.
create table placement_sends (
  campaign_id uuid not null references placement_campaigns(id) on delete cascade,
  seed_email text not null,                -- not a key into placement_seeds: that list is rebuilt when its rules change
  first_name text,
  company text,
  sent_at timestamptz,
  replied_at timestamptz,
  reply_source text,                       -- 'smartlead', 'webhook' or 'untracked'
  bounced_at timestamptz,
  primary key (campaign_id, seed_email)
);
create index placement_sends_seed_idx on placement_sends (seed_email);

alter table placement_batches enable row level security;
alter table placement_domains enable row level security;
alter table placement_campaigns enable row level security;
alter table placement_sends enable row level security;
