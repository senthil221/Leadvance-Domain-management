// Placement tests (client-safe): the rules for a test batch. Which inboxes
// send, which seeds each campaign gets, what a seed is called in the email, and
// what the auto-replies say about a domain. The job is src/jobs/placement-tests.ts.

/** Every test campaign's name starts with this, so the campaign sync leaves them out of the app's campaigns. */
export const PLACEMENT_PREFIX = "Placement · ";

export const DEFAULTS = { seedsPerCampaign: 10, inboxesPerDomain: 3 };
/** Hours after a campaign's last email before its auto-replies are counted as final. */
export const WAIT_HOURS = 48;
/** A campaign still not fully sent this long after it started is closed anyway. */
export const GIVE_UP_HOURS = 96;
/** The most test emails one seed gets in 7 days, from all domains. */
export const SEED_PER_WEEK = 3;
/** A seed isn't emailed by the same domain again for this long. */
export const SAME_DOMAIN_DAYS = 30;

export const NEUTRAL = {
  subject: "Lunch on Thursday?",
  body: "Hi {{first_name}},\n\nAre you free for lunch on Thursday? There's a new place near your office I've been wanting to try.\n\nLet me know!",
};

export type Variant = "sales" | "neutral";

/** Plain text becomes simple HTML (Smartlead sends the body as HTML); HTML is kept as it is. */
export function bodyHtml(body: string) {
  if (/<(?:p|div|br|span|a|b|strong|i|em|ul|ol|li|table)\b/i.test(body)) return body;
  return body.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "<br>");
}

/** {{variables}} in a copy that a seed has no value for: they'd go out empty. */
export function unknownVariables(text: string) {
  const known = new Set(["first_name", "last_name", "company_name", "email"]);
  const found = [...text.matchAll(/\{\{\s*([\w.]+)\s*(?:\|[^}]*)?\}\}/g)].map((m) => m[1].toLowerCase());
  return [...new Set(found.filter((v) => !known.has(v)))];
}

const GENERIC = new Set(["info", "ops", "admin", "sales", "support", "hello", "contact", "office", "team", "hr", "accounts", "accounting",
  "billing", "finance", "marketing", "careers", "jobs", "help", "service", "enquiries", "inquiries", "mail", "noreply", "former", "archive"]);
const cap = (w: string) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w);

