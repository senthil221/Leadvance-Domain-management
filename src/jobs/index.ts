import type postgres from "postgres";
import { createSmartlead, type Smartlead } from "../integrations/smartlead";
import { syncAccounts, syncCampaigns, syncClients, syncDomainStats, dayIn } from "./smartlead-sync";

// The worker's jobs and how often each runs. A job that needs an integration
// whose key is missing reports "skipped" instead of failing.

export type JobContext = { sql: postgres.Sql; smartlead: Smartlead | null; timezone: string };
export type Job = { name: string; label: string; everyMinutes: number; run: (ctx: JobContext) => Promise<Record<string, unknown>> };

const needsSmartlead = (fn: (ctx: JobContext & { smartlead: Smartlead }) => Promise<Record<string, unknown>>) =>
  async (ctx: JobContext) => (ctx.smartlead ? fn({ ...ctx, smartlead: ctx.smartlead }) : { skipped: "SMARTLEAD_API_KEY not set" });

export const JOBS: Job[] = [
  {
    name: "smartlead-accounts",
    label: "Smartlead inboxes",
    everyMinutes: 30,
    run: needsSmartlead(async ({ sql, smartlead }) => {
      const clients = await syncClients(sql, smartlead).catch((e: Error) => ({ clientsError: e.message }));
      return { ...clients, ...(await syncAccounts(sql, smartlead)) };
    }),
  },
  {
    name: "smartlead-campaigns",
    label: "Smartlead campaigns",
    everyMinutes: 60,
    run: needsSmartlead(({ sql, smartlead }) => syncCampaigns(sql, smartlead)),
  },
  {
    name: "smartlead-domain-stats",
    label: "Smartlead daily numbers",
    everyMinutes: 30,
    run: needsSmartlead(({ sql, smartlead, timezone }) => syncDomainStats(sql, smartlead, timezone)),
  },
  {
    name: "rollup",
    label: "Daily stats and health rules",
    everyMinutes: 10,
    run: async ({ sql, timezone }) => {
      const [r] = await sql`select rollup_daily_stats(${dayIn(timezone, -2)}::date, ${timezone}) as n`;
      const [h] = await sql`select opened, resolved from evaluate_health_rules()`;
      return { statRows: Number(r.n), alertsOpened: Number(h.opened), alertsResolved: Number(h.resolved) };
    },
  },
  {
    name: "retire-drained",
    label: "Retire drained domains",
    everyMinutes: 60,
    run: async ({ sql }) => {
      const [r] = await sql`select retire_drained_domains() as n`;
      return { retired: Number(r.n) };
    },
  },
];

export async function jobContext(sql: postgres.Sql): Promise<JobContext> {
  const [tz] = await sql`select value #>> '{}' as tz from settings where key = 'stats_timezone'`;
  const apiKey = process.env.SMARTLEAD_API_KEY;
  return {
    sql,
    timezone: (tz?.tz as string) || "UTC",
    smartlead: apiKey ? createSmartlead({ apiKey, sql, dryRun: process.env.INTEGRATIONS_DRY_RUN !== "false" }) : null,
  };
}

/** Runs one job and records the outcome in job_state. */
export async function runJob(sql: postgres.Sql, job: Job, ctx?: JobContext) {
  await sql`insert into job_state (job, last_started_at) values (${job.name}, now())
    on conflict (job) do update set last_started_at = now()`;
  try {
    const detail = await job.run(ctx ?? (await jobContext(sql)));
    await sql`update job_state set last_finished_at = now(), last_ok = true, last_error = null, last_detail = ${sql.json(detail as postgres.JSONValue)}
      where job = ${job.name}`;
    return { ok: true as const, detail };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await sql`update job_state set last_finished_at = now(), last_ok = false, last_error = ${message.slice(0, 2000)} where job = ${job.name}`;
    return { ok: false as const, error: message };
  }
}
