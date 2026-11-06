-- What "free" really means, and domains that have quietly stopped existing.
--
-- A domain in storage isn't necessarily free: it may have been sent from, or be
-- pointed somewhere. Free means bought and never touched: no email vendor, no
-- inbox, no order and still on the nameservers its registrar gave it (or none).

-- The nameservers registrars hand out by default. Anything else, Hypertide's or
-- any other DNS host's, means someone pointed the domain somewhere on purpose.
create or replace function ns_is_default(p_ns text[]) returns boolean
language sql immutable as $$
  select not exists (
    select 1 from unnest(coalesce(p_ns, '{}')) n
    where lower(n) !~ '(porkbun|dyna-ns\.net|dynadot|spaceship\.net|ud-dns|unstoppable|registrar-servers\.com|domaincontrol\.com|dnsowl\.com|dns-parking\.com|hostinger)'
  )
$$;

-- Any trace of the domain having been used, however long ago.
create or replace function domain_ever_used(d domains) returns boolean
language sql stable as $$
  select d.last_used_on is not null
    or d.inbox_provider_id is not null
    or exists (select 1 from inboxes i where i.domain_id = d.id)
    or exists (select 1 from hypertide_orders o where o.domain_id = d.id or o.domain_name = d.name or d.name = any(o.replaced_domains))
    or exists (select 1 from icemail_domains x where x.domain_id = d.id)
    or exists (select 1 from icemail_mailboxes m where m.domain_id = d.id)
    or exists (select 1 from domain_daily_stats s where s.domain_id = d.id and s.sent > 0)
    or exists (select 1 from replacement_items ri where ri.old_domain_id = d.id or ri.new_domain_id = d.id)
    or exists (select 1 from domain_status_history h where h.domain_id = d.id and h.to_status <> 'in_storage')
$$;

create or replace function domain_is_free(d domains) returns boolean
language sql stable as $$
  select d.status = 'in_storage'
    and (d.expires_at is null or d.expires_at >= current_date)
    and ns_is_default(d.nameservers)
    and not domain_ever_used(d)
$$;

-- Active or warming domains whose inboxes are all gone from Smartlead and whose
-- Hypertide order has ended are finished: nothing can send from them and nothing
-- is being paid for. They go to Replaced on their own, straight to burned so no
-- grace period or fix-queue item follows them. If their inboxes come back in
-- Smartlead the move is undone. Domains in a running replacement are left to it.
create or replace function replace_dropped_domains(out moved integer, out restored integer)
language plpgsql as $$
declare
  v record;
  v_actor constant text := 'auto replace';
begin
  moved := 0;
  restored := 0;

  for v in
    select d.id from domains d
    where d.status in ('active', 'warming')
      and not exists (select 1 from inboxes i where i.domain_id = d.id and i.status <> 'removed')
      and exists (select 1 from hypertide_orders o where o.domain_id = d.id or o.domain_name = d.name or d.name = any(o.replaced_domains))
      and not exists (
        select 1 from hypertide_orders o
        where (o.domain_id = d.id or o.domain_name = d.name) and o.gone_at is null and coalesce(o.status, '') not in ('NPC', 'Cancelled'))
      and not exists (
        select 1 from replacement_items ri join replacement_batches rb on rb.id = ri.batch_id
        where (ri.old_domain_id = d.id or ri.new_domain_id = d.id) and rb.status = 'running' and ri.completed_at is null)
  loop
    perform transition_domain(v.id, 'burned', 'No inboxes left in Smartlead and the Hypertide order is cancelled', v_actor, null, true);
    moved := moved + 1;
  end loop;

  for v in
    select d.id, (case when max(coalesce(i.daily_limit, 0)) > 0 then 'active' else 'warming' end)::domain_status as back_to
    from domains d join inboxes i on i.domain_id = d.id and i.status = 'connected'
    where d.status = 'burned'
      and (select h.actor from domain_status_history h where h.domain_id = d.id order by h.at desc limit 1) = v_actor
    group by d.id
  loop
    perform transition_domain(v.id, v.back_to, 'Inboxes are back in Smartlead', v_actor, null, true);
    restored := restored + 1;
  end loop;
end $$;
