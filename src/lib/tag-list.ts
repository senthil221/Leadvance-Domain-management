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

/** Every sender name on the inboxes, with the client it is mapped to and the clients its domains are under now. */
export async function senderOverview(sql: postgres.Sql) {
  return sql<(TagRow & { current: string[] })[]>`
    with s as (
      select regexp_replace(lower(trim(i.sender_name)), '[[:space:]]+', ' ', 'g') as key, trim(i.sender_name) as shown, i.domain_id
      from inboxes i
      where i.status <> 'removed' and trim(coalesce(i.sender_name, '')) <> ''
    )
    select s.key, min(s.shown) as tag, count(distinct s.domain_id)::int as domains, count(*)::int as inboxes,
      c.id as client_id, c.name as client_name,
      coalesce(array_agg(distinct dc.name) filter (where dc.name is not null), '{}') as current
    from s
    left join client_senders m on m.sender = s.key left join clients c on c.id = m.client_id
    left join domains d on d.id = s.domain_id left join clients dc on dc.id = d.client_id
    group by s.key, c.id, c.name
    order by count(distinct s.domain_id) desc, s.key`;
}
