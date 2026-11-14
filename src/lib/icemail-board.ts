import type { ReplaceCall } from "./replace-list";
import type { Tone } from "./status";

// The Icemail page's rules, shared by server and client: what to do with each
// Icemail domain, when to cancel it by, and the inboxes a new order creates.
//
// Icemail can't replace a domain and keeps a 30-day non-replacement policy, so
// "replace" means cancelling the domain's inboxes before they renew and
// ordering new ones on another domain. Cancelling deletes every inbox on the
// domain at its next billing date (Icemail's scheduled deletion): the inboxes
// keep sending until then and nothing renews.

/** Icemail's ClouDNS nameservers: an imported domain must point at them first. */
export const ICEMAIL_NAMESERVERS = ["pns71.cloudns.net", "pns72.cloudns.com", "pns73.cloudns.net", "pns74.cloudns.uk"];

/** Days before the next billing date the page says to have cancelled by. */
export const CANCEL_LEAD_DAYS = 2;
/** Inboxes this young are still being set up and warmed: they aren't judged. */
export const SETUP_DAYS = 14;
/** Most inboxes on one domain in one order. */
export const MAX_PER_DOMAIN = 10;

export type IcemailVerdict = "replace" | "cancel" | "keep" | "new" | "cancelling" | "free";
export const VERDICT_META: Record<IcemailVerdict, { label: string; tone: "danger" | "warning" | "success" | "info" | "faint" | "violet"; hint: string }> = {
  replace: { label: "Replace", tone: "danger", hint: "Its numbers say it's hurting: cancel it before it renews and order the same inboxes on a free domain" },
  cancel: { label: "Cancel", tone: "warning", hint: "Paying for inboxes that don't send: cancel before it renews" },
  keep: { label: "Keep", tone: "success", hint: "Nothing against it" },
  new: { label: "Setting up", tone: "info", hint: `Inboxes under ${SETUP_DAYS} days old: not judged yet` },
  cancelling: { label: "Cancelling", tone: "faint", hint: "Icemail deletes its inboxes on their next billing date" },
  free: { label: "Free", tone: "violet", hint: "Connected to Icemail with no inboxes: ready for a new order" },
};

export type DomainFacts = {
  /** Live Icemail inboxes on it. */ mailboxes: number;
  /** Days since its oldest live inbox was created. */ ageDays: number | null;
  /** Its status in Domain Engine, when it's in the inventory. */ status: string | null;
  /** The Replace list's call, and why. */ call: ReplaceCall | "keep" | "early" | null; reasons: string[];
  blacklisted: boolean | null;
  /** What Icemail reports wrong with the domain: DNS records missing, not active. */ issue: string | null;
  /** Its inboxes connected in Smartlead, and what they sent in 7 days. */ connected: number; sent7: number;
  daysSinceSent: number | null;
  /** A cancel asked for and not undone. */ cancelling: boolean;
};

export type Verdict = { verdict: IcemailVerdict; reasons: string[] };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function verdictOf(f: DomainFacts): Verdict {
  if (f.cancelling) return { verdict: "cancelling", reasons: [] };
  if (!f.mailboxes) return { verdict: "free", reasons: [] };
  if (f.blacklisted) return { verdict: "replace", reasons: ["Icemail lists it as blacklisted"] };
  if (f.call === "replace_now" || f.call === "replace") return { verdict: "replace", reasons: f.reasons.length ? f.reasons : ["On the Replace list"] };
  if (f.status && ["draining", "burned", "resting"].includes(f.status)) {
    return { verdict: "cancel", reasons: [`${f.status === "draining" ? "Replaced" : f.status === "burned" ? "Burned" : "Resting"} in Domain Engine, but its ${plural(f.mailboxes, "inbox", "inboxes")} still bill`] };
  }
  const young = f.ageDays != null && f.ageDays < SETUP_DAYS;
  if (!f.connected) {
    return young
      ? { verdict: "new", reasons: ["Not connected in Smartlead yet"] }
      : { verdict: "cancel", reasons: [`None of its ${plural(f.mailboxes, "inbox", "inboxes")} is connected in Smartlead: they bill and can't send`] };
  }
  if (young) return { verdict: "new", reasons: f.issue ? [`Icemail: ${f.issue}`] : [] };
  const notes: string[] = [];
  if (f.call === "watch") notes.push(...(f.reasons.length ? f.reasons : ["On watch: worse than the others it sends with"]));
  if (f.call === "fix") notes.push("Its setup is failing: fix that before deciding (Fix queue)");
  if (f.call === "list") notes.push("Its bounces are addresses that don't exist: re-verify the list, the domain is fine");
  if (f.issue) notes.push(`Icemail: ${f.issue}`);
  if (!f.sent7 && f.daysSinceSent != null && f.daysSinceSent >= 14) notes.push(`Connected but hasn't sent in ${f.daysSinceSent} days: cancel if no campaign needs it`);
  else if (!f.sent7 && f.daysSinceSent == null) notes.push("Connected but hasn't sent anything yet");
  return { verdict: "keep", reasons: notes };
}

