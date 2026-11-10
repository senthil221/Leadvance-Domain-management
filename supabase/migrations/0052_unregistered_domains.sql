-- A domain at a connected registrar account that reports no expiry date was
-- never registered: Unstoppable lists names from an order whose registration
-- didn't go through (no date, no nameservers, unknown to the registry). Setting
-- one up fails at the nameservers step and Hypertide refuses it, so it is not
-- free and a replacement can't use it. Domains with no registrar account (bought
-- through Icemail or Hypertide) still go by their order, as before.

create or replace function domain_unregistered(d domains) returns boolean
language sql stable as $$
  select d.registrar_account_id is not null and d.expires_at is null
$$;

-- domain_is_free, unchanged except that an unregistered domain is never free.
create or replace function domain_is_free(d domains) returns boolean
language sql stable as $$
  select d.status = 'in_storage'
    and (d.expires_at is null or d.expires_at > current_date + free_min_days())
    and not domain_unregistered(d)
    and ns_is_default(d.nameservers)
    and not domain_ever_used(d)
$$;

-- start_replacement, unchanged except that it refuses an unregistered new domain.
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
    if domain_unregistered(v_new) then
      raise exception '% isn''t registered: its registrar lists it with no expiry date', v_new.name using errcode = 'check_violation';
    end if;
    if v_new.expires_at is not null and v_new.expires_at <= current_date + free_min_days() then
      raise exception '% expires on %, within % days: pick a domain with more time left', v_new.name, to_char(v_new.expires_at, 'FMDD Mon YYYY'), free_min_days()
        using errcode = 'check_violation';
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
