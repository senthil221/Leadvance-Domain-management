import type postgres from "postgres";
import type { Smartlead } from "../integrations/smartlead";
import { distribute, randomInt, type Rng } from "../lib/distribute";

// Inbox settings changed in the app go into inbox_setting_changes; this pushes
// them to Smartlead one inbox at a time (merging several waiting changes for
// the same inbox) and keeps the local copy in step. Sending plans add a fresh
// set of daily limits once a day. Shared by the worker and the app.

type Sql = postgres.Sql;

export type InboxChanges = Partial<{
  daily_limit: number;
  min_wait_mins: number;
  warmup_enabled: boolean;
  warmup_per_day: number;
  warmup_rampup: number;
  warmup_reply_rate: number;
}>;

const SENDING = ["daily_limit", "min_wait_mins"] as const;

/** daily_limit whether the row was read as daily_limit or (through a camel-case connection) dailyLimit. */
const snakeKeys = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`), v])) as InboxChanges;
const WARMUP = ["warmup_enabled", "warmup_per_day", "warmup_rampup", "warmup_reply_rate"] as const;

export async function processInboxChanges(sql: Sql, sl: Smartlead, limit = 400) {
  const claimed = await sql`
    update inbox_setting_changes c set status = 'running'
    where c.id in (select id from inbox_setting_changes where status = 'pending' order by created_at limit ${limit} for update skip locked)
    returning c.id, c.inbox_id as inbox, c.changes, c.created_at as at`;
  if (!claimed.length) return { changes: 0 };

  const byInbox = new Map<string, { ids: string[]; changes: InboxChanges }>();
  for (const c of [...claimed].sort((a, b) => +new Date(a.at) - +new Date(b.at))) {
    const e = byInbox.get(c.inbox) ?? { ids: [], changes: {} };
    e.ids.push(c.id);
    Object.assign(e.changes, snakeKeys(c.changes));
    byInbox.set(c.inbox, e);
  }
  const inboxes = await sql`
    select id, smartlead_account_id as account, daily_limit as limit, min_wait_mins as wait, warmup_enabled as warm,
      warmup_per_day as perday, warmup_rampup as rampup, warmup_reply_rate as reply
    from inboxes where id = any(${[...byInbox.keys()]}::uuid[])`;

  let done = 0, failed = 0, dry = 0;
  for (const ib of inboxes) {
    const { ids, changes } = byInbox.get(ib.id)!;
    const finish = (status: string, error: string | null = null) =>
      sql`update inbox_setting_changes set status = ${status}, error = ${error}, finished_at = now() where id = any(${ids}::uuid[])`;
    if (!ib.account) {
      await finish("failed", "This inbox isn't linked to a Smartlead account");
      failed++;
      continue;
    }
    try {
      const v = {
        limit: changes.daily_limit ?? ib.limit ?? 0,
        wait: changes.min_wait_mins ?? ib.wait ?? 15,
        warm: changes.warmup_enabled ?? ib.warm ?? true,
        perday: changes.warmup_per_day ?? ib.perday ?? undefined,
        rampup: changes.warmup_rampup ?? ib.rampup ?? undefined,
        reply: changes.warmup_reply_rate ?? ib.reply ?? undefined,
      };
      if (SENDING.some((k) => k in changes)) {
        await sl.updateSending(Number(ib.account), { max_email_per_day: v.limit, time_to_wait_in_mins: v.wait });
      }
      if (WARMUP.some((k) => k in changes)) {
        await sl.updateWarmup(Number(ib.account), {
          warmup_enabled: v.warm,
          ...(v.perday != null ? { total_warmup_per_day: v.perday } : {}),
          ...(v.rampup != null ? { daily_rampup: v.rampup } : {}),
          ...(v.reply != null ? { reply_rate_percentage: v.reply } : {}),
        });
      }
      if (sl.dryRun) {
        await finish("dry_run");
        dry++;
        continue;
      }
      await sql`update inboxes set
          daily_limit = ${v.limit}, min_wait_mins = ${v.wait}, warmup_enabled = ${v.warm},
          warmup_per_day = ${v.perday ?? null}, warmup_rampup = ${v.rampup ?? null}, warmup_reply_rate = ${v.reply ?? null}
        where id = ${ib.id}`;
      await finish("done");
      done++;
    } catch (e) {
      await finish("failed", (e instanceof Error ? e.message : String(e)).slice(0, 1000));
      failed++;
    }
  }
  return { changes: claimed.length, inboxes: inboxes.length, done, failed, dryRun: dry };
}

// ---------------------------------------------------------------------------
// Sending plans
// ---------------------------------------------------------------------------

type Plan = {
  id: string; name: string; mode: "shuffle" | "random_total"; totalmin: number; totalmax: number;
  inboxmin: number; inboxmax: number; client: string | null; domains: string[];
};

/** Today's limits for one plan, queued as setting changes. */
export async function runPlan(sql: Sql, plan: Plan, actor: string, rng: Rng = Math.random) {
  const inboxes = await sql`
    select i.id from inboxes i join domains d on d.id = i.domain_id
    where i.status = 'connected' and i.smartlead_account_id is not null
      and (${plan.client}::uuid is null or (d.client_id = ${plan.client}::uuid and d.status in ('active', 'warming')))
      and (cardinality(${plan.domains}::uuid[]) = 0 or d.id = any(${plan.domains}::uuid[]))
    order by i.email`;
  const asked = plan.mode === "shuffle" ? plan.totalmin : randomInt(plan.totalmin, plan.totalmax, rng);
  const split = distribute(inboxes.length, asked, plan.inboxmin, plan.inboxmax, rng);
  if (inboxes.length) {
    await sql`
      insert into inbox_setting_changes (inbox_id, changes, source, actor)
      select x.id, jsonb_build_object('daily_limit', x.n), ${"plan:" + plan.id}, ${actor}
      from unnest(${inboxes.map((i) => i.id as string)}::uuid[], ${split.values}::int[]) as x(id, n)`;
  }
  const result = { asked, total: split.total, inboxes: inboxes.length, clamped: split.clamped,
    min: split.values.length ? Math.min(...split.values) : 0, max: split.values.length ? Math.max(...split.values) : 0 };
  await sql`update sending_plans set last_result = ${sql.json(result)} where id = ${plan.id}`;
  return result;
}

const PLAN_COLUMNS = (sql: Sql) => sql`id, name, mode, total_min as totalmin, total_max as totalmax,
  inbox_min as inboxmin, inbox_max as inboxmax, client_id as client, domain_ids as domains`;

export async function loadPlan(sql: Sql, id: string) {
  const [p] = await sql`select ${PLAN_COLUMNS(sql)} from sending_plans where id = ${id}`;
  return p as Plan | undefined;
}

/** Plans that haven't run today and whose hour has come, in the stats timezone. */
export async function runDuePlans(sql: Sql, timezone: string, now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(now));
  const due = await sql`
    update sending_plans set last_run_on = ${today}::date
    where enabled and run_hour <= ${hour} and (last_run_on is null or last_run_on < ${today}::date)
    returning ${PLAN_COLUMNS(sql)}`;
  const results = [];
  for (const p of due) results.push({ plan: p.name, ...(await runPlan(sql, p as Plan, "daily plan")) });
  return { plansRun: results.length, ...(results.length ? { plans: results } : {}) };
}
