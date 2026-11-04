import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { DiagnosisError, runDiagnosis } from "@/lib/diagnose-ai";

// A route, not a server action: an answer can take a minute, and the browser runs
// actions one at a time, so an action would hold up everything else on the page.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let actor: string;
  try {
    actor = await requireActor();
  } catch {
    return NextResponse.json({ ok: false, error: "Sign in again to do this." }, { status: 401 });
  }
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return NextResponse.json({ ok: false, error: "That isn't a domain." }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, ...(await runDiagnosis(id.data, actor)) });
  } catch (e) {
    if (e instanceof DiagnosisError) return NextResponse.json({ ok: false, error: e.message }, { status: 422 });
    console.error(e);
    return NextResponse.json({ ok: false, error: "Something went wrong. Nothing was saved." }, { status: 500 });
  }
}