/** What the email calls a seed: the name on its auto-reply, else a name read from the address, else "there". */
export function leadFor(seed: { email: string; name: string | null }) {
  const [local, domain = ""] = seed.email.split("@");
  let first = "", last = "";
  const fromName = (seed.name ?? "").replace(/["']/g, "").trim().split(/\s+/).filter((w) => /^[a-z][a-z-]+$/i.test(w));
  if (fromName.length && !GENERIC.has(fromName[0].toLowerCase())) {
    first = cap(fromName[0]);
    last = fromName.length > 1 ? cap(fromName[fromName.length - 1]) : "";
  } else {
    const parts = local.split("+")[0].split(/[._-]/).filter(Boolean);
    if (parts.length && /^[a-z]{2,}$/i.test(parts[0]) && !GENERIC.has(parts[0].toLowerCase())) {
      first = cap(parts[0]);
      if (parts.length > 1 && /^[a-z]{2,}$/i.test(parts[parts.length - 1])) last = cap(parts[parts.length - 1]);
    }
  }
  const company = domain.split(".")[0].split("-").map(cap).join(" ");
  return { email: seed.email, first_name: first || "there", last_name: last, company_name: company };
}

export type InboxChoice = { accountId: number; email: string; senderName: string | null; reputation: number | null };

/** The inboxes that send a domain's test: its usual sender name first, then the best warm-up reputation. */
export function pickInboxes(inboxes: InboxChoice[], n: number): InboxChoice[] {
  const names = new Map<string, number>();
  for (const i of inboxes) if (i.senderName) names.set(i.senderName, (names.get(i.senderName) ?? 0) + 1);
  const usual = [...names].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return [...inboxes]
    .sort((a, b) => Number(b.senderName === usual) - Number(a.senderName === usual) || (b.reputation ?? 0) - (a.reputation ?? 0) || a.email.localeCompare(b.email))
    .slice(0, n);
}

export type SeedChoice = { email: string; domain: string; name: string | null; lastReplyAt: string };
export type SeedUse = { email: string; domainId: string; sentAt: string };
export type SeedWant = { key: string; domainId: string; count: number };

/**
 * Seeds for each campaign of a batch. A seed is never emailed twice by the same
 * domain within SAME_DOMAIN_DAYS (so not by both of its campaigns either), never
 * more than SEED_PER_WEEK times in 7 days counting this batch, and one campaign
 * gets each company once. The least used seeds go first, then the freshest; the
 * campaigns take turns so each gets a fair share when seeds run short.
 */
export function pickSeeds(seeds: SeedChoice[], history: SeedUse[], wants: SeedWant[], now: number) {
  const week = now - 7 * 86_400_000;
  const domainWindow = now - SAME_DOMAIN_DAYS * 86_400_000;
  const uses = new Map<string, number>();
  const byDomain = new Set<string>();
  for (const h of history) {
    const t = new Date(h.sentAt).getTime();
    if (t >= week) uses.set(h.email, (uses.get(h.email) ?? 0) + 1);
    if (t >= domainWindow) byDomain.add(`${h.email}|${h.domainId}`);
  }
  const picks = new Map<string, SeedChoice[]>(wants.map((w) => [w.key, []]));
  const companies = new Map<string, Set<string>>(wants.map((w) => [w.key, new Set()]));
  const order = () => [...seeds].sort((a, b) => (uses.get(a.email) ?? 0) - (uses.get(b.email) ?? 0) || b.lastReplyAt.localeCompare(a.lastReplyAt) || a.email.localeCompare(b.email));
  let sorted = order();
  for (let round = 0, progress = true; progress; round++) {
    progress = false;
    for (const w of wants) {
      const got = picks.get(w.key)!;
      if (got.length >= w.count) continue;
      const seen = companies.get(w.key)!;
      const s = sorted.find((x) => (uses.get(x.email) ?? 0) < SEED_PER_WEEK && !byDomain.has(`${x.email}|${w.domainId}`) && !seen.has(x.domain));
      if (!s) continue;
      got.push(s);
      seen.add(s.domain);
      byDomain.add(`${s.email}|${w.domainId}`);
      uses.set(s.email, (uses.get(s.email) ?? 0) + 1);
      sorted = order();
      progress = true;
    }
  }
  const short = wants.filter((w) => picks.get(w.key)!.length < w.count).map((w) => ({ key: w.key, missing: w.count - picks.get(w.key)!.length }));
  return { picks, short };
}

export type Tally = { total: number; sent: number; replied: number; bounced: number };
export const emptyTally = (): Tally => ({ total: 0, sent: 0, replied: 0, bounced: 0 });
/** Auto-replies out of the emails that were delivered (a bounce says nothing about the inbox). */
export const rate = (t: Tally) => (t.sent - t.bounced > 0 ? t.replied / (t.sent - t.bounced) : null);

/** Fewest delivered emails a campaign needs before it is judged. */
export const MIN_DELIVERED = 5;
/** The control must land at least this often, or the batch can't be read. */
export const CONTROL_MIN = 0.4;
/** A domain lands when its auto-reply rate is at least this share of the control's. */
export const LAND_SHARE = 0.6;

export type Verdict = "control" | "waiting" | "lands" | "copy" | "burned" | "mixed" | "too_few" | "control_failed";

export const VERDICT_META: Record<Verdict, { label: string; tone: "success" | "danger" | "warning" | "info" | "faint"; hint: string }> = {
  control: { label: "Control", tone: "faint", hint: "Known to land: the others are measured against it" },
  waiting: { label: "Waiting", tone: "info", hint: `Auto-replies are counted ${WAIT_HOURS} hours after the last email` },
  lands: { label: "Lands", tone: "success", hint: "Both the real copy and the neutral note got auto-replies like the control's: it reaches the inbox" },
  copy: { label: "Copy problem", tone: "warning", hint: "The neutral note reaches the inbox but the real copy doesn't: change the copy, keep the domain" },
  burned: { label: "Burned", tone: "danger", hint: "Even the neutral note goes to spam: the domain itself is the problem. Replace it" },
  mixed: { label: "Unclear", tone: "faint", hint: "The real copy landed but the neutral note didn't. Too few seeds or chance: test again" },
  too_few: { label: "Too few sent", tone: "faint", hint: `Fewer than ${MIN_DELIVERED} emails were delivered in a campaign, which is too few to judge` },
  control_failed: { label: "Control didn't land", tone: "warning", hint: `The control got auto-replies from under ${Math.round(CONTROL_MIN * 100)}% of seeds, so this batch can't be read. Check the copy's settings (links, tracking, unsubscribe) and test again` },
};

/** What a tested domain's auto-replies say, next to its control's. */
export function placementVerdict(
  test: { sales: Tally; neutral: Tally },
  control: { sales: Tally; neutral: Tally } | null,
  closed: boolean,
): Verdict {
  if (!control) return "control";
  if (!closed) return "waiting";
  const delivered = (t: Tally) => t.sent - t.bounced;
  if ([test.sales, test.neutral, control.sales, control.neutral].some((t) => delivered(t) < MIN_DELIVERED)) return "too_few";
  const cs = rate(control.sales)!, cn = rate(control.neutral)!;
  if (cs < CONTROL_MIN || cn < CONTROL_MIN) return "control_failed";
  const sales = rate(test.sales)! >= LAND_SHARE * cs;
  const neutral = rate(test.neutral)! >= LAND_SHARE * cn;
  return sales && neutral ? "lands" : neutral ? "copy" : sales ? "mixed" : "burned";
}

/** Smartlead's per-lead statistics row, read loosely. */
export function parseStatRow(raw: unknown): { email: string; sentAt: string | null; repliedAt: string | null; bounced: boolean } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const email = typeof o.lead_email === "string" ? o.lead_email.trim().toLowerCase() : null;
  if (!email) return null;
  const time = (v: unknown) => {
    if (v == null || v === "") return null;
    const d = new Date(v as string);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  return { email, sentAt: time(o.sent_time), repliedAt: time(o.reply_time), bounced: o.is_bounced === true || o.is_bounced === "true" };
}

/** Next Saturday 09:00 in a timezone, as an ISO time (today's if it's Saturday before 9). */
export function nextSaturday(tz: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const hour = Number(get("hour")) % 24;
  const add = dow === 6 && hour < 9 ? 0 : (6 - dow + 7) % 7 || 7;
  // 09:00 local on that day: start from UTC midnight of the local date, then correct by the zone's offset.
  const local = Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")) + add, 9);
  const offset = zoneOffsetMs(tz, new Date(local));
  return new Date(local - offset).toISOString();
}

function zoneOffsetMs(tz: string, at: Date) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(at);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second")) - at.getTime();
}
