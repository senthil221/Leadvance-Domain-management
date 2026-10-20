-- Clients from campaign names, and Smartlead's rolling 7-day numbers.

-- Gives campaigns without a client the client whose name appears in the
-- campaign name ("Kapable TM 19-10-26" → Kapable; the longest name wins when
-- several match), then gives sending domains without a client the client of
-- the campaigns their inboxes are in (the most common one).
create or replace function assign_clients_from_campaigns()
returns table (campaigns integer, domains integer)
language plpgsql as $$
declare
  n_c integer;
  n_d integer;
begin
  update campaigns c set client_id = m.client_id
  from (
    select distinct on (c2.id) c2.id, cl.id as client_id
    from campaigns c2
    join clients cl on cl.archived_at is null and length(cl.name) >= 3
      and position(lower(cl.name) in lower(c2.name)) > 0
    where c2.client_id is null
    order by c2.id, length(cl.name) desc
  ) m
  where c.id = m.id;
  get diagnostics n_c = row_count;

  update domains d set client_id = m.client_id
  from (
    select distinct on (i.domain_id) i.domain_id, c.client_id
    from inboxes i
    join campaign_inboxes ci on ci.inbox_id = i.id
    join campaigns c on c.id = ci.campaign_id and c.client_id is not null
    group by i.domain_id, c.client_id
    order by i.domain_id, count(*) desc
  ) m
  where d.id = m.domain_id and d.client_id is null and d.status <> 'in_storage';
  get diagnostics n_d = row_count;

  return query select n_c, n_d;
end $$;

-- Smartlead's per-domain totals for the last 7 days. Its analytics only
-- answer for longer ranges, so these sit beside the app's own daily counts
-- (from the Email Sent webhook) as a cross-check.
create table smartlead_domain_7d (
  domain_name text primary key,
  sent        integer not null default 0,
  replies     integer not null default 0,
  bounces     integer not null default 0,
  synced_at   timestamptz not null default now()
);
alter table smartlead_domain_7d enable row level security;
