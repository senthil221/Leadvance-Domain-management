import type postgres from "postgres";
import { bounceCauseOf } from "../lib/bounces";

// Works out why older bounces happened (new ones get it when they arrive),
// a batch per run, newest first, so the weekly review fills in quickly.
const BATCH = 1000;

export async function fillBounceCauses(sql: postgres.Sql) {
  const rows = await sql<{ id: number; p: unknown }[]>`
    select id, jsonb_build_object('bounce_message', payload->'bounce_message', 'bounce_reason', payload->'bounce_reason',
      'description', payload->'description', 'is_sender_originated_bounce', payload->'is_sender_originated_bounce') as p
    from email_events where kind = 'bounce' and bounce_cause is null
    order by id desc limit ${BATCH}`;
  if (!rows.length) return { classified: 0 };
  await sql`
    update email_events e set bounce_cause = r.cause
    from jsonb_to_recordset(${sql.json(rows.map((r) => ({ id: Number(r.id), cause: bounceCauseOf(r.p) })))}) as r(id bigint, cause text)
    where e.id = r.id`;
  return { classified: rows.length, more: rows.length === BATCH };
}
