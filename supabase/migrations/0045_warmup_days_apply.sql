-- Settings → Warming up's days apply to every domain still warming, not just
-- the ones that start after a change: bring the ones warming now in line.
update domains set warmup_days = coalesce((select (value ->> 'days')::int from settings where key = 'warmup_program'), 18)
where warmup_started_at is not null and warmup_done_at is null
  and warmup_days is distinct from coalesce((select (value ->> 'days')::int from settings where key = 'warmup_program'), 18);
