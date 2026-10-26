import type postgres from "postgres";
import type { SmartleadApp, SmartleadTag } from "../integrations/smartlead-app";
import { parseWarmupProgram, type WarmupProgram } from "../lib/warmup-program";
import { retagRows } from "./replacements";

// New domains that connect to Smartlead get warmup switched on with the
// values from Settings → Warming up and the New tag, automatically when that is
// switched on, or by hand from Smartlead → Warming up. The warmup values go
// through the same queue as every other inbox change (inbox_setting_changes),
// so a dry run only logs them.

type Sql = postgres.Sql;

export async function loadWarmupProgram(sql: Sql) {
  const [row] = await sql`select value::text as v from settings where key = 'warmup_program'`;
  return parseWarmupProgram(row ? JSON.parse(row.v as string) : null);
}

/** Young, connected, not tagged to a client yet, not enrolled, not warming through a replacement, and with valid DNS. */
export async function newDomainIds(sql: Sql, maxAgeDays: number) {
  const due = await sql`
    select d.id
    from domains d
    join inboxes i on i.domain_id = d.id and i.status = 'connected' and i.smartlead_account_id is not null
    where d.warmup_started_at is null and d.status in ('warming', 'active')
      and not exists (select 1 from replacement_items ri where ri.new_domain_id = d.id)
      and not exists (select 1 from unnest(d.tags) t where lower(t) = 'new')
      and d.dns_spf and d.dns_dkim and d.dns_dmarc and d.dns_mx and coalesce(d.nameservers_answering, true)
      and not exists (
        select 1 from inboxes x cross join lateral unnest(x.smartlead_tags) as u(t)
        join client_tags m on m.tag = regexp_replace(lower(trim(u.t)), '[[:space:]]+', ' ', 'g')
        where x.domain_id = d.id and x.status <> 'removed')
    group by d.id
    having floor(extract(epoch from now() - coalesce(min(i.smartlead_created_at), min(d.purchased_at::timestamptz), min(d.registered_at::timestamptz))) / 86400) <= ${maxAgeDays}`;
  return due.map((d) => d.id as string);
}

/**
 * Starts the warm-up of these domains: the days start counting, warmup is
 * switched on with the programme's values, and the domain and its inboxes get
 * the New tag (in Smartlead too when a token is set and dry run is off).
 */
export async function startWarmup(sql: Sql, app: SmartleadApp | null, ids: string[], p: WarmupProgram, actor: string) {
  if (!ids.length) return { enrolled: 0, inboxes: 0, tagged: 0 };
  await sql`update domains set warmup_started_at = now(), warmup_days = ${p.days}, warmup_done_at = null, warmup_moved_to = null,
      tags = array(select distinct t from unnest(tags || array['New']) t order by 1)
    where id = any(${ids}::uuid[])`;
  const inboxes = await sql`
    select id, smartlead_account_id as account, smartlead_tags as tags from inboxes
    where domain_id = any(${ids}::uuid[]) and status = 'connected' and smartlead_account_id is not null`;
  if (inboxes.length) {
    await sql`
      insert into inbox_setting_changes (inbox_id, changes, source, actor)
      select x.id, ${sql.json({ warmup_enabled: true, warmup_per_day: p.perDay, warmup_rampup: p.rampup, warmup_reply_rate: p.replyRate })}, 'warmup-program', ${actor}
      from unnest(${inboxes.map((i) => i.id as string)}::uuid[]) as x(id)`;
  }
  let tagged = 0;
  if (app && !app.dryRun && inboxes.length) {
    let known: SmartleadTag[] = await app.tags();
    const tagId = async (name: string) => {
      let t = known.find((k) => k.name.toLowerCase() === name.toLowerCase());
      if (!t) {
        const made = await app.createTag(name);
        if (!made) return null;
        known = [...known, made];
        t = made;
      }
      return t;
    };
    tagged = await retagRows(sql, app, inboxes, ["New"], [], tagId, () => known);
  }
  return { enrolled: ids.length, inboxes: inboxes.length, tagged };
}

export async function enrolNewDomains(sql: Sql, app: SmartleadApp | null = null) {
  const p = await loadWarmupProgram(sql);
  if (!p.enabled) return { skipped: "Automatic warm-up is off (Settings → Warming up)" };
  return startWarmup(sql, app, await newDomainIds(sql, p.maxAgeDays), p, "system");
}
