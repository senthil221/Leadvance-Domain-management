import { RULES, type Standing } from "./review";

// Every problem on a live domain in one list, ranked by how much daily volume
// it puts at risk, with the evidence and the next step. Shared by server and client.

export type FixTier = "urgent" | "soon" | "watch";
export const TIER_META: Record<FixTier, { label: string; hint: string }> = {
  urgent: { label: "Fix today", hint: "Mail is failing or about to stop" },
  soon: { label: "This week", hint: "Volume or reputation is slipping" },
  watch: { label: "Keep an eye on", hint: "Nothing's failing yet" },
};
export const TIERS: FixTier[] = ["urgent", "soon", "watch"];

export type FixKind =
  | "sending_after_end" | "dns_down" | "dns_records" | "tenant" | "disconnected" | "expiring" | "grace_ending"
  | "paid_unused" | "blocklisted" | "spam" | "silent" | "low_rep" | "warmup_blocked" | "warmup_off";

/** In the order they're worth reading: the cause before what follows from it. */
export const FIX_META: Record<FixKind, { label: string; hint: string }> = {
  sending_after_end: { label: "Sending with no order", hint: "Still sending although its order has ended, so it can stop without warning" },
  dns_down: { label: "DNS down", hint: "The domain's nameservers don't answer, so mail from it fails" },
  dns_records: { label: "DNS records", hint: "A record is missing, or receivers can't verify the domain" },
  tenant: { label: "Tenant or mailbox", hint: "Receivers blame the Microsoft tenant or the mailbox itself" },
  disconnected: { label: "Disconnected", hint: "Inboxes on a live order are disconnected in Smartlead" },
  expiring: { label: "Expiring", hint: "The registration runs out soon, and auto-renew isn't confirmed on" },
  grace_ending: { label: "Grace ending", hint: "The provider takes these inboxes down soon" },
  paid_unused: { label: "Paid, not connected", hint: "The order is live, but Smartlead has no inboxes for it" },
  blocklisted: { label: "Block list", hint: `On a block list, or ${RULES.restBlocklist}+ bounces in 7 days that name one` },
  spam: { label: "Spam rejections", hint: `${RULES.restSpam}+ spam rejections and ${RULES.restSpamRate}%+ of sent, in 7 days` },
  silent: { label: "No replies at all", hint: `${RULES.silentSent}+ sent in 7 days and not one reply, not even an out of office` },
  low_rep: { label: "Low reputation", hint: `Warm-up reputation under ${RULES.lowRep}` },
  warmup_blocked: { label: "Warm-up blocked", hint: "Smartlead has blocked warm-up on some inboxes" },
  warmup_off: { label: "Warm-up off", hint: "Warm-up is off on some inboxes" },
};
export const FIX_KINDS = Object.keys(FIX_META) as FixKind[];

/** What the database knows about a domain: see FIX_FACTS_SQL. */
export type FixFact = {
  domainId: string; name: string; status: string; standing: Standing | null; current: boolean; orderLive: boolean; orderState: string | null; provider: string | null;
  graceLeft: number | null; clientId: string | null; clientName: string | null; clientHue: number | null;
  connected: number; disconnected: number; capacity: number; lostCapacity: number;
  warmupOff: number; warmupBlocked: number; lowRep: number; rep: number | null;
  sent7: number; replies7: number; daysSent: number; daysSinceSent: number | null;
  bounces7: number; dnsBounces: number; senderBounces: number; blockBounces: number; spamBounces: number;
  nameserversAnswering: boolean | null; dnsSpf: boolean | null; dnsDkim: boolean | null; dnsDmarc: boolean | null; dnsMx: boolean | null;
  listed: number; daysToExpiry: number | null; autoRenew: boolean | null; orderProblem: "missing" | "deleted" | null;
};

export type FixProblem = {
  kind: FixKind; tier: FixTier;
  /** What to call it. The kind's own name, unless one kind covers two different things. */ label: string;
  /** What was seen. */ evidence: string;
  /** What to do. */ next: string;
  /** Emails a day that depend on this being fixed. */ risk: number;
};

