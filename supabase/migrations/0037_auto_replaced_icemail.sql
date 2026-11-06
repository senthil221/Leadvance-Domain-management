-- The automatic move to Replaced now covers Icemail as well as Hypertide: inboxes
-- gone from Smartlead, the domain has been with a vendor, and nothing is live at
-- either one. Icemail mailboxes end when it stops listing them or calls them
-- cancelled or deleted. A live order or mailbox at one vendor keeps the domain.
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
      and (
        exists (select 1 from hypertide_orders o where o.domain_id = d.id or o.domain_name = d.name or d.name = any(o.replaced_domains))
        or exists (select 1 from icemail_mailboxes m where m.domain_id = d.id)
      )
      and not exists (
        select 1 from hypertide_orders o
        where (o.domain_id = d.id or o.domain_name = d.name) and o.gone_at is null and coalesce(o.status, '') not in ('NPC', 'Cancelled'))
      and not exists (
        select 1 from icemail_mailboxes m
        where m.domain_id = d.id and m.gone_at is null and coalesce(m.status, '') !~* 'cancel|delet')
      and not exists (
        select 1 from replacement_items ri join replacement_batches rb on rb.id = ri.batch_id
        where (ri.old_domain_id = d.id or ri.new_domain_id = d.id) and rb.status = 'running' and ri.completed_at is null)
  loop
    perform transition_domain(v.id, 'burned', 'No inboxes left in Smartlead and nothing live at Hypertide or Icemail', v_actor, null, true);
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
