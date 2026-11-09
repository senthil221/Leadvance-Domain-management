import { connection } from "next/server";
import { sheetTokenOk } from "@/lib/sheet-token";
import { lastUntrackedSync, listUntrackedReplies } from "@/lib/untracked-replies-db";

// Read-only feed for the account managers' untracked replies sheet: every reply
// still waiting in Smartlead's untracked list, newest first. The sheet's script
// (deploy/google-sheet/untracked-replies.gs) calls
// https://<app>/api/sheet/<SHEET_SYNC_TOKEN>/untracked and rewrites the sheet.

export async function GET(_request: Request, ctx: RouteContext<"/api/sheet/[token]/untracked">) {
  await connection();
  const { token } = await ctx.params;
  if (!sheetTokenOk(token)) return new Response("Not found", { status: 404 });
  try {
    const [rows, sync] = await Promise.all([listUntrackedReplies(), lastUntrackedSync()]);
    return Response.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      lastSyncAt: sync?.finishedAt ?? null,
      lastSyncOk: sync?.ok ?? null,
      // Keys are the sheet's column headers (the n8n flow's), plus client, domain and received.
      rows: rows.map((r) => ({
        id: r.id,
        account_id: r.accountId,
        sender_name: r.senderName,
        sender_email: r.senderEmail,
        recipient_email: r.recipientEmail,
        "recipient name": r.recipientName,
        subject: r.subject,
        body: r.body,
        date: r.receivedAt ? new Date(r.receivedAt).toISOString().slice(0, 10) : null,
        received: r.receivedAt ? new Date(r.receivedAt).toISOString() : null,
        client: r.client,
        domain: r.domain,
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("untracked replies feed failed", e);
    return Response.json({ ok: false }, { status: 500 });
  }
}
