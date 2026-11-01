import { jobSql as sql } from "@/lib/db";

// Icemail webhook: each workspace added in Settings has its own address,
// https://<app>/api/webhooks/icemail/<token>, pasted into Icemail under
// Settings → Notification → Add Webhook URL. Icemail doesn't sign deliveries,
// so the token is the only proof. Each event is stored (app passwords
// removed) and the Icemail sync is brought forward so the worker picks the
// change up within a minute. The plain (job) connection keeps the JSON keys
// exactly as Icemail sent them.

/** The delivery without any app password, however deep. */
function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>)
      .filter(([k]) => !/password/i.test(k))
      .map(([k, x]) => [k, scrub(x)]));
  }
  return v;
}

export async function POST(request: Request, ctx: RouteContext<"/api/webhooks/icemail/[token]">) {
  const { token } = await ctx.params;
  if (!/^[a-f0-9]{32,}$/.test(token)) return new Response("Not found", { status: 404 });
  const [account] = await sql`select id from icemail_accounts where webhook_token = ${token}`;
  if (!account) return new Response("Not found", { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "body is not JSON" }, { status: 400 });
  }
  const o = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const event = typeof o.event === "string" ? o.event.slice(0, 100) : "unknown";
  const workspace = typeof o.workspace_id === "string" ? o.workspace_id.slice(0, 100) : null;

  try {
    await sql`insert into icemail_events (account_id, event, workspace_id, payload)
      values (${account.id}, ${event}, ${workspace}, ${sql.json(scrub(body) as never)})`;
    await sql`update job_state set last_started_at = null where job = 'icemail'`;
  } catch (e) {
    console.error("icemail webhook failed", e);
    // 500 makes Icemail retry later.
    return Response.json({ ok: false }, { status: 500 });
  }
  console.log(`icemail webhook: ${event}`);
  return Response.json({ ok: true });
}