export type FixItem = {
  name: string; domainId: string; clientId: string | null; clientName: string | null; clientHue: number | null; provider: string | null;
  problems: FixProblem[]; top: FixProblem; tier: FixTier; /** The most any one problem puts at risk: they're the same mail. */ risk: number;
};

export type FixSnooze = { name: string; kind: FixKind; until: string };

const n = (v: number) => Math.round(v).toLocaleString("en-US");
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

const END_WORDS: Partial<Record<Standing, string>> = {
  cancelled: "The order is cancelled", replaced: "The order moved to another domain", retired: "Marked as retired here",
  expired: "The domain has expired", no_order: "The provider has no order for it",
};

/** Every problem on one domain, worst first. Nothing for a domain that's meant to be going away, unless it's still sending. */
export function problemsOf(f: FixFact): FixProblem[] {
  const out: FixProblem[] = [];
  const add = (kind: FixKind, tier: FixTier, evidence: string, next: string, risk: number, label = FIX_META[kind].label) => out.push({ kind, tier, label, evidence, next, risk: Math.round(risk) });
  const perDay = f.daysSent ? f.sent7 / f.daysSent : 0;
  const volume = perDay || f.capacity;
  const sendingNow = f.connected > 0 && f.sent7 > 0 && f.daysSinceSent != null && f.daysSinceSent <= 2;

  // Winding down: only whether it's still carrying mail matters.
  if (f.standing === "grace") {
    if (sendingNow && f.graceLeft != null && f.graceLeft <= 5) {
      add("grace_ending", f.graceLeft <= 2 ? "urgent" : "soon", `Its inboxes go in ${plural(f.graceLeft, "day")}, and it sent ${n(f.sent7)} in 7 days`, "Check its replacement is in the campaigns before then", perDay);
    }
    return out;
  }
  if (!f.current && !f.orderLive) {
    if (sendingNow && f.standing && END_WORDS[f.standing]) {
      // An order the provider's list has lost isn't proof it ended: their lists leave some out.
      if (f.standing === "no_order") add("sending_after_end", "soon", `${END_WORDS.no_order}, but it sent ${n(f.sent7)} in 7 days`, "Check it with the provider, and move its campaigns if the order is gone", perDay);
      else add("sending_after_end", "urgent", `${END_WORDS[f.standing]}, but it sent ${n(f.sent7)} in 7 days`, "Move its campaigns to another domain before it stops", perDay);
    }
    return out;
  }
  if (f.standing === "expired" && sendingNow) {
    add("sending_after_end", "urgent", `${END_WORDS.expired}, but it sent ${n(f.sent7)} in 7 days`, "Renew it now, or move its campaigns", perDay);
  }

  const inboxes = f.connected + f.disconnected;
  if (f.nameserversAnswering === false && inboxes > 0) {
    add("dns_down", "urgent", "Its nameservers don't answer", "Fix the nameservers at the registrar, then reconnect its inboxes", Math.max(volume, f.lostCapacity));
  }
  // Records only matter once there are inboxes to send from: an unused domain that's never been set up isn't failing.
  const missing = inboxes > 0 ? ([["MX", f.dnsMx], ["SPF", f.dnsSpf], ["DKIM", f.dnsDkim], ["DMARC", f.dnsDmarc]] as const).filter(([, ok]) => ok === false).map(([k]) => k) : [];
  if (f.dnsBounces >= RULES.senderBounces || missing.length) {
    const said = [missing.length ? `${missing.join(", ")} missing` : "", f.dnsBounces >= RULES.senderBounces ? `${plural(f.dnsBounces, "bounce")} in 7 days blame its DNS` : ""].filter(Boolean).join("; ");
    const onlyDmarc = f.dnsBounces < RULES.senderBounces && missing.length === 1 && missing[0] === "DMARC";
    add("dns_records", onlyDmarc ? "watch" : "urgent", said, "Check its records, then re-check DNS here", volume);
  }
  if (f.senderBounces >= RULES.senderBounces) {
    add("tenant", "urgent", `${plural(f.senderBounces, "bounce")} in 7 days blame the tenant or mailbox`, "Check the tenant with the provider before sending more through it", volume);
  }
  if (f.disconnected > 0 && f.orderLive && (f.status === "active" || f.status === "warming")) {
    const all = f.connected === 0;
    add("disconnected", all ? "urgent" : "soon", `${n(f.disconnected)} of ${plural(inboxes, "inbox", "inboxes")} disconnected`, "Reconnect in Smartlead", f.lostCapacity);
  }
  if (f.orderProblem) {
    add("paid_unused", "soon", f.orderProblem === "deleted" ? "The order is live, but every inbox was deleted in Smartlead" : "The order is live, but Smartlead has no inboxes for it", "Connect its inboxes, or cancel the order", 0);
  }
  if (f.daysToExpiry != null && f.daysToExpiry <= 14 && f.autoRenew !== true && !(f.standing === "expired" && sendingNow)) {
    const when = f.daysToExpiry < 0 ? `Expired ${plural(-f.daysToExpiry, "day")} ago` : f.daysToExpiry === 0 ? "Expires today" : `Expires in ${plural(f.daysToExpiry, "day")}`;
    add("expiring", f.daysToExpiry <= 3 ? "urgent" : "soon", `${when}${f.autoRenew === false ? ", auto-renew is off" : ", auto-renew not confirmed"}`, "Renew it at the registrar, or plan its replacement", volume);
  }
  if (f.listed > 0 || f.blockBounces >= RULES.restBlocklist) {
    const said = [f.listed ? `On ${plural(f.listed, "block list")}` : "", f.blockBounces >= RULES.restBlocklist ? `${plural(f.blockBounces, "block list bounce")} in 7 days` : ""].filter(Boolean).join("; ");
    // Being on a block list and a few bounces that name one aren't the same thing: the bounces are often a shared sending IP or a link in the copy.
    if (f.listed) add("blocklisted", "soon", said, "Rest it, check the listing, and check the links in the copy", volume, "Block listed");
    else add("blocklisted", "soon", said, "Check the links in the copy and which list the bounces name. The Replace list says whether the domain itself should go", volume, "Block list bounces");
  }
  const spamRate = f.sent7 ? (100 * f.spamBounces) / f.sent7 : 0;
  if (f.spamBounces >= RULES.restSpam && spamRate >= RULES.restSpamRate) {
    add("spam", "soon", `${plural(f.spamBounces, "spam rejection")}, ${spamRate.toFixed(1)}% of ${n(f.sent7)} sent`, "Lower its volume, and check the copy and lists it's sending", volume);
  }
  if (f.sent7 >= RULES.silentSent && f.replies7 === 0) {
    add("silent", "soon", `${n(f.sent7)} sent in 7 days and not one reply`, "Run a placement test, and rest it if the mail lands in spam", volume);
  }
  if (f.rep != null && f.rep < RULES.lowRep) {
    add("low_rep", "watch", `Warm-up reputation ${f.rep.toFixed(0)}${f.lowRep ? `, ${plural(f.lowRep, "inbox", "inboxes")} under ${RULES.lowRep}` : ""}`, "Lower its sending until reputation recovers", volume);
  }
  if (f.warmupBlocked > 0) add("warmup_blocked", "watch", `Blocked on ${plural(f.warmupBlocked, "inbox", "inboxes")}`, "See why in Smartlead, and clear the block", volume);
  if (f.warmupOff > 0) add("warmup_off", "watch", `Off on ${plural(f.warmupOff, "inbox", "inboxes")}`, "Turn warm-up back on in Smartlead", volume);
  return out;
}

