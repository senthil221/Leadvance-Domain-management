-- One warm-up for every new domain, 18 days by default.
--
-- A replacement's new domain now starts the same warm-up clock as any other
-- new domain once its inboxes are in Smartlead, so it shows under
-- Smartlead → Warming up with the New tag until it's moved to active or added
-- to campaigns. The days come from Settings → Warming up, which Replacements
-- now counts against too (it used its own hidden 14-day setting).

-- 18 days, unless a longer warm-up was already chosen. Domains already warming
-- keep the length they started with.
update settings set value = jsonb_set(value, '{days}', '18'::jsonb), updated_at = now()
where key = 'warmup_program' and coalesce((value ->> 'days')::int, 0) < 18;
insert into settings (key, value) values
  ('warmup_program', '{"enabled": false, "days": 18, "maxAgeDays": 1, "perDay": 20, "rampup": 2, "replyRate": 40}')
  on conflict (key) do nothing;

-- Replacement domains warming now, counted from their first inbox in Smartlead.
update domains d set warmup_started_at = x.since,
  warmup_days = coalesce((select (value ->> 'days')::int from settings where key = 'warmup_program'), 18),
  warmup_done_at = null, warmup_moved_to = null
from (
  select ri.new_domain_id as id, min(coalesce(i.smartlead_created_at, i.created_at)) as since
  from replacement_items ri
  join inboxes i on i.domain_id = ri.new_domain_id and i.status <> 'removed' and i.smartlead_account_id is not null
  where ri.step_campaigns <> 'done'
  group by ri.new_domain_id
) x
where d.id = x.id and d.status = 'warming' and d.warmup_started_at is null;

-- Replacements' "day N of 18" and "ready for campaigns" use the same days.
create or replace view replacement_readiness as
with rules as (
  select coalesce((select (value ->> 'days')::int from settings where key = 'warmup_program'), 18) as days,
         coalesce((select (value #>> '{}')::numeric from settings where key = 'ready_min_reputation'), 95) as rep
)
select ri.id as item_id,
  n.inboxes, n.warm_on, n.rep,
  -- Warming since the first new inbox reached Smartlead.
  floor(extract(epoch from (now() - n.since)) / 86400)::int as warm_days,
  r.days as min_days, r.rep as min_rep,
  (ri.completed_at is not null and ri.step_campaigns <> 'done' and nd.status = 'warming'
    and n.inboxes > 0 and n.warm_on = n.inboxes
    and n.since <= now() - make_interval(days => r.days)
    and n.rep >= r.rep) as ready
from replacement_items ri
join domains nd on nd.id = ri.new_domain_id
cross join rules r
cross join lateral (
  select count(*)::int as inboxes,
    count(*) filter (where i.warmup_enabled)::int as warm_on,
    round(avg(i.warmup_reputation), 1)::float8 as rep,
    min(coalesce(i.smartlead_created_at, i.created_at)) as since
  from inboxes i where i.domain_id = nd.id and i.status = 'connected'
) n;
