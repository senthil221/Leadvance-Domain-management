-- Registrar data (Porkbun) and the replacement step runner.

alter table domains
  add column auto_renew             boolean,
  add column registrar_api_access   boolean,
  add column registrar_status       text,
  add column nameservers_checked_at timestamptz;

-- Guidance for the step a replacement is waiting on ("Order 3 inboxes on
-- Hypertide…"), separate from last_error, which is only for failures.
alter table replacement_items add column note text;

-- Nameservers new domains are pointed at during a replacement, until the
-- Hypertide connection supplies them per order.
insert into settings (key, value) values ('hypertide_nameservers', '[]') on conflict do nothing;
