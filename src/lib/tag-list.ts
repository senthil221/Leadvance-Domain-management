import type postgres from "postgres";

export type TagRow = { key: string; tag: string; domains: number; inboxes: number; clientId: string | null; clientName: string | null };

/** Every Smartlead tag on the inboxes (not the New and Replaced marks), with the client it is mapped to; unmapped tags first. */
export async function tagOverview(sql: postgres.Sql) {
  return sql<TagRow[]>`
    with t as (
      select regexp_replace(lower(trim(x)), '[[:space:]]+', ' ', 'g') as key, trim(x) as shown, i.domain_id
      from inboxes i cross join lateral unnest(i.smartlead_tags) as u(x)
      where i.status <> 'removed' and trim(x) <> '' and lower(trim(x)) not in ('new', 'replaced', 'low reputation')
    )
    select t.key, min(t.shown) as tag, count(distinct t.domain_id)::int as domains, count(*)::int as inboxes,
      c.id as client_id, c.name as client_name
    from t left join client_tags m on m.tag = t.key left join clients c on c.id = m.client_id
    group by t.key, c.id, c.name
    order by (c.id is null) desc, count(*) desc, t.key`;
}