/** The day to have cancelled by: two days before it bills, never before today. Null without a billing date. */
export function cancelBy(nextBill: Date | string | null, today = new Date()): { by: string; daysLeft: number } | null {
  if (!nextBill) return null;
  const bill = new Date(`${new Date(nextBill).toISOString().slice(0, 10)}T00:00:00Z`);
  const by = new Date(bill.getTime() - CANCEL_LEAD_DAYS * 86_400_000);
  const start = new Date(`${today.toISOString().slice(0, 10)}T00:00:00Z`);
  return { by: by.toISOString().slice(0, 10), daysLeft: Math.round((by.getTime() - start.getTime()) / 86_400_000) };
}

// ---------------------------------------------------------------------------
// New inboxes
// ---------------------------------------------------------------------------

export type Person = { first: string; last: string };
export type NewMailbox = { first_name: string; last_name: string; username: string };

/**
 * The ways an address is made from a name. Each ticked style is one inbox on
 * every domain, all with the same full name: Sendil Nathan gets sendil@,
 * sendil.nathan@ and sendil.n@.
 */
export const ADDRESS_STYLES = {
  first: { label: "first", make: (p: Person) => p.first },
  "first.last": { label: "first.last", make: (p: Person) => `${p.first}.${p.last}` },
  "first.l": { label: "first.l", make: (p: Person) => `${p.first}.${p.last[0] ?? ""}` },
  firstlast: { label: "firstlast", make: (p: Person) => `${p.first}${p.last}` },
  flast: { label: "flast", make: (p: Person) => `${p.first[0] ?? ""}${p.last}` },
  "f.last": { label: "f.last", make: (p: Person) => `${p.first[0] ?? ""}.${p.last}` },
} as const;
export type AddressStyle = keyof typeof ADDRESS_STYLES;
export const STYLE_ORDER = Object.keys(ADDRESS_STYLES) as AddressStyle[];
export const DEFAULT_STYLES: AddressStyle[] = ["first", "first.last", "first.l"];
export const isAddressStyle = (v: string): v is AddressStyle => v in ADDRESS_STYLES;
/** What one style makes of a name, for showing it: "sendil.n". */
export const styleExample = (style: AddressStyle, p: Person) => ADDRESS_STYLES[style].make({ first: slug(p.first), last: slug(p.last) });

/** Letters only, no accents: what goes before the @. */
const slug = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
const proper = (s: string) => s.trim().replace(/\s+/g, " ").slice(0, 40);

/** One person a line, "First Last" (or "First, Last"). Lines without both are reported. */
export function readPeople(text: string): { people: Person[]; bad: string[] } {
  const people: Person[] = [], bad: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.includes(",") ? line.split(",").map((x) => x.trim()) : [line.split(/\s+/)[0], line.split(/\s+/).slice(1).join(" ")];
    const [first, last] = [proper(parts[0] ?? ""), proper(parts.slice(1).join(" "))];
    if (!slug(first) || !slug(last)) { bad.push(line); continue; }
    const key = `${slug(first)} ${slug(last)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    people.push({ first, last });
  }
  return { people, bad };
}

/**
 * The inboxes for each domain: every name once per style, in the order the
 * styles are listed, and the same on every domain, so a sender keeps one full
 * name everywhere and only the address changes. An address that would repeat
 * on a domain (two Johns, say) takes the next unused style, then a number.
 */
export function planMailboxes({ domains, people, styles }: { domains: string[]; people: Person[]; styles: AddressStyle[] }):
  { plan: { domain: string; mailboxes: NewMailbox[] }[] } | { error: string } {
  if (!domains.length) return { error: "Pick at least one domain" };
  if (!people.length) return { error: "Add a name for the inboxes" };
  const picked = STYLE_ORDER.filter((s) => styles.includes(s));
  if (!picked.length) return { error: "Tick at least one address style" };
  const perDomain = people.length * picked.length;
  if (perDomain > MAX_PER_DOMAIN) return { error: `That's ${plural(perDomain, "inbox", "inboxes")} a domain (${plural(people.length, "name")} × ${plural(picked.length, "style")}); up to ${MAX_PER_DOMAIN}: use fewer names or styles` };
  const plan = domains.map((domain) => {
    const used = new Set<string>();
    const mailboxes: NewMailbox[] = [];
    for (const p of people) {
      const sp = { first: slug(p.first), last: slug(p.last) };
      for (const style of picked) {
        let local = ADDRESS_STYLES[style].make(sp);
        if (used.has(local)) local = STYLE_ORDER.map((s) => ADDRESS_STYLES[s].make(sp)).find((l) => l && !used.has(l)) ?? local;
        for (let i = 2; used.has(local); i++) local = `${ADDRESS_STYLES[style].make(sp)}${i}`;
        used.add(local);
        mailboxes.push({ first_name: p.first, last_name: p.last, username: `${local}@${domain}` });
      }
    }
    return { domain, mailboxes };
  });
  return { plan };
}

