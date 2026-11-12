/**
 * Where to go after signing in: a path on this site, never another site.
 * Browsers read "/\evil.com" (and tabs or newlines inside it) as
 * "//evil.com", so the path is resolved the way a browser would and kept only
 * if it stays on this origin.
 */
export function samePagePath(next: string) {
  const base = "http://this.site";
  try {
    const url = new URL(next, base);
    return next.startsWith("/") && url.origin === base ? url.pathname + url.search + url.hash : "/";
  } catch {
    return "/";
  }
}
