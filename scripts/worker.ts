// Background worker: runs each job in src/jobs on its interval. Schedule
// state lives in job_state, so restarts pick up where they left off. A
// Postgres advisory lock makes sure only one worker runs jobs at a time.
// Usage: npm run worker
import postgres from "postgres";
import { JOBS, jobContext, runJob } from "../src/jobs";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const sql = postgres(url, { max: 4, onnotice: () => {} });
const TICK_MS = 30_000;
const LOCK_KEY = 4_221_017; // any constant shared by all workers

let stopping = false;
const log = (msg: string, extra?: unknown) =>
  console.log(`${new Date().toISOString()} ${msg}${extra === undefined ? "" : " " + JSON.stringify(extra)}`);

// A job skipped for a missing key is retried every 5 minutes, so adding the
// key takes effect quickly instead of after the job's full interval.
const SKIPPED_RETRY_MIN = 5;

async function dueJobs() {
  const state = await sql<{ job: string; last_started_at: Date | null; skipped: boolean }[]>`
    select job, last_started_at, coalesce(last_detail ? 'skipped', false) as skipped from job_state`;
  const last = new Map(state.map((s) => [s.job, s]));
  return JOBS.filter((j) => {
    const s = last.get(j.name);
    if (!s?.last_started_at) return true;
    const every = s.skipped ? Math.min(SKIPPED_RETRY_MIN, j.everyMinutes) : j.everyMinutes;
    return Date.now() - s.last_started_at.getTime() >= every * 60_000;
  });
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
      const due = await dueJobs();
      if (due.length) {
        const ctx = await jobContext(sql);
        for (const job of due) {
          if (stopping) break;
          const started = Date.now();
          const r = await runJob(sql, job, ctx);
          log(`${job.name} ${r.ok ? "ok" : "FAILED"} in ${Date.now() - started}ms`, r.ok ? r.detail : r.error);
        }
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
