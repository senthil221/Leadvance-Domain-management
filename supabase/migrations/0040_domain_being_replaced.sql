-- Whether a domain is being replaced right now: it's the old domain of a pair
-- in a running batch that hasn't finished. start_replacement() refuses those,
-- and every Replace button now asks the same question instead of its own
-- version of it (some looked at any replacement ever made, some at none).

create or replace function domain_being_replaced(p_domain_id uuid) returns boolean
language sql stable as $$
  select exists (
    select 1 from replacement_items ri join replacement_batches rb on rb.id = ri.batch_id
    where ri.old_domain_id = p_domain_id and rb.status = 'running' and ri.completed_at is null
  )
$$;

-- start_replacement, unchanged except that it asks domain_being_replaced().
create or replace function start_replacement(
  p_old_ids uuid[],
  p_new_ids uuid[],
  p_reason  replacement_reason,
  p_note    text,
  p_actor   text
) returns uuid
language plpgsql as $$
declare
  v_batch uuid;
  i       integer;
  v_old   domains;
  v_new   domains;
begin
  if coalesce(array_length(p_old_ids, 1), 0) = 0 then
    raise exception 'pick at least one domain to replace' using errcode = 'check_violation';
  end if;
  if array_length(p_old_ids, 1) <> coalesce(array_length(p_new_ids, 1), 0) then
    raise exception 'need one new domain for each old domain' using errcode = 'check_violation';
  end if;

  insert into replacement_batches (reason, note, actor)
  values (p_reason, nullif(btrim(p_note), ''), p_actor)
  returning id into v_batch;

  for i in 1 .. array_length(p_old_ids, 1) loop
    select * into v_old from domains where id = p_old_ids[i] for update;
    select * into v_new from domains where id = p_new_ids[i] for update;
    if v_old.id is null or v_new.id is null then
      raise exception 'domain not found' using errcode = 'no_data_found';
    end if;
    if v_old.status not in ('active', 'warming') then
      raise exception '% is % and cannot be replaced', v_old.name, v_old.status using errcode = 'check_violation';
    end if;
    if v_new.status <> 'in_storage' then
      raise exception '% is no longer in storage', v_new.name using errcode = 'check_violation';
    end if;
    if domain_being_replaced(v_old.id) then
      raise exception '% is already being replaced', v_old.name using errcode = 'check_violation';
    end if;

    update domains set client_id = v_old.client_id, inbox_provider_id = coalesce(inbox_provider_id, v_old.inbox_provider_id)
    where id = v_new.id;
    perform transition_domain(v_new.id, 'provisioning', 'replacing ' || v_old.name, p_actor, v_batch);

    insert into replacement_items (batch_id, client_id, old_domain_id, new_domain_id)
    values (v_batch, v_old.client_id, v_old.id, v_new.id);
  end loop;

  return v_batch;
end $$;
