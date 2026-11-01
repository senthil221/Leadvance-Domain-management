-- Registrar accounts added from Settings: several per registrar (two
-- Unstoppable logins, say), each with its keys encrypted by the app. Domains
-- remember which account they came from, so nameserver changes go there.

create table registrar_accounts (
  id              uuid primary key default gen_random_uuid(),
  provider        text not null check (provider in ('porkbun', 'dynadot', 'spaceship', 'unstoppable')),
  label           text not null check (length(trim(label)) between 1 and 60),
  -- AES-256-GCM, written and read only by the server; never sent to the browser.
  credentials     text not null,
  -- The last characters of the main key, so accounts can be told apart.
  key_hint        text,
  created_by      text not null,
  created_at      timestamptz not null default now(),
  last_synced_at  timestamptz,
  last_ok         boolean,
  last_error      text,
  domain_count    integer,
  unique (provider, label)
);
alter table registrar_accounts enable row level security;

alter table domains add column registrar_account_id uuid references registrar_accounts(id) on delete set null;
create index domains_registrar_account_idx on domains (registrar_account_id) where registrar_account_id is not null;

insert into vendors (name, kind, api_supported) values
  ('Dynadot', 'registrar', true),
  ('Spaceship', 'registrar', true)
on conflict (name) do nothing;
