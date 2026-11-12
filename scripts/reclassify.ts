// Re-runs the reply classifier on every stored reply that nobody tagged by
// hand, then rebuilds the daily stats from the oldest changed day. Each reply
// is read from its stored webhook payload exactly as the webhook reads it
// (parseSmartleadEvent), so a re-run gives what a new delivery would.
// Usage: npx tsx scripts/reclassify.ts   (add --dry to only count changes)
import postgres from "postgres";
import { parseSmartleadEvent } from "../src/lib/smartlead-events";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const dry = process.argv.includes("--dry");
const sql = postgres(url, { max: 1, onnotice: () => {} });

const rows = await sql<{ id: number; cls: string | null; payload: unknown; at: Date }[]>`
  select id, reply_class::text as cls, payload, occurred_at as at
  from email_events where kind = 'reply' and not class_overridden`;

const changes = rows.flatMap((r) => {
  const to = parseSmartleadEvent(r.payload)?.replyClass;
  // A payload the webhook wouldn't read as a reply is left as it is.
  return to && to !== r.cls ? [{ id: r.id, from: r.cls, to, at: r.at }] : [];
});
const moves = new Map<string, number>();
for (const c of changes) moves.set(`${c.from} → ${c.to}`, (moves.get(`${c.from} → ${c.to}`) ?? 0) + 1);
console.log(`${rows.length} replies checked, ${changes.length} change${changes.length === 1 ? "" : "s"}${dry ? " (dry run)" : ""}`);
for (const [k, n] of moves) console.log(`  ${k}: ${n}`);

if (!dry && changes.length) {
  await sql.begin(async (tx) => {
    for (const c of changes) await tx`update email_events set reply_class = ${c.to}::reply_class where id = ${c.id}`;
  });
  const [{ tz }] = await sql<{ tz: string }[]>`select coalesce((select value #>> '{}' from settings where key = 'stats_timezone'), 'UTC') as tz`;
  const from = new Date(Math.min(...changes.map((c) => +new Date(c.at))) - 86_400_000).toISOString().slice(0, 10);
  const [{ n }] = await sql<{ n: number }[]>`select rollup_daily_stats(${from}::date, ${tz}) as n`;
  console.log(`daily stats rebuilt from ${from}: ${n} rows`);
}
await sql.end();
