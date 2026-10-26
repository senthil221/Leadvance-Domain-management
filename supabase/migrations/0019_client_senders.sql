-- Which client a sender name (an inbox's From name in Smartlead) belongs to.
-- A domain that no client tag decides takes the client most of its inboxes'
-- sender names point to (Settings → Clients → Sender names).
create table client_senders (
  sender     text primary key,                                -- lower case, single spaces
  display    text not null,
  client_id  uuid not null references clients(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Domains with more inboxes than this are listed under Smartlead → Cleanup.
insert into settings (key, value) values ('inbox_limit', '60') on conflict (key) do nothing;
