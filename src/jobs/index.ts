import type postgres from "postgres";
import { createHypertide, type Hypertide, type SmartleadCredentials } from "../integrations/hypertide";
import { createPorkbun, type Porkbun } from "../integrations/porkbun";
import { loadRegistrars, type RegistrarAccount } from "../integrations/registrars";
import { createSmartlead, type Smartlead } from "../integrations/smartlead";
import { createSmartleadApp, type SmartleadApp } from "../integrations/smartlead-app";
import { syncBlacklists } from "./blacklist";
import { fillBounceCauses } from "./bounce-causes";
import { syncHypertideOrders } from "./hypertide-sync";
import { loadIcemailAccounts, syncAllIcemail } from "./icemail-sync";
import { processInboxChanges, runDuePlans } from "./inbox-settings";
import { checkNameservers, processNameserverRequests } from "./nameservers";
import { advanceReplacements, trackHypertideOrders } from "./replacements";
import { syncAllRegistrars } from "./registrar-sync";
import { enrolNewDomains } from "./warmup-program";
import { syncAccounts, syncCampaigns, syncClients, syncDomainStats, dayIn } from "./smartlead-sync";
import { syncPlacementSeeds } from "./placement-seeds";
import { runPlacementTests } from "./placement-tests";
import { syncUntrackedReplies } from "./untracked-replies";

// The worker's jobs and how often each runs. A job that needs an integration
// whose key is missing reports "skipped" instead of failing.

export type JobContext = {
  sql: postgres.Sql;
  smartlead: Smartlead | null;
  smartleadApp: SmartleadApp | null;
  /** Porkbun from the server's .env, if set. */
  porkbun: Porkbun | null;
  /** Every registrar account: the .env Porkbun plus those added in Settings. */
  registrars: RegistrarAccount[];
  /** Accounts whose saved keys can't be read. */
  brokenRegistrars: { id: string; error: string }[];
  hypertide: Hypertide | null;
  hypertideCredentials: Partial<SmartleadCredentials>;
  timezone: string;
};
export type Job = { name: string; label: string; everyMinutes: number; run: (ctx: JobContext) => Promise<Record<string, unknown>> };

const needsSmartlead = (fn: (ctx: JobContext & { smartlead: Smartlead }) => Promise<Record<string, unknown>>) =>
  async (ctx: JobContext) => (ctx.smartlead ? fn({ ...ctx, smartlead: ctx.smartlead }) : { skipped: "SMARTLEAD_API_KEY not set" });

export const JOBS: Job[] = [
  {
    name: "replacement-steps",
    label: "Replacement steps",
    everyMinutes: 1,
    run: ({ sql, porkbun, registrars, hypertide, hypertideCredentials, smartlead, smartleadApp }) =>
      advanceReplacements(sql, { porkbun, registrars, hypertide, hypertideCredentials, smartlead, smartleadApp }),
  },
  {
    name: "hypertide-orders",
    label: "Hypertide orders",
    everyMinutes: 5,
    run: async (ctx) => {
      if (!ctx.hypertide) return { skipped: "HYPERTIDE_API_KEY not set" };
      const stepCtx = { porkbun: ctx.porkbun, registrars: ctx.registrars, hypertide: ctx.hypertide, hypertideCredentials: ctx.hypertideCredentials, smartlead: ctx.smartlead };
      const synced = await syncHypertideOrders(ctx.sql, stepCtx);
      const tracked = await trackHypertideOrders(ctx.sql, stepCtx);
      return { ...synced, tracking: tracked.open };
    },
  },
  {
    name: "icemail",
    label: "Icemail domains and mailboxes",
    everyMinutes: 30,
    run: async ({ sql }) => {
      const { accounts, broken } = await loadIcemailAccounts(sql);
      return syncAllIcemail(sql, accounts, broken);
    },
  },
  {
    name: "inbox-settings",
    label: "Inbox settings and daily plans",
    everyMinutes: 1,
    run: needsSmartlead(async ({ sql, smartlead, timezone }) => {
      const plans = await runDuePlans(sql, timezone);
      return { ...plans, ...(await processInboxChanges(sql, smartlead)) };
    }),
  },
  {
    name: "nameserver-check",
    label: "Nameserver lookups (DNS)",
    everyMinutes: 30,
    run: ({ sql, porkbun, registrars }) => checkNameservers(sql, { porkbun, registrars }),
  },
  {
    name: "nameserver-requests",
    label: "Nameserver changes",
    everyMinutes: 1,
    run: ({ sql, porkbun, registrars, hypertide }) => processNameserverRequests(sql, { porkbun, registrars, hypertide }),
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
    name: "warmup-new-domains",
    label: "Warm up new domains",
    everyMinutes: 30,
    run: ({ sql, smartleadApp }) => enrolNewDomains(sql, smartleadApp),
  },
  {
    name: "untracked-replies",
    label: "Smartlead untracked replies",
    everyMinutes: 15,
    run: needsSmartlead(({ sql, smartlead }) => syncUntrackedReplies(sql, smartlead)),
  },
  {
    name: "placement-seeds",
    label: "Placement test seeds",
    everyMinutes: 60,
    run: ({ sql }) => syncPlacementSeeds(sql),
  },
  {
    name: "placement-tests",
    label: "Placement tests",
    everyMinutes: 2,
    run: needsSmartlead(({ sql, smartlead, timezone }) => runPlacementTests(sql, smartlead, { timezone })),
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
    name: "smartlead-blacklists",
    label: "Smartlead blacklist scan",
    everyMinutes: 360,
    run: async ({ sql, smartleadApp }) => (smartleadApp ? syncBlacklists(sql, smartleadApp) : { skipped: "SMARTLEAD_JWT not set" }),
  },
  {
    name: "registrar-domains",
    label: "Registrar domains",
    everyMinutes: 360,
    run: ({ sql, registrars, brokenRegistrars }) => syncAllRegistrars(sql, registrars, brokenRegistrars),
  },
  {
    name: "bounce-causes",
    label: "Bounce reasons",
    everyMinutes: 2,
    run: ({ sql }) => fillBounceCauses(sql),
  },
  {
    name: "rollup",
    label: "Daily stats and health rules",
    everyMinutes: 10,
    run: async ({ sql, timezone }) => {
      const [r] = await sql`select rollup_daily_stats(${dayIn(timezone, -2)}::date, ${timezone}) as n`;
      const [h] = await sql`select opened, resolved from evaluate_health_rules()`;
      await sql`select refresh_last_used()`;
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
  const porkbun = pbKey && pbSecret ? createPorkbun({ apiKey: pbKey, secretKey: pbSecret, sql, dryRun }) : null;
  const { accounts, broken } = await loadRegistrars(sql, { dryRun, porkbun });
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
    porkbun,
    registrars: accounts,
    brokenRegistrars: broken,
    timezone: (tz?.tz as string) || "UTC",
    smartlead: apiKey ? createSmartlead({ apiKey, sql, dryRun }) : null,
    smartleadApp: process.env.SMARTLEAD_JWT ? createSmartleadApp({ jwt: process.env.SMARTLEAD_JWT.trim().replace(/^bearer\s+/i, ""), sql, dryRun }) : null,
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
