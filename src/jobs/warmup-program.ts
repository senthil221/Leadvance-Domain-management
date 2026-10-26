import type postgres from "postgres";
import { parseWarmupProgram } from "../lib/warmup-program";

// New domains that connect to Smartlead get warmup switched on with the
// values from Settings → Warming up. The settings go through the same queue as
// every other inbox change (inbox_setting_changes), so a dry run only logs them.

type Sql = postgres.Sql;

export async function enrolNewDomains(sql: Sql) {
  const [row] = await sql`select value::text as v from settings where key = 'warmup_program'`;
  const p = parseWarmupProgram(row ? JSON.parse(row.v as string) : null);
  if (!p.enabled) return { skipped: "Automatic warm-up is off (Settings → Warming up)" };

  // Young, connected, not tagged to a client yet, and not already warming through a replacement.
  const due = await sql`
    select d.id
    from domains d
    join inboxes i on i.domain_id = d.id and i.status = 'connected' and i.smartlead_account_id is not null
    where d.warmup_started_at is null and d.status in ('warming', 'active')
      and not exists (select 1 from unnest(d.tags) t where lower(t) = 'new')
      and not exists (
        select 1 from inboxes x cross join lateral unnest(x.smartlead_tags) as u(t)
        join client_tags m on m.tag = regexp_replace(lower(trim(u.t)), '[[:space:]]+', ' ', 'g')
        where x.domain_id = d.id and x.status <> 'removed')
    group by d.id
    having floor(extract(epoch from now() - coalesce(min(i.smartlead_created_at), min(d.purchased_at::timestamptz), min(d.registered_at::timestamptz))) / 86400) <= ${p.maxAgeDays}`;
  if (!due.length) return { enrolled: 0 };

  const ids = due.map((d) => d.id as string);
  await sql`update domains set warmup_started_at = now(), warmup_days = ${p.days} where id = any(${ids}::uuid[])`;
  const queued = await sql`
    insert into inbox_setting_changes (inbox_id, changes, source, actor)
    select i.id, ${sql.json({ warmup_enabled: true, warmup_per_day: p.perDay, warmup_rampup: p.rampup, warmup_reply_rate: p.replyRate })},
      'warmup-program', 'system'
    from inboxes i where i.domain_id = any(${ids}::uuid[]) and i.status = 'connected' and i.smartlead_account_id is not null
    returning id`;
  return { enrolled: ids.length, inboxes: queued.length };
}
