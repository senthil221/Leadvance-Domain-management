-- Warming up new domains. A domain that connects to Smartlead while it is
-- brand new is enrolled: warmup is switched on with the values from Settings →
-- Warming up and it stays in the "Warming up" view for `warmup_days` days.
-- Moving it to a tag (before or after the days are up) ends the programme.
alter table domains
  add column warmup_started_at timestamptz,
  add column warmup_days       integer,
  add column warmup_done_at    timestamptz,
  add column warmup_moved_to   text;

create index domains_warming_idx on domains (warmup_started_at) where warmup_started_at is not null and warmup_done_at is null;

-- Off until the values are entered and saved in Settings.
insert into settings (key, value) values
  ('warmup_program', '{"enabled": false, "days": 12, "maxAgeDays": 1, "perDay": 20, "rampup": 2, "replyRate": 40}')
  on conflict (key) do nothing;
