import { timingSafeEqual } from "node:crypto";
import { connection } from "next/server";
import { sql } from "@/lib/db";
import { sheetFeed } from "@/lib/sheet-capacity";

// Read-only feed for the campaign volume Google Sheet: one row per client and
// tag with the inbox count and the daily limit per inbox, active domains only.
// The sheet's script calls https://<app>/api/sheet/<SHEET_SYNC_TOKEN> every hour.

function tokenOk(given: string) {
  const expected = process.env.SHEET_SYNC_TOKEN ?? "";
  if (expected.length < 16 || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export async function GET(_request: Request, ctx: RouteContext<"/api/sheet/[token]">) {
  await connection();
  const { token } = await ctx.params;
  if (!tokenOk(token)) return new Response("Not found", { status: 404 });
  try {
    const feed = await sheetFeed(sql);
    return Response.json({ ok: true, generatedAt: new Date().toISOString(), ...feed }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("sheet capacity failed", e);
    return Response.json({ ok: false }, { status: 500 });
  }
}
