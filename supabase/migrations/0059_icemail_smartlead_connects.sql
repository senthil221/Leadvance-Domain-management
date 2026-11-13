-- New Icemail inboxes added to Smartlead from Domain Engine, so Icemail's own
-- export (which wants the Smartlead login) isn't needed.
--
-- One row per Icemail inbox. The worker reads the inbox's Google app password
-- from Icemail and adds it to Smartlead through the API in the same step; the
-- password is never stored here or anywhere else. Rows for an order's domain
-- are queued once all its inboxes are active at Icemail, or by hand.
create table icemail_connects (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null references icemail_accounts(id) on delete cascade,
  order_item_id         uuid references icemail_order_items(id) on delete set null,
  icemail_mailbox_id    text not null,
  email                 text not null check (email = lower(email)),
  domain_name           text not null,
  -- queued → connecting → connected; no_password waits for Icemail to set
  -- the app password and is tried again; dry_run when Smartlead wasn't asked.
  status                text not null default 'queued'
                        check (status in ('queued', 'connecting', 'no_password', 'connected', 'dry_run', 'failed', 'cancelled')),
  smartlead_account_id  bigint,
  message               text,
  attempts              integer not null default 0,
  created_by            text not null,
  created_at            timestamptz not null default now(),
  started_at            timestamptz,
  finished_at           timestamptz
);
-- One live connect an inbox: a second would add it to Smartlead twice.
create unique index icemail_connects_live_idx on icemail_connects (icemail_mailbox_id)
  where status in ('queued', 'connecting', 'no_password', 'connected');
create index icemail_connects_item_idx on icemail_connects (order_item_id);
alter table icemail_connects enable row level security;
