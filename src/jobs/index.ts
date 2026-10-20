import type postgres from "postgres";
import { createHypertide, type Hypertide, type SmartleadCredentials } from "../integrations/hypertide";
import { createPorkbun, type Porkbun } from "../integrations/porkbun";
import { createSmartlead, type Smartlead } from "../integrations/smartlead";
import { syncPorkbunDomains, syncPorkbunNameservers } from "./porkbun-sync";
import { syncHypertideOrders } from "./hypertide-sync";
import { processNameserverRequests } from "./nameservers";
import { advanceReplacements, trackHypertideOrders } from "./replacements";
import { syncAccounts, syncCampaigns, syncClients, syncDomainStats, dayIn } from "./smartlead-sync";

// The worker's jobs and how often each runs. A job that needs an integration
// whose key is missing reports "skipped" instead of failing.

export type JobContext = {
  sql: postgres.Sql;
  smartlead: Smartlead | null;
  porkbun: Porkbun | null;
  hypertide: Hypertide | null;
  hypertideCredentials: Partial<SmartleadCredentials>;
  timezone: string;
};
export type Job = { name: string; label: string; everyMinutes: number; run: (ctx: JobContext) => Promise<Record<string, unknown>> };

const needsSmartlead = (fn: (ctx: JobContext & { smartlead: Smartlead }) => Promise<Record<string, unknown>>) =>
  async (ctx: JobContext) => (ctx.smartlead ? fn({ ...ctx, smartlead: ctx.smartlead }) : { skipped: "SMARTLEAD_API_KEY not set" });

const needsPorkbun = (fn: (ctx: JobContext & { porkbun: Porkbun }) => Promise<Record<string, unknown>>) =>
  async (ctx: JobContext) => (ctx.porkbun ? fn({ ...ctx, porkbun: ctx.porkbun }) : { skipped: "PORKBUN_API_KEY / PORKBUN_SECRET_KEY not set" });

export const JOBS: Job[] = [
  {
    name: "replacement-steps",
    label: "Replacement steps",
    everyMinutes: 1,
    run: ({ sql, porkbun, hypertide, hypertideCredentials }) => advanceReplacements(sql, { porkbun, hypertide, hypertideCredentials }),
  },
  {
    name: "hypertide-orders",
    label: "Hypertide orders",
    everyMinutes: 5,
    run: async (ctx) => {
      if (!ctx.hypertide) return { skipped: "HYPERTIDE_API_KEY not set" };
      const stepCtx = { porkbun: ctx.porkbun, hypertide: ctx.hypertide, hypertideCredentials: ctx.hypertideCredentials };
      const synced = await syncHypertideOrders(ctx.sql, stepCtx);
      const tracked = await trackHypertideOrders(ctx.sql, stepCtx);
      return { ...synced, tracking: tracked.open };
    },
  },
  {
    name: "nameserver-requests",
    label: "Nameserver changes",
    everyMinutes: 1,
    run: ({ sql, porkbun, hypertide }) => processNameserverRequests(sql, { porkbun, hypertide }),
  },
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
    label: "Smartlead 7-day numbers",
    everyMinutes: 30,
    run: needsSmartlead(({ sql, smartlead, timezone }) => syncDomainStats(sql, smartlead, timezone)),
  },
  {
    name: "porkbun-domains",
    label: "Porkbun domains",
    everyMinutes: 360,
    run: needsPorkbun(({ sql, porkbun }) => syncPorkbunDomains(sql, porkbun)),
  },
  {
    name: "porkbun-nameservers",
    label: "Porkbun nameservers",
    everyMinutes: 60,
    run: needsPorkbun(({ sql, porkbun }) => syncPorkbunNameservers(sql, porkbun)),
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
  const dryRun = process.env.INTEGRATIONS_DRY_RUN !== "false";
  const pbKey = process.env.PORKBUN_API_KEY, pbSecret = process.env.PORKBUN_SECRET_KEY;
  const htUrl = process.env.HYPERTIDE_API_URL || "https://backend.hypertide.io/api/v1";
  const htKey = process.env.HYPERTIDE_API_KEY;
  return {
    sql,
    hypertide: htKey ? createHypertide({ baseUrl: htUrl, apiKey: htKey, sql, dryRun }) : null,
    // Hypertide needs the Smartlead login to connect new inboxes.
    hypertideCredentials: {
      api_key: apiKey,
      username: process.env.HYPERTIDE_SMARTLEAD_USERNAME,
      password: process.env.HYPERTIDE_SMARTLEAD_PASSWORD,
      oauth_link: process.env.HYPERTIDE_SMARTLEAD_OAUTH_LINK,
    },
    porkbun: pbKey && pbSecret ? createPorkbun({ apiKey: pbKey, secretKey: pbSecret, sql, dryRun }) : null,
    timezone: (tz?.tz as string) || "UTC",
    smartlead: apiKey ? createSmartlead({ apiKey, sql, dryRun }) : null,
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
