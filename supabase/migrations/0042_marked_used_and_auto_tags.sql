-- Two things the person shouldn't have to do by hand.
--
-- 1. A domain can be marked as used. Some domains were used somewhere the app
--    can't see (an order Hypertide no longer lists, another tool), so they show
--    as free. marked_used_on takes them out of Free domains for good and counts
--    as a use for the reuse cool-down, like any other.
--
-- 2. Every replacement tags its inboxes in Smartlead: the new domain's "New"
--    while it warms up, the old domain's "Replaced" once its grace period
--    starts. Until now only Hypertide replacements did; auto_tag marks the
--    batches that should, so manual replacements started before this aren't
--    retagged after the fact.

alter table domains add column if not exists marked_used_on date;
comment on column domains.marked_used_on is 'Set by Mark as used: the domain was used somewhere the app can''t see.';

alter table replacement_batches add column if not exists auto_tag boolean not null default false;
update replacement_batches set auto_tag = true where hypertide_replace and not auto_tag;
-- Every replacement from now on is tagged.
alter table replacement_batches alter column auto_tag set default true;
comment on column replacement_batches.auto_tag is 'Tag the inboxes in Smartlead: New on the new domain, Replaced on the old one.';

-- domain_ever_used, unchanged except that it counts a domain marked as used and
-- an Icemail domain matched by name before the sync links it.
create or replace function domain_ever_used(d domains) returns boolean
language sql stable as $$
  select d.last_used_on is not null
    or d.marked_used_on is not null
    or d.inbox_provider_id is not null
    or exists (select 1 from inboxes i where i.domain_id = d.id)
    or exists (select 1 from hypertide_orders o where o.domain_id = d.id or o.domain_name = d.name or d.name = any(o.replaced_domains))
    or exists (select 1 from icemail_domains x where x.domain_id = d.id or lower(x.domain_name) = d.name)
    or exists (select 1 from icemail_mailboxes m where m.domain_id = d.id)
    or exists (select 1 from domain_daily_stats s where s.domain_id = d.id and s.sent > 0)
    or exists (select 1 from replacement_items ri where ri.old_domain_id = d.id or ri.new_domain_id = d.id)
    or exists (select 1 from domain_status_history h where h.domain_id = d.id and h.to_status <> 'in_storage')
$$;

-- refresh_last_used, unchanged except that a domain marked as used counts from that day.
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
    select dm.id, greatest(ht.d, st.d, dm.burned_at::date, dm.draining_since::date, dm.marked_used_on) as lu
    from domains dm left join ht on ht.name = dm.name left join st on st.domain_id = dm.id
  )
  update domains dm set last_used_on = v.lu
  from v where v.id = dm.id and dm.last_used_on is distinct from v.lu;
  get diagnostics n = row_count;
  return n;
end $$;
