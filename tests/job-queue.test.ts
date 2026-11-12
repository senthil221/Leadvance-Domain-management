import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { nextDueJob, queueJob, waitForJob } from "../src/lib/job-queue";
import { loadMigrations } from "../scripts/migrations";

const jobs = [
  { name: "every-minute", everyMinutes: 1 },
  { name: "half-hour", everyMinutes: 30 },
  { name: "six-hours", everyMinutes: 360 },
];
const NOW = Date.parse("2026-11-13T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000);

describe("which job the worker runs next", () => {
  it("runs a job asked for in the app before any scheduled one", () => {
    const state = [
      { job: "every-minute", lastStartedAt: ago(50), skipped: false },
      { job: "half-hour", lastStartedAt: ago(1), skipped: false },
      { job: "six-hours", lastStartedAt: null, skipped: false },
    ];
    expect(nextDueJob(jobs, state, NOW)?.name).toBe("six-hours");
  });

  it("runs the job furthest past its interval first, so a frequent job can't starve the rest", () => {
    const state = [
      { job: "every-minute", lastStartedAt: ago(3), skipped: false }, // 2 minutes late
      { job: "half-hour", lastStartedAt: ago(45), skipped: false }, // 15 minutes late
      { job: "six-hours", lastStartedAt: ago(10), skipped: false },
    ];
    expect(nextDueJob(jobs, state, NOW)?.name).toBe("half-hour");
  });

  it("takes jobs never run in list order, and nothing when none is due", () => {
    expect(nextDueJob(jobs, [], NOW)?.name).toBe("every-minute");
    const fresh = jobs.map((j) => ({ job: j.name, lastStartedAt: ago(0.5), skipped: false }));
    expect(nextDueJob(jobs, fresh, NOW)).toBeNull();
  });

  it("retries a job skipped for a missing key after 5 minutes, not its full interval", () => {
    const state = [
      { job: "every-minute", lastStartedAt: ago(0.5), skipped: false },
      { job: "half-hour", lastStartedAt: ago(0.5), skipped: false },
      { job: "six-hours", lastStartedAt: ago(6), skipped: true },
    ];
    expect(nextDueJob(jobs, state, NOW)?.name).toBe("six-hours");
  });
});

const PORT = 54390;
let pg: PGlite;
let server: PGLiteSocketServer;
let sql: postgres.Sql;

beforeAll(async () => {
  pg = await PGlite.create();
  for (const m of loadMigrations()) await pg.exec(m.sql);
  server = new PGLiteSocketServer({ db: pg, port: PORT, host: "127.0.0.1" });
  await server.start();
  sql = postgres({ host: "127.0.0.1", port: PORT, database: "postgres", username: "postgres", max: 1, ssl: false, connection: { options: "" } });
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await server?.stop();
  await pg?.close();
});

beforeEach(async () => {
  await sql`delete from job_state`;
});

/** What the worker writes around a run (src/jobs/index.ts runJob). */
async function workerRuns(job: string, outcome: { ok: true; detail: Record<string, unknown> } | { ok: false; error: string }) {
  await sql`update job_state set last_started_at = now() where job = ${job}`;
  await sql`update job_state set last_finished_at = now(), last_ok = ${outcome.ok},
    last_error = ${outcome.ok ? null : outcome.error}, last_detail = ${outcome.ok ? sql.json(outcome.detail as postgres.JSONValue) : null}
    where job = ${job}`;
}

describe("asking the worker for a run", () => {
  it("clears the job's last start, so the worker sees it as due", async () => {
    await sql`insert into job_state (job, last_started_at, last_finished_at) values ('icemail', now() - interval '1 minute', now())`;
    await queueJob(sql, "icemail");
    await queueJob(sql, "registry-check");
    const rows = await sql`select job, last_started_at, last_finished_at from job_state order by job`;
    expect(rows.map((r) => [r.job, r.last_started_at])).toEqual([["icemail", null], ["registry-check", null]]);
    // The last run's finish stays, for the page.
    expect(rows[0].last_finished_at).not.toBeNull();
  });

  it("says so when the worker isn't running, instead of waiting", async () => {
    await sql`insert into job_state (job, last_started_at, last_finished_at) values ('replacement-steps', now() - interval '20 minutes', now() - interval '20 minutes')`;
    const since = await queueJob(sql, "placement-tests");
    expect(await waitForJob(sql, "placement-tests", since)).toEqual({ state: "no-worker" });
  });

  it("returns the worker's result for the run asked for", async () => {
    await sql`insert into job_state (job, last_started_at, last_finished_at) values ('replacement-steps', now() - interval '30 seconds', now())`;
    // An earlier run's result is not the one asked for.
    await sql`insert into job_state (job, last_started_at, last_finished_at, last_ok, last_detail) values ('placement-tests', now() - interval '5 minutes', now() - interval '4 minutes', true, '{"sent": 1}')`;
    const since = await queueJob(sql, "placement-tests");
    setTimeout(() => void workerRuns("placement-tests", { ok: true, detail: { sent: 4 } }), 150);
    expect(await waitForJob(sql, "placement-tests", since, { pollMs: 50 })).toEqual({ state: "done", ok: true, detail: { sent: 4 } });
  });

  it("returns the error when the run fails", async () => {
    await sql`insert into job_state (job, last_started_at) values ('replacement-steps', now())`;
    const since = await queueJob(sql, "untracked-replies");
    setTimeout(() => void workerRuns("untracked-replies", { ok: false, error: "Smartlead said no" }), 100);
    expect(await waitForJob(sql, "untracked-replies", since, { pollMs: 50 })).toEqual({ state: "done", ok: false, error: "Smartlead said no" });
  });

  it("stops waiting while the worker is busy, and says whether the run has started", async () => {
    // The worker is in the middle of a long job.
    await sql`insert into job_state (job, last_started_at, last_finished_at) values ('registrar-domains', now() - interval '20 minutes', now() - interval '6 hours')`;
    const since = await queueJob(sql, "placement-seeds");
    expect(await waitForJob(sql, "placement-seeds", since, { waitMs: 200, pollMs: 50 })).toEqual({ state: "waiting", started: false });
    await sql`update job_state set last_started_at = now() where job = 'placement-seeds'`;
    expect(await waitForJob(sql, "placement-seeds", since, { waitMs: 200, pollMs: 50 })).toEqual({ state: "waiting", started: true });
  });
});
