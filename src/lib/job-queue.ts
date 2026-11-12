import type postgres from "postgres";

// Jobs run only in the background worker, which runs one at a time under its
// own lock. The app never runs a job itself: two runs of one job at once could
// place a second Hypertide order or a second placement campaign. To have a
// job run now, the app clears its last start; the worker treats a job with no
// start as due and runs it ahead of the scheduled ones (scripts/worker.ts).

/** Asks the worker to run this job next. Returns the database time of the request. */
export async function queueJob(sql: postgres.Sql, job: string): Promise<Date> {
  const [row] = await sql<{ at: Date }[]>`
    insert into job_state (job) values (${job})
    on conflict (job) do update set last_started_at = null
    returning now() as at`;
  return row.at;
}

export type JobWait =
  | { state: "done"; ok: true; detail: Record<string, unknown> | null }
  | { state: "done"; ok: false; error: string }
  /** Queued or running, but not finished within the wait. */
  | { state: "waiting"; started: boolean }
  /** No job has started in the last few minutes: the worker isn't running. */
  | { state: "no-worker" };

/** The last start of each job, from job_state. */
export type JobLast = { job: string; lastStartedAt: Date | null; skipped: boolean };

// A job skipped for a missing key is retried every 5 minutes, so adding the
// key takes effect quickly instead of after the job's full interval.
const SKIPPED_RETRY_MIN = 5;

/**
 * The job the worker runs next: one asked for in the app (no last start)
 * first, then the one furthest past its interval, so a slow job can't starve
 * the rest. Ties go in the order of the list.
 */
export function nextDueJob<J extends { name: string; everyMinutes: number }>(jobs: J[], state: JobLast[], now = Date.now()): J | null {
  const last = new Map(state.map((s) => [s.job, s]));
  const due = jobs.flatMap((job, order) => {
    const s = last.get(job.name);
    if (!s?.lastStartedAt) return [{ job, late: Infinity, order }];
    const every = s.skipped ? Math.min(SKIPPED_RETRY_MIN, job.everyMinutes) : job.everyMinutes;
    const late = now - s.lastStartedAt.getTime() - every * 60_000;
    return late >= 0 ? [{ job, late, order }] : [];
  });
  due.sort((a, b) => (a.late === b.late ? a.order - b.order : b.late - a.late));
  return due[0]?.job ?? null;
}

/** What to say when a run asked for isn't finished yet. */
export const unfinishedRunText = ({ started, noWorker }: { started: boolean; noWorker?: boolean }) =>
  noWorker ? "Queued, but the background worker isn't running: nothing has run for minutes. It runs once the worker is back."
    : started ? "Still running on the server; the page shows it when it finishes."
    : "Queued: the server runs it after the job it's on now.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for the run asked for at `since` to finish. Three jobs run every
 * minute, so a worker that has started nothing for three minutes, and isn't in
 * the middle of a job, isn't running.
 */
export async function waitForJob(sql: postgres.Sql, job: string, since: Date, { waitMs = 5 * 60_000, pollMs = 2000 } = {}): Promise<JobWait> {
  const [w] = await sql<{ alive: boolean }[]>`
    select coalesce(bool_or(last_started_at > now() - interval '3 minutes'
      or (last_started_at > now() - interval '3 hours' and (last_finished_at is null or last_finished_at < last_started_at))), false) as alive
    from job_state`;
  if (!w.alive) return { state: "no-worker" };
  const end = Date.now() + waitMs;
  let started = false;
  for (;;) {
    const [s] = await sql<{ started: boolean; finished: boolean; ok: boolean | null; error: string | null; detail: Record<string, unknown> | null }[]>`
      select coalesce(last_started_at >= ${since}, false) as started,
        coalesce(last_started_at >= ${since} and last_finished_at >= last_started_at, false) as finished,
        last_ok as ok, last_error as error, last_detail as detail
      from job_state where job = ${job}`;
    started = Boolean(s?.started);
    if (s?.finished) return s.ok ? { state: "done", ok: true, detail: s.detail } : { state: "done", ok: false, error: s.error ?? "The job failed" };
    if (Date.now() >= end) return { state: "waiting", started };
    await sleep(pollMs);
  }
}
