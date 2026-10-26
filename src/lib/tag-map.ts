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
 * The tag to client list for the second Smartlead account, where inboxes are
 * tagged with a person's name and several tags belong to one client. Settings →
 * Client assignment → "Use the built-in list" saves it and applies it.
 */
export const BUILT_IN_TAG_PAIRS: { tag: string; client: string }[] = [
  { tag: "Frederick Ungureit", client: "WiBotic" },
  { tag: "Prateek Batra", client: "Beebee" },
  { tag: "Raghav Bansal", client: "Beebee" },
  { tag: "Olivia Bennett", client: "Toriut" },
  { tag: "Steve Kloosterman", client: "Westshore" },
  { tag: "George Vellios", client: "Straxo" },
  { tag: "Shawn Hooper", client: "Salesdraft" },
  { tag: "Neil Cornelius", client: "B2bdrive" },
  { tag: "Gene Nguyen", client: "Mvinix" },
  { tag: "Braden Mineer", client: "Bridge Hiring" },
  // Qualifi has the most tags; the spellings of Edward DeAngelis count as one.
  { tag: "Amelia Wren", client: "Qualifi" },
  { tag: "Sophia Lark", client: "Qualifi" },
  { tag: "Edward DeAngelis", client: "Qualifi" },
  { tag: "Eddie Deangelis", client: "Qualifi" },
  { tag: "Isabella Cove", client: "Qualifi" },
  { tag: "Michael Reynolds", client: "Qualifi" },
  { tag: "Gia DeAngelis", client: "Qualifi" },
  { tag: "Emma Soleil", client: "Qualifi" },
];
