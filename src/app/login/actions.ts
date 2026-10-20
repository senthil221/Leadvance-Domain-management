"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { supabaseServer } from "@/lib/auth";

const input = z.object({ email: z.email("Enter a valid email"), password: z.string().min(1, "Enter your password") });

export async function signIn(_prev: string | null, form: FormData): Promise<string | null> {
  const parsed = input.safeParse({ email: form.get("email"), password: form.get("password") });
  if (!parsed.success) return parsed.error.issues[0].message;
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return error.status === 400 ? "Wrong email or password" : "Sign-in is unavailable right now. Try again shortly.";
  const next = String(form.get("next") ?? "/");
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export async function signOut() {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  redirect("/login");
}
