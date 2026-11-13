-- An inventory domain's Icemail order waits until the registry shows its new
-- ClouDNS nameservers, not only the registrar. When it was last looked up,
-- so the registry is asked every couple of minutes, not every run.
alter table icemail_order_items add column if not exists ns_checked_at timestamptz;
