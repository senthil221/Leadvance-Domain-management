-- The Hypertide order each domain goes by, picked the same way everywhere.
-- domain_standing already picked it like this; the Domains page and the domain
-- sheet took whichever live order was seen last, so a domain with an old
-- cancelled order and a newer Done one could read Cancelled there and Active
-- everywhere else. An order counts for a domain by id or by name, a live order
-- wins over one Hypertide stopped listing, and a Done order wins over the rest,
-- with cancelled ones (NPC or Cancelled) last. Pages that only show live orders
-- read this view where gone_at is null: the pick is gone only when nothing is live.

create or replace view domain_hypertide_order as
select distinct on (d.id) d.id as domain_id, o.id as order_id, o.status, o.payment_status, o.ended_on, o.gone_at, o.last_seen_at
from hypertide_orders o join domains d on d.id = o.domain_id or d.name = o.domain_name
order by d.id, (o.gone_at is null) desc,
  case when o.status = 'Done' then 0 when o.status in ('NPC', 'Cancelled') then 2 else 1 end, o.last_seen_at desc;

-- domain_standing, unchanged except that it reads the order from the view above.
create or replace view domain_standing as
with ib as (
  select i.domain_id,
    count(*) filter (where i.status = 'connected')::int as connected,
    count(*) filter (where i.status = 'disconnected')::int as disconnected,
    count(*) filter (where i.status = 'removed')::int as removed,
    bool_or(i.status <> 'removed' and exists (select 1 from unnest(i.smartlead_tags) t where lower(trim(t)) = 'replaced')) as tagged
  from inboxes i group by 1
), ho as (
  select h.domain_id, h.status, h.ended_on, h.gone_at from domain_hypertide_order h
), hr as (
  select r.name, max(o.replaced_at) as at
  from hypertide_orders o cross join unnest(o.replaced_domains) r(name) group by 1
), ix as (
  select distinct on (x.domain_id) x.domain_id, x.active, x.gone_at
  from icemail_domains x where x.domain_id is not null
  order by x.domain_id, (x.gone_at is null) desc, x.active desc nulls last, x.last_seen_at desc
), base as (
  select d.id as domain_id, d.name, d.status, d.tags, d.expires_at, d.draining_since, v.name as provider,
    coalesce(ib.connected, 0) as connected, coalesce(ib.disconnected, 0) as disconnected, coalesce(ib.removed, 0) as removed,
    coalesce(ib.tagged, false) or exists (select 1 from unnest(d.tags) t where lower(trim(t)) = 'replaced') as tagged_replaced,
    hr.name is not null as ht_replaced, hr.at as ht_replaced_at, ho.ended_on, ix.gone_at as ix_gone_at,
    case
      when d.name like '%.onmicrosoft.com' then null
      when v.name = 'Hypertide' then case
        when ho.status = 'Done' and ho.gone_at is null then 'active'
        when ho.status in ('NPC', 'Cancelled') then 'cancelled'
        when ho.gone_at is not null then 'gone'
        when ho.status is not null then 'pending'
        when hr.name is not null then 'replaced'
        when exists (select 1 from hypertide_orders) then 'missing'
      end
      when v.name = 'Icemail' then case
        when ix.gone_at is not null then 'gone'
        when ix.active then 'active'
        when ix.domain_id is not null then 'pending'
        when exists (select 1 from icemail_accounts) then 'missing'
      end
    end as order_state
  from domains d
  left join vendors v on v.id = d.inbox_provider_id
  left join ib on ib.domain_id = d.id
  left join ho on ho.domain_id = d.id
  left join hr on hr.name = d.name
  left join ix on ix.domain_id = d.id
), graced as (
  select b.*,
    -- The day the clock started: moved to draining, order moved, cancelled or dropped.
    case
      when b.status = 'draining' then b.draining_since::date
      when b.order_state = 'replaced' or b.ht_replaced then b.ht_replaced_at::date
      when b.order_state = 'cancelled' or (b.order_state = 'gone' and b.provider = 'Hypertide') then b.ended_on
      when b.order_state = 'gone' then b.ix_gone_at::date
    end as ended_since
  from base b
), left_days as (
  select g.*,
    case when g.ended_since is not null then
      greatest(0, g.ended_since + coalesce((select (value #>> '{}')::int from settings where key = 'drain_days'), 18) - current_date)
    end as grace_left
  from graced g
)
select x.domain_id, x.provider, x.order_state, x.connected, x.disconnected, x.removed, x.grace_left,
  -- With no order data for a domain (no provider set, or a provider's sync never ran) there's nothing to say it ended.
  coalesce(x.order_state in ('active', 'pending'), true) as order_live,
  s.standing,
  s.standing in ('active', 'grace') as current
from left_days x
cross join lateral (
  select case
    when x.expires_at < current_date then 'expired'
    -- Still connected, and either inside the window or marked replaced with no date to count from.
    when x.connected > 0 and x.status not in ('burned', 'resting', 'in_storage')
      and (x.grace_left > 0 or ((x.tagged_replaced or x.ht_replaced) and x.ended_since is null)) then 'grace'
    when x.ht_replaced or x.order_state = 'replaced' then 'replaced'
    when x.order_state = 'cancelled' then 'cancelled'
    when x.status in ('draining', 'burned', 'resting') then 'retired'
    when x.connected = 0 and x.disconnected > 0 then 'disconnected'
    when x.connected = 0 and x.removed > 0 then 'deleted'
    when x.connected = 0 then 'not_connected'
    when x.status = 'in_storage' then 'not_connected'
    when x.order_state in ('gone', 'missing') then 'no_order'
    else 'active'
  end as standing
) s;
