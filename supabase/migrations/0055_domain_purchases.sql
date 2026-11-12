-- Buying domains a few at a time: an order is a list of names, the registrar
-- accounts to buy them from, the most to pay for each, and how long to spread
-- the buying over. Each name gets its own time inside working hours, uneven
-- gaps apart, and an account taking turns with the others; the worker buys
-- one when its time comes, after checking it is still free and in budget.

create table purchase_orders (
  id               uuid primary key default gen_random_uuid(),
  created_by       text not null,
  created_at       timestamptz not null default now(),
  -- The most to pay for one domain, in US dollars. Every buy is for one year
  -- (Porkbun only sells the registry minimum over its API).
  max_price_usd    numeric(10, 2) not null check (max_price_usd > 0 and max_price_usd <= 500),
  days             smallint not null check (days between 1 and 7),
  from_hour        smallint not null check (from_hour between 0 and 23),
  to_hour          smallint not null check (to_hour between 0 and 24),
  min_gap_minutes  smallint not null check (min_gap_minutes between 1 and 720),
  timezone         text not null,
  paused_at        timestamptz,
  -- Set when the worker paused it: a balance too low, a key that cannot buy.
  paused_reason    text,
  cancelled_at     timestamptz,
  note             text check (length(note) <= 200)
);
alter table purchase_orders enable row level security;

create table purchase_items (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references purchase_orders(id) on delete cascade,
  domain          text not null check (domain ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$'),
  -- The account to buy from; null with provider 'porkbun' is the server's .env Porkbun.
  account_id      uuid references registrar_accounts(id) on delete set null,
  provider        text not null check (provider in ('porkbun', 'dynadot', 'spaceship', 'unstoppable')),
  scheduled_at    timestamptz not null,
  status          text not null default 'queued' check (status in (
                    'queued',      -- waiting for its time
                    'buying',      -- the worker has it
                    'registering', -- the registrar took the order and is finishing it
                    'bought',
                    'dry_run',     -- what would have been bought, with dry run on
                    'skipped',     -- taken, premium, over budget or not sold there: nothing spent
                    'failed',      -- the registrar refused; nothing should have been spent
                    'cancelled')),
  -- What the registrar asked, and what it charged.
  quoted_usd      numeric(10, 2),
  paid_usd        numeric(10, 2),
  -- The registrar's order or operation id, to follow an order that finishes later.
  vendor_ref      text,
  message         text,
  attempts        smallint not null default 0,
  started_at      timestamptz,
  finished_at     timestamptz,
  domain_id       uuid references domains(id) on delete set null,
  unique (order_id, domain)
);
create index purchase_items_due_idx on purchase_items (scheduled_at) where status in ('queued', 'registering');
create index purchase_items_order_idx on purchase_items (order_id, scheduled_at);
-- One live purchase of a name at a time, across orders.
create unique index purchase_items_live_name_idx on purchase_items (domain) where status in ('queued', 'buying', 'registering');
alter table purchase_items enable row level security;