const TIER_RANK: Record<FixTier, number> = { urgent: 0, soon: 1, watch: 2 };
const KIND_RANK = new Map(FIX_KINDS.map((k, i) => [k, i]));
const byWorst = (a: FixProblem, b: FixProblem) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || KIND_RANK.get(a.kind)! - KIND_RANK.get(b.kind)!;

const snoozeKey = (name: string, kind: FixKind) => `${name}|${kind}`;

/** The queue: worst tier first, and most daily volume at risk first inside it. Snoozed problems sit out until they wake. */
export function fixQueue(facts: FixFact[], snoozes: FixSnooze[] = []): { items: FixItem[]; snoozed: (FixItem & { until: string })[] } {
  const asleep = new Map(snoozes.map((s) => [snoozeKey(s.name, s.kind), s.until]));
  const items: FixItem[] = [];
  const snoozed: (FixItem & { until: string })[] = [];
  for (const f of facts) {
    const all = problemsOf(f).sort(byWorst);
    if (!all.length) continue;
    const base = { name: f.name, domainId: f.domainId, clientId: f.clientId, clientName: f.clientName, clientHue: f.clientHue, provider: f.provider };
    const item = (problems: FixProblem[]): FixItem => ({ ...base, problems, top: problems[0], tier: problems[0].tier, risk: Math.max(...problems.map((p) => p.risk)) });
    const awake = all.filter((p) => !asleep.has(snoozeKey(f.name, p.kind)));
    if (awake.length) items.push(item(awake));
    for (const p of all) {
      const until = asleep.get(snoozeKey(f.name, p.kind));
      if (until) snoozed.push({ ...item([p]), until });
    }
  }
  const order = (a: FixItem, b: FixItem) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.risk - a.risk || a.name.localeCompare(b.name);
  return { items: items.sort(order), snoozed: snoozed.sort(order) };
}

