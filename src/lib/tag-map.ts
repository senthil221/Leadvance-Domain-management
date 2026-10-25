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
