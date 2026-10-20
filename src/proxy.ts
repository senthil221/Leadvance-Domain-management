import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Refreshes the Supabase session cookie and sends signed-out visitors to
// /login. Pages still check the user themselves; this is the fast path.
export async function proxy(request: NextRequest) {
  if (process.env.NODE_ENV !== "production" && process.env.DEV_AUTH_EMAIL) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });
  const { data } = await supabase.auth.getUser();
  if (!data.user && request.nextUrl.pathname !== "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = request.nextUrl.pathname === "/" ? "" : `?next=${encodeURIComponent(request.nextUrl.pathname + request.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  // Everything except static files, the webhook and the health check.
  matcher: ["/((?!_next/|api/webhooks/|api/health|favicon.ico|.*\.(?:svg|png|jpg|ico|webp)$).*)"],
};
