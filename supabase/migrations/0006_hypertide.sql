-- Hypertide orders as part of a replacement.

alter table replacement_items
  add column hypertide_ns             text[],      -- the Cloudflare pair Hypertide reserved for the new domain
  add column hypertide_order_id       text,        -- Hypertide (Airtable) record id
  add column hypertide_status         text,        -- Todo / In progress / Done, from Hypertide
  add column hypertide_paid_at        timestamptz,
  add column hypertide_ns_verified_at timestamptz;

create index replacement_items_hypertide_idx on replacement_items (hypertide_order_id) where hypertide_order_id is not null;

-- How new domains are ordered. Sender names and warmup settings come from the
-- domain being replaced; these are the account-wide choices.
insert into settings (key, value) values
  ('hypertide_order_template', '{"plan": "entra", "inbox_quantity": 50, "forwarding_domain": "", "client_name": ""}')
on conflict do nothing;
