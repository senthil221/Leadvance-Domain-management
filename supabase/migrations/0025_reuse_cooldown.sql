-- When each domain was last in use, so a domain that sent recently or sat on a
-- Hypertide order rests before it is picked again ("cooling down").

-- The day the sync first saw an order cancelled (NPC / Cancelled) or gone.
-- Hypertide's API has no cancel date, so older orders only have ordered_on.
alter table hypertide_orders add column ended_on date;

alter table domains add column last_used_on date;

insert into settings (key, value) values ('reuse_after_days', '120') on conflict do nothing;

create or replace function reuse_after_days() returns integer
language sql stable as $$
  select coalesce((select (value #>> '{}')::int from settings where key = 'reuse_after_days'), 120)
$$;

-- Latest of: any Hypertide order for the name (placed, or seen ending),
-- including orders Hypertide moved to another domain; the last day it sent;
-- when it was replaced or burned. Returns how many domains changed.
create or replace function refresh_last_used() returns integer
language plpgsql as $$
declare n integer;
begin
  with ht as (
    select name, max(greatest(ordered_on, ended_on)) as d
    from (
      select domain_name as name, ordered_on, ended_on from hypertide_orders
      union all
      select unnest(replaced_domains), ordered_on, ended_on from hypertide_orders
    ) x
    group by name
  ),
  st as (select domain_id, max(day) as d from domain_daily_stats where sent > 0 group by domain_id),
  v as (
    select dm.id, greatest(ht.d, st.d, dm.burned_at::date, dm.draining_since::date) as lu
    from domains dm left join ht on ht.name = dm.name left join st on st.domain_id = dm.id
  )
  update domains dm set last_used_on = v.lu
  from v where v.id = dm.id and dm.last_used_on is distinct from v.lu;
  get diagnostics n = row_count;
  return n;
end $$;

select refresh_last_used();
