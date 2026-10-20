import { connection } from "next/server";
import { sql } from "@/lib/db";

// For Docker and uptime checks: is the app up and can it reach Postgres?
export async function GET() {
  await connection();
  try {
    await sql`select 1`;
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false, error: "database unreachable" }, { status: 503 });
  }
}
