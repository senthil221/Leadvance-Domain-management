-- The warmup identifier tag Smartlead filters warmup emails with (its API's
-- warmup_key_id), and whether ramp-up is on. Smartlead's API doesn't report
-- ramp-up, so warmup_rampup_on and warmup_rampup hold what the app last wrote.
alter table inboxes
  add column if not exists warmup_tag text,
  add column if not exists warmup_rampup_on boolean;
