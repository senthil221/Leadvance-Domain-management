-- Replacements through Hypertide's own replace-domain queue (POST /replacements):
-- no new order or payment. Hypertide swaps the old domain's inboxes onto the new
-- one and returns its nameservers; the app sets them at Porkbun, follows the
-- operation, then sets up Smartlead and moves the old domain into its grace period.

alter table replacement_batches
  add column hypertide_replace    boolean not null default false,
  add column copy_tags_and_warmup boolean not null default true,
  -- New sender names for the replacement inboxes; null keeps the old ones.
  add column usernames            jsonb,
  -- Set the old domain's inboxes to 0 a day once the new domain is live.
  add column stop_old_sending     boolean not null default true,
  -- Add the new inboxes to the campaigns the old domain's inboxes are in.
  add column add_to_campaigns     boolean not null default true;

-- Replacements already under way keep working as they were started.
update replacement_batches set stop_old_sending = false, add_to_campaigns = false;

alter table replacement_items
  add column ht_operation_id   text,
  add column ht_operation      text,        -- Hypertide's operation status (queued, completed, …)
  add column ht_response       text,        -- last raw answer from Hypertide, for troubleshooting
  add column ht_checked_at     timestamptz,
  add column old_stopped_at    timestamptz;

-- Hypertide keeps a replaced domain's inboxes working for about 18 days so
-- late replies still arrive; the old domain drains for that long before it
-- is retired. Only moves the old default.
update settings set value = '18' where key = 'drain_days' and value = '7';
