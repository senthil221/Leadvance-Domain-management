// Background worker: runs each job in src/jobs on its interval, one at a
// time. Schedule state lives in job_state, so restarts pick up where they left
// off. A Postgres advisory lock makes sure only one worker runs jobs at a time,
// and it's the only place jobs run: the app asks for a run by clearing a job's
// last start (src/lib/job-queue.ts), and such a job goes first.
// Usage: npm run worker
import postgres from "postgres";
import { JOBS, jobContext, runJob, type JobContext } from "../src/jobs";
import { nextDueJob, type JobLast } from "../src/lib/job-queue";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const sql = postgres(url, { max: 4, onnotice: () => {} });
// How often an idle worker looks for due jobs and for runs asked for in the app.
const TICK_MS = 10_000;
const LOCK_KEY = 4_221_017; // any constant shared by all workers

let stopping = false;
const log = (msg: string, extra?: unknown) =>
  console.log(`${new Date().toISOString()} ${msg}${extra === undefined ? "" : " " + JSON.stringify(extra)}`);

async function nextJob() {
  const state = await sql<JobLast[]>`
    select job, last_started_at as "lastStartedAt", coalesce(last_detail ? 'skipped', false) as skipped from job_state`;
  return nextDueJob(JOBS, state);
}

async function main() {
  // The lock is held on one reserved connection for the life of the process.
  const lockConn = await sql.reserve();
  for (;;) {
    const [{ locked }] = await lockConn<{ locked: boolean }[]>`select pg_try_advisory_lock(${LOCK_KEY}) as locked`;
    if (locked) break;
    log("another worker holds the lock; waiting");
    await new Promise((r) => setTimeout(r, TICK_MS));
    if (stopping) return;
  }
  log(`worker started: ${JOBS.map((j) => `${j.name}/${j.everyMinutes}m`).join(", ")}`);

  while (!stopping) {
    try {
      // One context for a run of due jobs, so keys saved in Settings apply from the next.
      let ctx: JobContext | null = null;
      for (let job = await nextJob(); job && !stopping; job = await nextJob()) {
        ctx ??= await jobContext(sql);
        const started = Date.now();
        const r = await runJob(sql, job, ctx);
        log(`${job.name} ${r.ok ? "ok" : "FAILED"} in ${Date.now() - started}ms`, r.ok ? r.detail : r.error);
      }
    } catch (e) {
      log("tick failed", e instanceof Error ? e.message : String(e));
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
  lockConn.release();
}

const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  log("stopping");
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch(async (e) => {
  log("worker crashed", e instanceof Error ? e.stack : String(e));
  await sql.end({ timeout: 5 });
  process.exit(1);
});
