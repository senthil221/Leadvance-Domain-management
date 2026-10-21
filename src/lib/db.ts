import "server-only";
import postgres from "postgres";

// One pool per server process. In dev, keep it on globalThis so hot reloads
// don't open a new pool each time.
const globalForDb = globalThis as unknown as { sql?: postgres.Sql };

export const sql =
  globalForDb.sql ??
  postgres(process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres", {
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idle_timeout: 20,
    onnotice: () => {},
    transform: postgres.camel,
    types: {
      // numeric comes back as a string by default; the app only stores small
      // rates and reputations in it, so a JS number is safe.
      numeric: { to: 1700, from: [1700], serialize: (v: number) => String(v), parse: (v: string) => Number(v) },
    },
  });

if (process.env.NODE_ENV !== "production") globalForDb.sql = sql;

// Job code (src/jobs) is shared with the worker and reads snake_case columns
// and JSON keys. The camel transform above also renames keys inside json
// values ({"daily_limit"} comes back as {dailyLimit}), so jobs started from
// the app get a plain connection like the worker's.
const globalForJobs = globalThis as unknown as { jobSql?: postgres.Sql };
export const jobSql =
  globalForJobs.jobSql ??
  postgres(process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres", {
    max: Number(process.env.DATABASE_JOB_POOL_MAX ?? 3),
    idle_timeout: 20,
    onnotice: () => {},
  });

if (process.env.NODE_ENV !== "production") globalForJobs.jobSql = jobSql;
