import type postgres from "postgres";

/** One line of the campaign volume sheet: inboxes of a client and tag that share one daily limit. */
export type CapacityRow = {
  client: string;
  tag: string;
  /** Connected inboxes on active domains with this limit. */
  accounts: number;
  /** Daily limit of each of those inboxes, always a whole number. */
  limit: number;
  domains: number;
};

/**
 * What the campaign launcher can send today, per client and tag.
 * Only connected inboxes on active domains with a daily limit count. Domains
 * still warming, tagged New, in their grace period after a replacement, or
 * kept for warmup (a warmup tag or client) are left out. Inboxes of one client
 * and tag with different limits come as separate rows, biggest group first, so
 * accounts x limit is always the exact daily volume and limits stay whole.
 * An inbox with several tags shows under each; New and Replaced are marks, not
 * campaign tags.
 */
export async function sheetCapacity(sql: postgres.Sql) {
  const rows = await sql<{ client: string; tag: string; accounts: number; lim: number; domains: number }[]>`
    select c.name as client, t.tag, count(*)::int as accounts, i.daily_limit as lim, count(distinct d.id)::int as domains
    from inboxes i
    join domains d on d.id = i.domain_id
    join clients c on c.id = d.client_id
    cross join lateral (
      select unnest(coalesce(nullif(array(select x from unnest(i.smartlead_tags) x where lower(x) not in ('new', 'replaced', 'low reputation')), '{}'), array['']::text[])) as tag
    ) t
    where i.status = 'connected' and d.status = 'active' and i.daily_limit > 0
      and c.name not ilike '%warmup%'
      and not exists (select 1 from unnest(i.smartlead_tags) x where x ilike '%warmup%')
      and not exists (select 1 from unnest(d.tags) x where lower(x) in ('new', 'replaced'))
    group by c.name, t.tag, i.daily_limit
    order by c.name, t.tag, count(*) desc, i.daily_limit desc`;
  return rows.map((r): CapacityRow => ({ client: r.client, tag: r.tag, accounts: r.accounts, limit: r.lim, domains: r.domains }));
}

export async function sheetFeed(sql: postgres.Sql) {
  const [rows, clients] = await Promise.all([sheetCapacity(sql), sql<{ name: string }[]>`select name from clients order by name`]);
  // Every client name, so the sheet can set a client with nothing active to zero.
  return { rows, clients: clients.map((c) => c.name) };
}