/** What an order costs a month: inboxes times the price of one. Null without a price. */
export const monthlyCost = (inboxes: number, price: number | null) => (price == null ? null : Math.round(inboxes * price * 100) / 100);

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export const ITEM_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "Waiting", tone: "faint" },
  nameservers: { label: "Nameservers", tone: "info" },
  ordering: { label: "Ordering…", tone: "info" },
  ordered: { label: "Ordered", tone: "success" },
  dry_run: { label: "Dry run", tone: "violet" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Taken out", tone: "faint" },
};

export type OrderItemFacts = {
  status: string; message: string | null; nsStatus: string | null; mailboxes: number;
  atIcemail: number; activeAtIcemail: number; otherStatus: string | null; inSmartlead: number;
  /** Its latest export to Smartlead through Icemail. */
  exportStatus?: string | null; exportMessage?: string | null; exportTotal?: number | null; exportProcessed?: number | null; exportSucceeded?: number | null;
};

/** Where one domain of an order stands: the worker's status, then setup at Icemail and in Smartlead. */
export function itemStage(i: OrderItemFacts): { label: string; tone: Tone; text: string | null } {
  const base = ITEM_STATUS[i.status] ?? { label: i.status, tone: "faint" as Tone };
  if (i.status === "nameservers" && !i.message) return { ...base, text: `Moving its nameservers to Icemail's ClouDNS${i.nsStatus ? ` (${i.nsStatus})` : ""}` };
  if (i.status !== "ordered") return { ...base, text: i.message };
  const n = i.mailboxes;
  if (i.inSmartlead >= n) return { label: "Live", tone: "success", text: `All ${plural(n, "inbox", "inboxes")} connected in Smartlead` };
  switch (i.exportStatus) {
    case "failed": return { label: "Not exported", tone: "danger", text: i.exportMessage ?? "Icemail's export to Smartlead failed" };
    case "queued": case "sending": return { label: "Exporting", tone: "info", text: i.exportMessage ?? `Asking Icemail to export ${plural(n, "inbox", "inboxes")} to Smartlead` };
    case "exporting": return { label: "Exporting", tone: "info", text: i.exportMessage
      ?? `Icemail is exporting them to Smartlead${i.exportProcessed != null && i.exportTotal ? `: ${i.exportProcessed} of ${i.exportTotal} done` : ""}` };
    case "done": return { label: "Connecting", tone: "info", text: i.exportMessage ?? `Icemail exported ${i.exportSucceeded ?? i.exportTotal ?? n} to Smartlead; they show here after the next Smartlead sync` };
    case "dry_run": return { label: "Dry run", tone: "violet", text: i.exportMessage ?? "Dry run: Icemail wasn't asked to export them" };
  }
  if (i.inSmartlead > 0) return { label: "Connecting", tone: "info", text: `${i.inSmartlead} of ${n} connected in Smartlead` };
  if (i.activeAtIcemail >= n) return { label: "Ready", tone: "success", text: `All ${n} active at Icemail; next they go to Smartlead through Icemail's export` };
  if (i.atIcemail > 0) return { label: "Setting up", tone: "info", text: `${i.activeAtIcemail} of ${n} active at Icemail${i.otherStatus ? `, the rest ${i.otherStatus}` : ""}` };
  return { label: "Ordered", tone: "info", text: "Icemail took the order; the inboxes show here after the next sync, usually within the hour" };
}
