-- The domain audit: every domain checked against its registrar account's list
-- and against the public registry (RDAP), and domains we don't want archived.
--
-- An archived domain stays in the database with its history but is left out
-- of every list and count, and of the free pool. The registrar sync updates it
-- without bringing it back. Archiving refuses a domain still in use.

alter table domains
  add column registrar_seen_at   timestamptz,
  add column archived_at         timestamptz,
  add column archived_reason     text,
  add column archived_by         text,
  add column registry_checked_at timestamptz,
  -- false: the registry has no record of the name; null: not asked, or it couldn't say.
  add column registry_found      boolean,
  add column registry_expires_at date,
  add column registry_registrar  text,
  add column registry_status     text[] not null default '{}',
  add column registry_error      text;

-- When the registrar sync last read the account's whole list. A domain tied to
-- the account and not seen in that read is no longer at the account.
alter table registrar_accounts add column listed_at timestamptz;

create index domains_registry_due on domains (registry_checked_at nulls first) where archived_at is null;

-- On the account's last full list, or not: false when we can't tell (no
-- account, or the account was never read in full).
create or replace function domain_gone_from_registrar(d domains) returns boolean
language sql stable as $$
  select exists (
    select 1 from registrar_accounts ra
    where ra.id = d.registrar_account_id and ra.listed_at is not null
      and (d.registrar_seen_at is null or d.registrar_seen_at < ra.listed_at))
$$;

-- What is still using a domain, in words, or null when nothing is: archiving
-- refuses these.
create or replace function domain_in_use(d domains) returns text
language sql stable as $$
  select case
    when (select count(*) from inboxes i where i.domain_id = d.id and i.status <> 'removed') > 0
      then (select count(*) from inboxes i where i.domain_id = d.id and i.status <> 'removed')::text || ' inboxes on it'
    when d.status in ('provisioning', 'warming') then 'being set up'
    when domain_being_replaced(d.id) then 'being replaced'
    when exists (select 1 from replacement_items ri join replacement_batches rb on rb.id = ri.batch_id
                 where ri.new_domain_id = d.id and ri.completed_at is null and rb.status <> 'cancelled') then 'a replacement is setting it up'
    when exists (select 1 from hypertide_orders o where o.domain_id = d.id and o.gone_at is null
                 and lower(coalesce(o.status, '')) not in ('npc', 'cancelled')) then 'a live Hypertide order'
    when exists (select 1 from icemail_mailboxes m where m.domain_id = d.id and m.gone_at is null) then 'live Icemail mailboxes'
  end
$$;

-- Archives the domains nothing uses. Returns one row per domain asked for,
-- saying whether it was archived and, if not, why.
create or replace function archive_domains(p_ids uuid[], p_reason text, p_actor text)
returns table (domain_id uuid, name text, archived boolean, why text)
language plpgsql as $$
declare
  d domains;
  v_use text;
begin
  for d in select * from domains where id = any(p_ids) order by domains.name for update loop
    if d.archived_at is not null then
      domain_id := d.id; name := d.name; archived := false; why := 'already archived';
    else
      v_use := domain_in_use(d);
      if v_use is not null then
        domain_id := d.id; name := d.name; archived := false; why := v_use;
      else
        update domains set archived_at = now(), archived_reason = nullif(btrim(p_reason), ''), archived_by = p_actor where id = d.id;
        domain_id := d.id; name := d.name; archived := true; why := null;
      end if;
    end if;
    return next;
  end loop;
end $$;

-- domain_is_free, as in 0052, and never an archived domain or one the
-- registry has no record of.
create or replace function domain_is_free(d domains) returns boolean
language sql stable as $$
  select d.status = 'in_storage'
    and d.archived_at is null
    and d.registry_found is not false
    and (d.expires_at is null or d.expires_at > current_date + free_min_days())
    and not domain_unregistered(d)
    and ns_is_default(d.nameservers)
    and not domain_ever_used(d)
$$;

-- start_replacement, as in 0052, and it refuses an archived new domain or one
-- the registry has no record of.
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
    if v_new.archived_at is not null then
      raise exception '% is archived', v_new.name using errcode = 'check_violation';
    end if;
    if domain_unregistered(v_new) then
      raise exception '% isn''t registered: its registrar lists it with no expiry date', v_new.name using errcode = 'check_violation';
    end if;
    if v_new.registry_found is false then
      raise exception '% isn''t registered: the registry has no record of it', v_new.name using errcode = 'check_violation';
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
