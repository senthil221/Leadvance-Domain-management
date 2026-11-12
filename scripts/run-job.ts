// Runs one worker job here and now and prints the result, for local work and
// debugging. It doesn't take the worker's lock: with a worker running, use
// Run now in Settings instead, so the job can't run twice at once.
// Usage: npm run job -- smartlead-accounts   (no name lists the jobs)
import postgres from "postgres";
import { JOBS, runJob } from "../src/jobs";

const name = process.argv[2];
const job = JOBS.find((j) => j.name === name);
if (!job) {
  console.log("jobs:\n" + JOBS.map((j) => `  ${j.name.padEnd(24)} every ${j.everyMinutes}m  ${j.label}`).join("\n"));
  process.exit(name ? 1 : 0);
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const sql = postgres(url, { max: 2, onnotice: () => {} });
const result = await runJob(sql, job);
console.log(JSON.stringify(result, null, 2));
await sql.end();
process.exit(result.ok ? 0 : 1);
