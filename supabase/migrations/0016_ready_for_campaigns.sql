-- When a replacement's new domain is ready for campaigns: warmup on for every
-- inbox, warming for at least ready_min_days, and average warmup reputation
-- at least ready_min_reputation. Shown on Replacements and the Overview.

insert into settings (key, value) values
  ('ready_min_days', '14'),
  ('ready_min_reputation', '95')
on conflict (key) do nothing;

create or replace view replacement_readiness as
with rules as (
  select coalesce((select (value #>> '{}')::int from settings where key = 'ready_min_days'), 14) as days,
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