/** Counts for the tiles: a domain counts once per tier, and under each kind it has. */
export function fixSummary(items: FixItem[]) {
  const tiers = Object.fromEntries(TIERS.map((t) => [t, { count: 0, risk: 0 }])) as Record<FixTier, { count: number; risk: number }>;
  const kinds = new Map<FixKind, { count: number; risk: number }>();
  for (const it of items) {
    tiers[it.tier].count++;
    tiers[it.tier].risk += it.risk;
    for (const p of it.problems) {
      const k = kinds.get(p.kind) ?? { count: 0, risk: 0 };
      k.count++; k.risk += p.risk;
      kinds.set(p.kind, k);
    }
  }
  return { tiers, kinds: FIX_KINDS.filter((k) => kinds.has(k)).map((kind) => ({ kind, ...kinds.get(kind)! })), risk: items.reduce((a, i) => a + i.risk, 0) };
}

/** CSV of the queue, as it's filtered. */
export function fixCsv(items: FixItem[]) {
  const esc = (v: string | number | null) => { const s = v == null ? "" : String(v); return /^[=+\-@]/.test(s) ? `'${s}` : /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ["Domain", "Client", "Provider", "When", "Problem", "What was seen", "Next step", "Emails a day at risk", "Other problems"];
  return [head.join(","), ...items.map((i) => [
    i.name, i.clientName, i.provider, TIER_META[i.tier].label, i.top.label, i.top.evidence, i.top.next, i.risk,
    i.problems.slice(1).map((p) => p.label).join("; "),
  ].map(esc).join(","))].join("\n");
}

/**
 * The facts for every domain that's live, has a live order, or sent in the last
 * 7 days. Plain SQL with no parameters, so it runs the same in the app and the tests.
 */
export const FIX_FACTS_SQL = `
  with t as (
    select z, (now() at time zone z)::date as today
    from (select coalesce((select value #>> '{}' from settings where key = 'stats_timezone'), 'UTC') as z) x
  ), s7 as (
    select s.domain_id, sum(s.sent)::int as sent7, sum(s.replies)::int as replies7,
      (count(*) filter (where s.sent > 0))::int as days_sent, max(s.day) filter (where s.sent > 0) as last_sent
    from domain_daily_stats s cross join t where s.day > t.today - 7 and s.day <= t.today group by 1
  ), ev as (
    select e.domain_id, count(*)::int as bounces7,
      (count(*) filter (where e.bounce_cause = 'dns'))::int as dns_bounces,
      (count(*) filter (where e.bounce_cause = 'sender'))::int as sender_bounces,
      (count(*) filter (where e.bounce_cause = 'blocklist'))::int as block_bounces,
      (count(*) filter (where e.bounce_cause = 'spam'))::int as spam_bounces
    from email_events e cross join t
    where e.kind = 'bounce' and e.domain_id is not null and e.occurred_at >= ((t.today - 6)::timestamp at time zone t.z)
    group by 1
  ), ib as (
    select i.domain_id,
      coalesce(sum(i.daily_limit) filter (where i.status = 'connected'), 0)::int as capacity,
      coalesce(sum(i.daily_limit) filter (where i.status = 'disconnected'), 0)::int as lost_capacity,
      (count(*) filter (where i.status = 'connected' and (i.warmup_enabled is not true or coalesce(i.warmup_status, '') ~* 'INACTIVE|PAUSE')))::int as warmup_off,
      (count(*) filter (where i.status = 'connected' and (coalesce(i.warmup_blocked_reason, '') <> '' or coalesce(i.warmup_status, '') ~* 'BLOCK')))::int as warmup_blocked,
      (count(*) filter (where i.status = 'connected' and i.warmup_reputation < 90))::int as low_rep,
      (avg(i.warmup_reputation) filter (where i.status = 'connected'))::float8 as rep
    from inboxes i group by 1
  ), oc as materialized (
    -- Once, not per domain: this view takes about half a second, and there are thousands of domains.
    select distinct on (o.domain_id) o.domain_id, o.state from order_connections o
    where o.domain_id is not null and o.state in ('missing', 'deleted') order by o.domain_id, o.state
  )
  select d.id as domain_id, d.name, d.status::text as status, st.standing, st.current, st.order_live, st.order_state, st.provider, st.grace_left,
    d.client_id, c.name as client_name, c.hue as client_hue,
    st.connected, st.disconnected, coalesce(ib.capacity, 0) as capacity, coalesce(ib.lost_capacity, 0) as lost_capacity,
    coalesce(ib.warmup_off, 0) as warmup_off, coalesce(ib.warmup_blocked, 0) as warmup_blocked, coalesce(ib.low_rep, 0) as low_rep, ib.rep,
    coalesce(s7.sent7, 0) as sent7, coalesce(s7.replies7, 0) as replies7, coalesce(s7.days_sent, 0) as days_sent, (t.today - s7.last_sent)::int as days_since_sent,
    coalesce(ev.bounces7, 0) as bounces7, coalesce(ev.dns_bounces, 0) as dns_bounces, coalesce(ev.sender_bounces, 0) as sender_bounces,
    coalesce(ev.block_bounces, 0) as block_bounces, coalesce(ev.spam_bounces, 0) as spam_bounces,
    d.nameservers_answering, d.dns_spf, d.dns_dkim, d.dns_dmarc, d.dns_mx,
    (coalesce(d.blacklist_domain_count, 0) + coalesce(d.blacklist_ip_count, 0))::int as listed,
    (d.expires_at - t.today)::int as days_to_expiry, d.auto_renew, oc.state as order_problem
  from domains d
  join domain_standing st on st.domain_id = d.id
  cross join t
  left join clients c on c.id = d.client_id
  left join ib on ib.domain_id = d.id
  left join s7 on s7.domain_id = d.id
  left join ev on ev.domain_id = d.id
  left join oc on oc.domain_id = d.id
  where (d.status in ('active', 'warming') and (st.current or st.order_live))
    or coalesce(s7.sent7, 0) > 0 or oc.state is not null`;
