-- New Icemail inboxes go to Smartlead through Icemail's own export (POST
-- /export), the same as Export → Smartlead in its dashboard. Icemail never
-- sets Google app passwords, so the app-password connects (0059) can't finish.
--
-- One row per export of an ordered domain: queued once all its inboxes are
-- active at Icemail, or by hand. The Smartlead login Icemail asks for comes
-- from the server's .env and is never stored here.
create table icemail_exports (
  id                 uuid primary key default gen_random_uuid(),
  account_id         uuid not null references icemail_accounts(id) on delete cascade,
  order_item_id      uuid references icemail_order_items(id) on delete set null,
  domain_name        text not null,
  mailbox_ids        text[] not null,
  -- queued → sending → exporting → done; failed says why; dry_run when
  -- Icemail wasn't asked. A queued row with an export id is a retry, sent as
  -- Icemail's republish of that export.
  status             text not null default 'queued'
                     check (status in ('queued', 'sending', 'exporting', 'done', 'dry_run', 'failed', 'cancelled')),
  icemail_export_id  text,
  total              integer,
  processed          integer,
  succeeded          integer,
  failed_count       integer,
  message            text,
  attempts           integer not null default 0,
  created_by         text not null,
  created_at         timestamptz not null default now(),
  started_at         timestamptz,
  checked_at         timestamptz,
  finished_at        timestamptz
);
-- One live export a domain of an order: Icemail allows one export an inbox a day.
create unique index icemail_exports_live_idx on icemail_exports (order_item_id)
  where status in ('queued', 'sending', 'exporting');
create index icemail_exports_open_idx on icemail_exports (created_at) where status in ('queued', 'sending', 'exporting');
alter table icemail_exports enable row level security;

-- The connects still waiting for an app password never will.
update icemail_connects set status = 'cancelled', finished_at = now(),
  message = 'Icemail doesn''t set Google app passwords; these go to Smartlead through Icemail''s export instead'
where status in ('queued', 'connecting', 'no_password');
