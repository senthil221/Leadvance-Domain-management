/**
 * Marks a person can put on domains and inboxes. They go to Smartlead as inbox
 * tags (to filter and act on there), and are labels, never a client's tag.
 */
export const MARK_CHOICES = ["Replaced", "Low reputation", "Disconnected", "Cancelled", "Replace", "Watch"] as const;
export type Mark = (typeof MARK_CHOICES)[number];
/** Every mark the app uses (New is set by the replacement flow). Lower case. */
export const MARK_TAGS = ["new", "replaced", "low reputation", "disconnected", "cancelled", "replace", "watch"];
/** The mark spelled as the app spells it, for a tag typed in any case; null when it isn't one. */
export const markOf = (t: string): Mark | null => MARK_CHOICES.find((m) => m.toLowerCase() === normTag(t)) ?? null;
export const isMark = (t: string) => MARK_TAGS.includes(normTag(t));

/** A tag as stored in the map: lower case, one space between words. */
export const normTag = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Reads "tag, client" pairs, one per line, in whatever shape they were pasted:
 * quotes and trailing commas are ignored, and a tab, semicolon or arrow works
 * as well as a comma. Lines that don't hold exactly two parts come back in `bad`.
 */
export function parseTagPairs(text: string) {
  const pairs: { tag: string; client: string }[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/["“”]/g, "").trim().replace(/[,;\s]+$/, "");
    if (!line) continue;
    const parts = line.split(/\s*(?:,|;|\t|->|=>|→)\s*/).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 2) pairs.push({ tag: parts[0], client: parts[1] });
    else bad.push(raw.trim());
  }
  return { pairs, bad };
}

/**
 * A server's saved tag to client list (settings key client_tag_list): for an
 * account where inboxes are tagged with a person's name and several tags belong
 * to one client. Settings → Client assignment → "Use the saved list" applies it.
 */
export function parseSavedPairs(v: unknown): { tag: string; client: string }[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    return typeof o.tag === "string" && typeof o.client === "string" && o.tag.trim() && o.client.trim() ? [{ tag: o.tag.trim(), client: o.client.trim() }] : [];
  });
}
