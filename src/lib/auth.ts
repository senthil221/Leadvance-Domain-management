import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";

export type User = { id: string; email: string };

// Local development can skip login by setting DEV_AUTH_EMAIL. It never
// applies to a production build.
const devEmail = process.env.NODE_ENV !== "production" ? process.env.DEV_AUTH_EMAIL : undefined;

export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Called from a Server Component, where cookies are read-only; the
          // proxy refreshes the session on the next request instead.
        }
      },
    },
  });
}

// The signed-in user, or a redirect to /login. Reads the request, so callers
// must sit inside a Suspense boundary.
export async function getCurrentUser(): Promise<User> {
  // Supabase reads the clock while loading the session, which prerendering forbids.
  await connection();
  if (devEmail) return { id: "dev", email: devEmail };
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user?.email) redirect("/login");
  return { id: data.user.id, email: data.user.email };
}

// For server actions: same check, returns the actor name used in audit rows.
export async function requireActor(): Promise<string> {
  return (await getCurrentUser()).email;
}
