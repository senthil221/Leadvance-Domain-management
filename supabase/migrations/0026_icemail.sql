-- Icemail: Google inboxes bought there and sent from in Smartlead. Each
-- workspace is added in Settings with its API key (encrypted by the app); its
-- domains and mailboxes are mirrored here and linked to the domains and
-- inboxes Smartlead already brought in, with what each inbox costs and when
-- it bills next. Icemail pushes order and mailbox events to a webhook whose
-- address carries the account's token.

create table icemail_accounts (
  id              uuid primary key default gen_random_uuid(),
  label           text not null unique check (length(trim(label)) between 1 and 60),
  -- AES-256-GCM, written and read only by the server; never sent to the browser.
  credentials     text not null,
  key_hint        text,
  workspace_id    text,
  workspace_name  text,
  -- In the webhook address; Icemail doesn't sign its deliveries.
  webhook_token   text not null unique check (length(webhook_token) >= 32),
  wallet_balance  numeric(12, 2),
  wallet_currency text,
  created_by      text not null,
  created_at      timestamptz not null default now(),
  last_synced_at  timestamptz,
  last_ok         boolean,
  last_error      text,
  domain_count    integer,
  mailbox_count   integer
);
alter table icemail_accounts enable row level security;

create table icemail_domains (
  id             text primary key,             -- Icemail domain_id
  account_id     uuid not null references icemail_accounts(id) on delete cascade,
  domain_name    text not null,
  domain_id      uuid references domains(id) on delete set null,
  status         text,                          -- ACTIVE / PENDING / …
  active         boolean,
  imported       boolean,
  prewarmed      boolean,
  blacklisted    boolean,
  spf            boolean,
  dkim           boolean,
  dmarc          boolean,
  mx             boolean,
  provider       text,                          -- GOOGLE / MICROSOFT
  mailbox_count  integer,
  created_on     date,
  expires_on     date,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  -- No longer listed by Icemail (deleted there).
  gone_at        timestamptz
);
create index icemail_domains_domain_idx on icemail_domains (domain_id);
create index icemail_domains_name_idx on icemail_domains (domain_name);
alter table icemail_domains enable row level security;

create table icemail_mailboxes (
  id                text primary key,           -- Icemail mailbox id
  account_id        uuid not null references icemail_accounts(id) on delete cascade,
  icemail_domain_id text,
  domain_id         uuid references domains(id) on delete set null,
  inbox_id          uuid references inboxes(id) on delete set null,
  email             text not null check (email = lower(email)),
  first_name        text,
  last_name         text,
  provider          text,                       -- GOOGLE / MICROSOFT / CUSTOM
  status            text,                       -- ACTIVE / UPDATING / …
  active            boolean,
  master_inbox      boolean,
  cost              numeric(10, 2),             -- per billing cycle, USD
  billing_cycle     text,                       -- MONTHLY / YEARLY
  next_billing_on   date,
  created_on        date,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  gone_at           timestamptz
);
create index icemail_mailboxes_domain_idx on icemail_mailboxes (domain_id);
create index icemail_mailboxes_email_idx on icemail_mailboxes (email);
create index icemail_mailboxes_inbox_idx on icemail_mailboxes (inbox_id);
alter table icemail_mailboxes enable row level security;

-- What Icemail pushed, newest first in Settings. App passwords are removed
-- before a delivery is stored.
create table icemail_events (
  id           bigint generated always as identity primary key,
  account_id   uuid references icemail_accounts(id) on delete cascade,
  event        text not null,
  workspace_id text,
  payload      jsonb not null,
  received_at  timestamptz not null default now()
);
create index icemail_events_account_idx on icemail_events (account_id, received_at desc);
alter table icemail_events enable row level security;

insert into vendors (name, kind, api_supported) values ('Icemail', 'inbox_provider', true)
on conflict (name) do nothing;
