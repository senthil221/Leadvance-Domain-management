// Reads a nameserver sheet pasted from Excel or Google Sheets (Hypertide sends
// one per batch): a domain, then its nameservers, one domain a line. Columns
// can be split by tabs, commas, semicolons or spaces; a header line is skipped.

export type PastedNs = { domain: string; nameservers: string[] };
export type PasteProblem = { line: number; text: string; why: string };

const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const clean = (s: string) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^mailto:/, "").replace(/[/.]+$/, "");

export function parseNameserverSheet(text: string): { rows: PastedNs[]; problems: PasteProblem[] } {
  const rows = new Map<string, PastedNs>();
  const problems: PasteProblem[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const cells = raw.split(/[\t,;|]+|\s+/).map(clean).filter(Boolean);
    if (!cells.length) return;
    const [first, ...rest] = cells;
    // A header ("Domain", "Required Nameserver 1"): nothing that looks like a host.
    if (!cells.some((c) => HOST.test(c))) return;
    if (!HOST.test(first)) { problems.push({ line: i + 1, text: raw.trim(), why: "Doesn't start with a domain" }); return; }
    const ns = [...new Set(rest.filter((c) => HOST.test(c)))];
    if (ns.length < 2) { problems.push({ line: i + 1, text: raw.trim(), why: ns.length ? "Only one nameserver" : "No nameservers" }); return; }
    if (ns.length > 13) { problems.push({ line: i + 1, text: raw.trim(), why: "More than 13 nameservers" }); return; }
    if (ns.includes(first)) { problems.push({ line: i + 1, text: raw.trim(), why: "The domain is listed as its own nameserver" }); return; }
    // The last line for a domain wins.
    rows.delete(first);
    rows.set(first, { domain: first, nameservers: ns });
  });
  return { rows: [...rows.values()], problems };
}
