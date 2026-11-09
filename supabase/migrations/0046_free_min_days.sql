-- A free domain needs time left on it. Replacing onto a domain that runs out
-- soon means warming it up only to lose it, so a domain in storage counts as
-- free, and can be picked for a replacement, only with more than
-- free_min_days() days to go at its registrar. Domains with no known date are
-- still allowed: their registrar account isn't connected, so there's nothing to
-- go on. src/lib/expiring.ts keeps FREE_MIN_DAYS in step with this.

create or replace function free_min_days() returns integer
language sql immutable as $$ select 60 $$;

-- domain_is_free, unchanged except that it needs more than free_min_days() left.
create or replace function domain_is_free(d domains) returns boolean
language sql stable as $$
  select d.status = 'in_storage'
    and (d.expires_at is null or d.expires_at > current_date + free_min_days())
    and ns_is_default(d.nameservers)
    and not domain_ever_used(d)
$$;

-- start_replacement, unchanged except that it refuses a new domain that runs
-- out within free_min_days(), so a page left open can't slip one through.
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
