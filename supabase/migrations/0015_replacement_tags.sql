-- Replacement tags: the new domain is tagged New until it joins campaigns; the
-- old one is tagged Replaced and counts down Hypertide's grace period (the
-- drain days) before its inboxes go. Both are mirrored on the inboxes as
-- Smartlead tags. New inboxes get warmup turned on automatically.

alter table replacement_batches add column auto_warmup boolean not null default true;
update replacement_batches set auto_warmup = false where created_at < now();

alter table replacement_items
  add column warmup_queued_at  timestamptz,
  add column sl_new_tagged_at  timestamptz,   -- "New" Smartlead tag on the new inboxes
  add column sl_old_tagged_at  timestamptz;   -- "Replaced" Smartlead tag on the old inboxes

-- Whole days left before a draining (replaced) domain's grace period ends.
create or replace function grace_days_left(p_status domain_status, p_since timestamptz)
returns integer
language sql stable as $$
  select case when p_status = 'draining' and p_since is not null then
    greatest(0, ceil(extract(epoch from (
      p_since + make_interval(days => coalesce((select (value #>> '{}')::int from settings where key = 'drain_days'), 18)) - now()
    )) / 86400))::int
  end
$$;

-- Tags for replacements already under way.
update domains d set tags = array(select distinct t from unnest(d.tags || array['New']) t order by 1)
where d.id in (
  select ri.new_domain_id from replacement_items ri join replacement_batches rb on rb.id = ri.batch_id
  where rb.hypertide_replace and ri.step_campaigns <> 'done'
) and d.status in ('provisioning', 'warming');

update domains d set tags = array(select distinct t from unnest(d.tags || array['Replaced']) t order by 1)
where d.id in (select ri.old_domain_id from replacement_items ri) and d.status in ('draining', 'burned');
