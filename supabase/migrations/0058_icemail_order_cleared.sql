-- Clearing an Icemail order from the Orders tab once nothing is left to do on
-- it. Nothing is deleted and Icemail isn't asked: the order is only hidden
-- from the list (and from the sidebar's failed count), and can be brought back.
alter table icemail_orders add column if not exists cleared_at timestamptz;
alter table icemail_orders add column if not exists cleared_by text;
