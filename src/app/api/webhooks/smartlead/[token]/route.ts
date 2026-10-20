import { timingSafeEqual } from "node:crypto";
import { sql } from "@/lib/db";
import { ingestEvent } from "@/lib/ingest";
import { parseSmartleadEvent } from "@/lib/smartlead-events";

// Smartlead webhook: point EMAIL_SENT, EMAIL_REPLY and EMAIL_BOUNCE here as
// https://<app>/api/webhooks/smartlead/<SMARTLEAD_WEBHOOK_TOKEN>.
// Answers fast and always 200 for events we accept or ignore, so Smartlead
// doesn't retry them; only a bad token or a database failure fails.

function tokenOk(given: string) {
  const expected = process.env.SMARTLEAD_WEBHOOK_TOKEN ?? "";
  if (!expected || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export async function POST(request: Request, ctx: RouteContext<"/api/webhooks/smartlead/[token]">) {
  const { token } = await ctx.params;
  if (!tokenOk(token)) return new Response("Not found", { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "body is not JSON" }, { status: 400 });
  }

  const items = Array.isArray(body) ? body : [body];
  let stored = 0, duplicate = 0, ignored = 0;
  try {
    for (const item of items.slice(0, 500)) {
      const event = parseSmartleadEvent(item);
      if (!event) { ignored++; continue; }
      if (await ingestEvent(sql, event, item)) stored++;
      else duplicate++;
    }
  } catch (e) {
    console.error("smartlead webhook failed", e);
    // 500 makes Smartlead retry later, which is what we want here.
    return Response.json({ ok: false }, { status: 500 });
  }
  return Response.json({ ok: true, stored, duplicate, ignored });
}
