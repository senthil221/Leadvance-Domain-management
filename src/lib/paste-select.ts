// Paste to select: a list of domains or email addresses, one per line or
// separated by commas, spaces or semicolons, matched to the domains on a page.
// An address counts as its domain. Shared by server and client.

const DOMAIN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.[a-z]{2,63}$/;

/** The domain a pasted token stands for: lowercased, without a scheme, path, mailbox or stray punctuation. */
export function pastedDomain(token: string): string {
  let t = token.trim().toLowerCase().replace(/^["'<(\[]+|["'>)\],.;:]+$/g, "");
  t = t.replace(/^[a-z]+:\/\//, "");
  if (t.includes("@")) t = t.slice(t.lastIndexOf("@") + 1);
  t = t.split(/[/?#]/)[0].replace(/^www\./, "").replace(/\.+$/, "");
  return t;
}

export type PasteMatch<T> = { matched: T[]; notFound: string[]; invalid: string[]; tokens: number };

/** Each distinct pasted domain, matched to the rows by name. */
export function matchPasted<T extends { name: string }>(text: string, rows: readonly T[]): PasteMatch<T> {
  const by = new Map(rows.map((r) => [r.name.toLowerCase(), r]));
  const seen = new Set<string>();
  const out: PasteMatch<T> = { matched: [], notFound: [], invalid: [], tokens: 0 };
  for (const raw of text.split(/[\s,;|]+/)) {
    if (!raw.trim()) continue;
    const d = pastedDomain(raw);
    if (!d || seen.has(d)) continue;
    seen.add(d);
    out.tokens++;
    const row = by.get(d);
    if (row) out.matched.push(row);
    else if (DOMAIN.test(d)) out.notFound.push(d);
    else out.invalid.push(raw.trim());
  }
  return out;
}
