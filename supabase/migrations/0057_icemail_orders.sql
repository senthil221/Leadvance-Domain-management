-- Icemail from Domain Engine: placing inbox orders and cancelling domains
-- before they renew, so Icemail's own app isn't needed.
--
-- An order is a list of domains for one workspace and client, each with the
-- inboxes to create on it. Domains already connected to Icemail (with no
-- inboxes) are ordered on straight away; a free domain from the inventory
-- first has its nameservers moved to Icemail's ClouDNS through its registrar,
-- then is ordered on as an import. Icemail is never asked to buy a domain.
-- The worker places one domain a request, at most one every few seconds.
--
-- Icemail has no order cancel and no replace: a domain's inboxes are deleted
-- together. A cancel here asks Icemail to delete them on their next billing
-- date (scheduled mode), so they keep sending until then and nothing renews;
-- it can be undone until that date.

alter table icemail_accounts
  add column auto_topup        boolean,
  add column price_google      numeric(10, 2),
  add column price_microsoft   numeric(10, 2);

create table icemail_orders (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references icemail_accounts(id) on delete cascade,
  client_id           uuid references clients(id) on delete set null,
  provider            text not null default 'GOOGLE' check (provider in ('GOOGLE', 'MICROSOFT')),
  -- What one inbox cost a month when it was confirmed, and the whole order.
  price_usd           numeric(10, 2),
  quoted_monthly_usd  numeric(12, 2),
  note                text check (length(note) <= 200),
  created_by          text not null,
  created_at          timestamptz not null default now(),
  cancelled_at        timestamptz
);
create index icemail_orders_created_idx on icemail_orders (created_at desc);
alter table icemail_orders enable row level security;

create table icemail_order_items (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references icemail_orders(id) on delete cascade,
  domain_name        text not null check (domain_name ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$'),
  domain_id          uuid references domains(id) on delete set null,
  -- Set when the domain is already connected to the workspace.
  icemail_domain_id  text,
  -- [{first_name, last_name, username}]: never a password.
  mailboxes          jsonb not null check (jsonb_typeof(mailboxes) = 'array' and jsonb_array_length(mailboxes) between 1 and 100),
  -- The nameserver change to Icemail's ClouDNS, for a domain from the inventory.
  ns_request_id      uuid references nameserver_requests(id) on delete set null,
  status             text not null default 'queued' check (status in (
                       'queued',       -- waiting for the worker
                       'nameservers',  -- waiting for its nameservers to move to Icemail
                       'ordering',     -- the worker has it
                       'ordered',      -- Icemail took it; inboxes come up over the next hours
                       'dry_run',      -- what would have been ordered, with dry run on
                       'failed',
                       'cancelled')),
  icemail_order_id   text,
  message            text,
  attempts           smallint not null default 0,
  started_at         timestamptz,
  finished_at        timestamptz,
  unique (order_id, domain_name)
);
create index icemail_order_items_due_idx on icemail_order_items (order_id) where status in ('queued', 'nameservers', 'ordering');
-- One live order for a domain at a time, across orders.
create unique index icemail_order_items_live_name_idx on icemail_order_items (domain_name) where status in ('queued', 'nameservers', 'ordering');
alter table icemail_order_items enable row level security;

create table icemail_cancels (
  id                 uuid primary key default gen_random_uuid(),
  account_id         uuid not null references icemail_accounts(id) on delete cascade,
  icemail_domain_id  text not null,
  domain_name        text not null,
  domain_id          uuid references domains(id) on delete set null,
  -- 'cancel', or 'replace' when a new order on another domain takes its place.
  reason             text not null default 'cancel' check (reason in ('cancel', 'replace')),
  replacement_order_id uuid references icemail_orders(id) on delete set null,
  status             text not null default 'queued' check (status in (
                       'queued',       -- waiting for the worker to ask Icemail
                       'scheduled',    -- Icemail deletes the inboxes on deletes_on
                       'dry_run',      -- what would have been asked, with dry run on
                       'undo_queued',  -- waiting for the worker to take the deletion back
                       'undone',
                       'failed')),
  -- The billing date Icemail deletes on: the earliest of the domain's live inboxes.
  deletes_on         date,
  mailboxes          integer,
  message            text,
  created_by         text not null,
  created_at         timestamptz not null default now(),
  finished_at        timestamptz
);
create unique index icemail_cancels_live_idx on icemail_cancels (icemail_domain_id) where status in ('queued', 'scheduled', 'undo_queued');
create index icemail_cancels_created_idx on icemail_cancels (created_at desc);
alter table icemail_cancels enable row level security;
