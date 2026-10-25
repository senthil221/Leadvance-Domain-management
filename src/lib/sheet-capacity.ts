import type postgres from "postgres";

/** One line of the campaign volume sheet: a client's sending capacity under one Smartlead tag. */
export type CapacityRow = {
  client: string;
  tag: string;
  /** Connected inboxes on active domains. */
  accounts: number;
  /** Daily limit per inbox: the group's total limit over its inboxes, so accounts x limit is the real daily volume. */
  limit: number;
  domains: number;
};

/**
 * What the campaign launcher can send today, per client and tag.
 * Only connected inboxes on active domains count. Domains still warming, tagged
 * New, or in their grace period after a replacement are left out. An inbox with
 * several tags shows under each; New and Replaced are marks, not campaign tags.
 */
export async function sheetFeed(sql: postgres.Sql) {
  const [rows, clients] = await Promise.all([sheetCapacity(sql), sql<{ name: string }[]>`select name from clients order by name`]);
  // Every client name, so the sheet can set a client with nothing active to zero.
  return { rows, clients: clients.map((c) => c.name) };
}

export async function sheetCapacity(sql: postgres.Sql) {
  const rows = await sql<{ client: string; tag: string; accounts: number; capacity: number; domains: number }[]>`
    select c.name as client, t.tag, count(*)::int as accounts,
      coalesce(sum(i.daily_limit), 0)::int as capacity, count(distinct d.id)::int as domains
    from inboxes i
    join domains d on d.id = i.domain_id
    join clients c on c.id = d.client_id
    cross join lateral (
      select unnest(coalesce(nullif(array(select x from unnest(i.smartlead_tags) x where lower(x) not in ('new', 'replaced')), '{}'), array['']::text[])) as tag
    ) t
    where i.status = 'connected' and d.status = 'active'
      and not exists (select 1 from unnest(d.tags) x where lower(x) in ('new', 'replaced'))
    group by c.name, t.tag
    order by c.name, t.tag`;
  return rows.map((r): CapacityRow => ({
    client: r.client, tag: r.tag, accounts: r.accounts, domains: r.domains,
    limit: r.accounts ? Math.round((r.capacity / r.accounts) * 100) / 100 : 0,
  }));
}
