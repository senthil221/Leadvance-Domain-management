-- Every domain with an active order (Done at Hypertide, active at Icemail) next
-- to what Smartlead says about it. The daily check that the two match: each
-- should have all its inboxes connected with warmup running. Cancelled orders
-- aren't here, so a domain that was let go doesn't read as a disconnect.
-- Retired domains still billed and new ones still being set up aren't expected
-- to be connected, so they aren't problems. Inboxes deleted while others remain
-- don't count: reused domains carry old deleted inboxes.

create or replace view order_connections as
select y.*, y.state not in ('ok', 'setting_up', 'retiring') as problem
from (
  select o.provider, o.name, d.id as domain_id, d.status as domain_status,
    coalesce(x.connected, 0) as connected, coalesce(x.disconnected, 0) as disconnected, coalesce(x.removed, 0) as removed,
    coalesce(x.warmup_off, 0) as warmup_off, coalesce(x.warmup_blocked, 0) as warmup_blocked,
    case
      when d.status in ('draining', 'burned', 'resting') then 'retiring'
      when x.connected + x.disconnected = 0 and x.removed > 0 then 'deleted'
      when x.connected + x.disconnected = 0 and d.status = 'provisioning' then 'setting_up'
      when coalesce(x.connected + x.disconnected, 0) = 0 then 'missing'
      when x.disconnected > 0 then 'disconnected'
      when d.nameservers_answering = false then 'dns_gone'
      when x.warmup_off > 0 then 'warmup_off'
      when x.warmup_blocked > 0 then 'warmup_blocked'
      else 'ok'
    end as state
  from (
    (select distinct on (lower(domain_name)) 'Hypertide' as provider, lower(domain_name) as name, domain_id
      from hypertide_orders where status = 'Done' and gone_at is null
      order by lower(domain_name), domain_id nulls last)
    union all
    (select distinct on (lower(domain_name)) 'Icemail', lower(domain_name), domain_id
      from icemail_domains where active and gone_at is null
      order by lower(domain_name), domain_id nulls last)
  ) o
  left join lateral (
    select dd.id, dd.status, dd.nameservers_answering from domains dd where dd.id = o.domain_id or lower(dd.name) = o.name
    order by dd.id = o.domain_id desc nulls last limit 1) d on true
  left join lateral (
    select count(*) filter (where i.status = 'connected')::int as connected,
      count(*) filter (where i.status = 'disconnected')::int as disconnected,
      count(*) filter (where i.status = 'removed')::int as removed,
      count(*) filter (where i.status = 'connected' and (i.warmup_enabled is not true or coalesce(i.warmup_status, '') ~* 'INACTIVE|PAUSE'))::int as warmup_off,
      count(*) filter (where i.status = 'connected' and (coalesce(i.warmup_blocked_reason, '') <> '' or coalesce(i.warmup_status, '') ~* 'BLOCK'))::int as warmup_blocked
    from inboxes i where i.domain_id = d.id) x on true
) y;
