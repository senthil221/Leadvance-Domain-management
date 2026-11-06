import { parseSavedPairs } from "@/lib/tag-map";
import { parseWarmupProgram } from "@/lib/warmup-program";
import "server-only";
import { attentionDomainCount } from "./attention";
import type { DiagnosisInput, CauseRow, PeerRow, StoredDiagnosis, WeekRow } from "./diagnose";
import { FIX_FACTS_SQL, fixQueue, type FixFact, type FixItem, type FixSnooze } from "./fix-queue";
import { addDays, monday, previousRange } from "./range";
import { senderOverview, tagOverview } from "./tag-list";
import { sql } from "./db";
import type { ConnectionProblem } from "@/lib/connections";
import type { DomainStatus, ReplacementReason, StepStatus } from "./status";

// ---------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------

export type ClientRow = { id: string; name: string; hue: number; activeCount: number };
export type VendorRow = { id: string; name: string; kind: "registrar" | "inbox_provider"; apiSupported: boolean };

export async function listClients() {
  return sql<ClientRow[]>`
    select c.id, c.name, c.hue,
      (select count(*)::int from domains d where d.client_id = c.id and d.status = 'active') as active_count
    from clients c
    where c.archived_at is null
    order by c.name`;
}

export type { TagRow } from "./tag-list";

/** Every Smartlead tag on the inboxes (except the New and Replaced marks) and the client it is mapped to, unmapped first. */
export async function listTags() {
  return tagOverview(sql);
}

export type SenderRow = Awaited<ReturnType<typeof senderOverview>>[number];

/** Every sender name on the inboxes, the client it is mapped to and the clients its domains are under now. */
export async function listSenders() {
  return senderOverview(sql);
}

export async function listVendors() {
  return sql<VendorRow[]>`select id, name, kind, api_supported from vendors order by kind, name`;
}

export type NavCounts = { byStatus: Record<DomainStatus, number>; openAlerts: number; runningBatches: number; connectionProblems: number; expiringUrgent: number; attention: number; fixToday: number };

export type FixQueueData = { items: FixItem[]; snoozed: (FixItem & { until: string })[]; slSyncedAt: Date | null };

/** Every problem on the live domains, worst first. */
export async function getFixQueue(): Promise<FixQueueData> {
  const [facts, snoozes, [sync]] = await Promise.all([
    sql.unsafe<FixFact[]>(FIX_FACTS_SQL),
    sql<FixSnooze[]>`select domain_name as name, kind, to_char(until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as until from fix_snoozes where until > now()`,
    sql<{ at: Date | null }[]>`select last_finished_at as at from job_state where job = 'smartlead-accounts'`,
  ]);
  return { ...fixQueue([...facts], [...snoozes]), slSyncedAt: sync?.at ?? null };
}

export async function getNavCounts(): Promise<NavCounts> {
  const [statusRows, [extra], attention, fix] = await Promise.all([
    sql<{ status: DomainStatus; n: number }[]>`select status, count(*)::int as n from domains group by status`,
    sql<{ openAlerts: number; runningBatches: number; connectionProblems: number; expiringUrgent: number }[]>`
      select
        (select count(*)::int from domains d where d.status in ('active', 'warming', 'provisioning') and d.expires_at <= current_date + 14 and d.auto_renew is not true
          and not exists (select 1 from replacement_items ri join replacement_batches rb on rb.id = ri.batch_id where ri.old_domain_id = d.id and rb.status <> 'cancelled')) as expiring_urgent,
        (select count(*)::int from alerts where status = 'open') as open_alerts,
        (select count(*)::int from replacement_batches where status = 'running') as running_batches,
        (select count(*)::int from order_connections where problem) as connection_problems`,
    attentionDomainCount(sql),
    getFixQueue(),
  ]);
  const byStatus = Object.fromEntries(statusRows.map((r) => [r.status, r.n])) as Record<DomainStatus, number>;
  return { byStatus, ...extra, attention, fixToday: fix.items.filter((i) => i.tier === "urgent").length };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export type AttentionRow = {
  alertId: string;
  domainId: string;
  domain: string;
  status: DomainStatus;
  clientName: string | null;
  clientHue: number | null;
  ruleName: string;
  metric: string;
  value: number | null;
  severity: "warning" | "critical";
  openedAt: Date;
  sent: number;
};

export type ActivityRow = {
  id: number;
  domainId: string;
  domain: string;
  fromStatus: DomainStatus | null;
  toStatus: DomainStatus;
  reason: string | null;
  actor: string;
  at: Date;
};

export type ClientFleetRow = { clientId: string; name: string; hue: number; counts: Record<string, number>; total: number };

export async function getOverview() {
  const [[totals], attention, activity, fleetRows, [rates]] = await Promise.all([
    sql<{ active: number; free: number; warming: number; retiredLast28: number; storageLow: number; flagged: number }[]>`
      select
        (select count(distinct a.domain_id)::int from alerts a join domain_standing st on st.domain_id = a.domain_id
          where a.status = 'open' and st.current) as flagged,
        count(*) filter (where status = 'active')::int as active,
        count(*) filter (where domain_is_free(domains))::int as free,
        count(*) filter (where status in ('provisioning', 'warming'))::int as warming,
        (select count(*)::int from domain_status_history
          where to_status = 'draining' and at > now() - interval '28 days') as retired_last28,
        coalesce((select (value #>> '{}')::int from settings where key = 'storage_low_threshold'), 20) as storage_low
      from domains`,
    sql<AttentionRow[]>`
      select a.id as alert_id, d.id as domain_id, d.name as domain, d.status,
        c.name as client_name, c.hue as client_hue, r.name as rule_name, r.metric, a.value::float8 as value,
        r.severity, a.opened_at, h.sent
      from alerts a
      join domains d on d.id = a.domain_id
      join health_rules r on r.id = a.rule_id
      left join clients c on c.id = d.client_id
      left join domain_health_7d h on h.domain_id = d.id
      join domain_standing st on st.domain_id = d.id
      where a.status = 'open' and st.current
      order by (r.severity = 'critical') desc, a.opened_at desc
      limit 8`,
    sql<ActivityRow[]>`
      select h.id, d.id as domain_id, d.name as domain, h.from_status, h.to_status, h.reason, h.actor, h.at
      from domain_status_history h join domains d on d.id = h.domain_id
      where h.from_status is not null
      order by h.at desc, h.id desc
      limit 8`,
    sql<{ clientId: string; name: string; hue: number; status: DomainStatus; n: number }[]>`
      select c.id as client_id, c.name, c.hue, d.status, count(*)::int as n
      from domains d join clients c on c.id = d.client_id
      join domain_standing st on st.domain_id = d.id
      where d.status = 'provisioning' or (st.current and d.status in ('warming', 'active', 'draining'))
      group by c.id, c.name, c.hue, d.status`,
    sql<{ sent7: number; human7: number; sentPrev: number; humanPrev: number; bounces7: number }[]>`
      select
        coalesce(sum(sent) filter (where day > current_date - 7), 0)::int as sent7,
        coalesce(sum(human_replies) filter (where day > current_date - 7), 0)::int as human7,
        coalesce(sum(bounces) filter (where day > current_date - 7), 0)::int as bounces7,
        coalesce(sum(sent) filter (where day <= current_date - 7), 0)::int as sent_prev,
        coalesce(sum(human_replies) filter (where day <= current_date - 7), 0)::int as human_prev
      from domain_daily_stats where day > current_date - 14`,
  ]);

  const fleet = new Map<string, ClientFleetRow>();
  for (const r of fleetRows) {
    const row = fleet.get(r.clientId) ?? { clientId: r.clientId, name: r.name, hue: r.hue, counts: {}, total: 0 };
    row.counts[r.status] = r.n;
    row.total += r.n;
    fleet.set(r.clientId, row);
  }

  const weeklyBurn = totals.retiredLast28 / 4;
  const humanRate = rates.sent7 > 0 ? (100 * rates.human7) / rates.sent7 : null;
  const humanRatePrev = rates.sentPrev > 0 ? (100 * rates.humanPrev) / rates.sentPrev : null;

  return {
    totals,
    weeklyBurn,
    weeksLeft: weeklyBurn > 0 ? totals.free / weeklyBurn : null,
    humanRate,
    humanRateDelta: humanRate != null && humanRatePrev != null ? humanRate - humanRatePrev : null,
    sent7: rates.sent7,
    bounceRate: rates.sent7 > 0 ? (100 * rates.bounces7) / rates.sent7 : null,
    attention,
    activity,
    fleet: [...fleet.values()].sort((a, b) => b.total - a.total),
  };
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export type DomainRow = {
  id: string;
  name: string;
  tld: string | null;
  status: DomainStatus;
  clientId: string | null;
  clientName: string | null;
  clientHue: number | null;
  registrar: string | null;
  /** The registrar login it came from, when added in Settings. */
  registrarAccount: string | null;
  inboxCount: number;
  sent: number;
  humanReplies: number;
  replies: number;
  bounces: number;
  bounceRate: number | null;
  humanReplyRate: number | null;
  warmupReputation: number | null;
  activeSince: Date | null;
  purchasedAt: Date | null;
  /** When the domain was bought, or registered if we only know that: what its age counts from. */
  bornAt: Date | null;
  expiresAt: Date | null;
  /** Days until it expires, by the database's calendar; below zero once it has. */
  daysToExpiry: number | null;
  autoRenew: boolean | null;
  openAlerts: number;
  spark: number[];
  sl7Sent: number | null;
  sl7Replies: number | null;
  sl7Bounces: number | null;
  tags: string[];
  /** Days until a replaced (draining) domain's grace period ends. */
  graceDaysLeft: number | null;
  nameservers: string[];
  htOrderStatus: string | null;
  htPayment: string | null;
  nsRequestStatus: string | null;
  nsRequestMessage: string | null;
  nsRequestTarget: string[] | null;
  replacedById: string | null;
  replacedByName: string | null;
  replacedAt: Date | null;
  drainingSince: Date | null;
  burnedAt: Date | null;
  costCents: number | null;
  capacity: number;
  apiAccess: boolean | null;
  nameserversCheckedAt: Date | null;
  nameserversAnswering: boolean | null;
  /** Last day it was in use: a Hypertide order, a send, or being replaced. */
  lastUsedOn: Date | null;
  /** Bought and never touched: no vendor, inbox or order, on its registrar's default nameservers or none. */
  isFree: boolean;
  /** In storage only: any sign the domain has been used before. */
  everUsed: boolean | null;
  /** A free domain used too recently to pick again, until this day. */
  coolingUntil: Date | null;
  /** Past its renewal date, and what the registrar calls it (redemption…). */
  expired: boolean;
  registrarStatus: string | null;
  /** Live Icemail mailboxes on it, what they cost a month and when the next one bills. */
  icemailMailboxes: number | null;
  icemailMonthly: number | null;
  icemailNextBill: Date | null;
  /** What Icemail reports wrong with the domain: blacklisted, DNS records missing, not active. */
  icemailIssue: string | null;
} & import("./smartlead-state").SlCounts;

export async function listDomains() {
  return sql<DomainRow[]>`
    select d.id, d.name, d.tld, d.status, d.client_id, c.name as client_name, c.hue as client_hue,
      v.name as registrar, ra.label as registrar_account,
      (select count(*)::int from inboxes i where i.domain_id = d.id and i.status <> 'removed') as inbox_count,
      h.sent, h.human_replies, h.replies, h.bounces,
      h.bounce_rate::float8 as bounce_rate, h.human_reply_rate::float8 as human_reply_rate,
      h.warmup_reputation::float8 as warmup_reputation,
      d.active_since, d.purchased_at, coalesce(d.purchased_at, d.registered_at)::timestamptz as born_at, d.expires_at,
      (d.expires_at - current_date)::int as days_to_expiry, d.auto_renew,
      (select count(*)::int from alerts a where a.domain_id = d.id and a.status = 'open') as open_alerts,
      s7.sent as sl7_sent, s7.replies as sl7_replies, s7.bounces as sl7_bounces,
      array(
        select coalesce(s.sent, 0)
        from generate_series(current_date - 13, current_date, interval '1 day') g(day)
        left join domain_daily_stats s on s.domain_id = d.id and s.day = g.day::date
        order by g.day
      ) as spark,
      d.tags, grace_days_left(d.status, d.draining_since) as grace_days_left, d.nameservers, d.draining_since, d.burned_at, d.cost_cents, d.registrar_api_access as api_access, d.nameservers_checked_at, d.nameservers_answering,
      d.last_used_on, case when d.status = 'in_storage' and d.last_used_on + reuse_after_days() > current_date then d.last_used_on + reuse_after_days() end as cooling_until,
      domain_is_free(d) as is_free, case when d.status = 'in_storage' then domain_ever_used(d) end as ever_used,
      coalesce(d.expires_at < current_date, false) as expired, d.registrar_status,
      ho.status as ht_order_status, ho.payment_status as ht_payment,
      nr.status as ns_request_status, nr.message as ns_request_message, nr.target as ns_request_target,
      rp.new_domain_id as replaced_by_id, rp.name as replaced_by_name, rp.created_at as replaced_at,
      nullif(im.mailboxes, 0) as icemail_mailboxes, im.monthly as icemail_monthly, im.next_bill as icemail_next_bill,
      case when ix.id is null then null
        when ix.blacklisted then 'Blacklisted'
        when false in (ix.spf, ix.dkim, ix.dmarc, ix.mx) then 'Missing ' || concat_ws(', ',
          case when ix.spf is false then 'SPF' end, case when ix.dkim is false then 'DKIM' end,
          case when ix.dmarc is false then 'DMARC' end, case when ix.mx is false then 'MX' end)
        when ix.status is distinct from 'ACTIVE' then initcap(coalesce(ix.status, 'unknown'))
      end as icemail_issue,
      (select coalesce(sum(i.daily_limit), 0)::int from inboxes i where i.domain_id = d.id and i.status = 'connected') as capacity,
      sl.sl_connected, sl.sl_disconnected, sl.sl_removed
    from domains d
    left join clients c on c.id = d.client_id
    left join vendors v on v.id = d.registrar_id
    left join registrar_accounts ra on ra.id = d.registrar_account_id
    left join lateral (
      select count(*) filter (where i.status = 'connected')::int as sl_connected,
        count(*) filter (where i.status = 'disconnected')::int as sl_disconnected,
        count(*) filter (where i.status = 'removed')::int as sl_removed
      from inboxes i where i.domain_id = d.id) sl on true
    left join lateral (
      select count(*)::int as mailboxes,
        sum(case when m.billing_cycle = 'YEARLY' then m.cost / 12 else m.cost end)::float8 as monthly,
        min(m.next_billing_on) filter (where m.next_billing_on >= current_date) as next_bill
      from icemail_mailboxes m where m.domain_id = d.id and m.gone_at is null) im on true
    left join lateral (
      select x.* from icemail_domains x where x.domain_id = d.id and x.gone_at is null order by x.last_seen_at desc limit 1) ix on true
    left join domain_health_7d h on h.domain_id = d.id
    left join smartlead_domain_7d s7 on s7.domain_name = d.name
    left join lateral (
      select o.status, o.payment_status from hypertide_orders o
      where o.domain_id = d.id and o.gone_at is null order by o.last_seen_at desc limit 1) ho on true
    left join lateral (
      select r.status, r.message, r.target from nameserver_requests r
      where r.domain_id = d.id and r.created_at > now() - interval '14 days' order by r.created_at desc limit 1) nr on true
    left join lateral (
      select ri.new_domain_id, nd.name, ri.created_at from replacement_items ri
      join replacement_batches rb on rb.id = ri.batch_id join domains nd on nd.id = ri.new_domain_id
      where ri.old_domain_id = d.id and rb.status <> 'cancelled' order by ri.created_at desc limit 1) rp on true
    order by d.name`;
}

export type InboxRow = {
  id: string;
  email: string;
  senderName: string | null;
  status: string;
  warmupEnabled: boolean | null;
  warmupPerDay: number | null;
  warmupRampup: number | null;
  dailyLimit: number | null;
  warmupReputation: number | null;
  smartleadAccountId: number | null;
  lastSyncedAt: Date | null;
};

export type DomainDetail = {
  domain: DomainRow & {
    nameservers: string[];
    notes: string | null;
    costCents: number | null;
    drainingSince: Date | null;
    burnedAt: Date | null;
    createdAt: Date;
    inboxProvider: string | null;
    /** Why nothing on it can send, when it's an active domain that's dead. */
    deadCause: import("./dead").DeadCause | null;
    autoRenew: boolean | null;
    registrarApiAccess: boolean | null;
    nameserversCheckedAt: Date | null;
  };
  inboxes: InboxRow[];
  daily: { day: string; sent: number; humanReplies: number; ooo: number; bounces: number; warmupReputation: number | null }[];
  history: { id: number; fromStatus: DomainStatus | null; toStatus: DomainStatus; reason: string | null; actor: string; forced: boolean; at: Date }[];
  lineage: {
    replaced: { domainId: string; name: string; at: Date; reason: ReplacementReason; note: string | null } | null;
    replacedBy: { domainId: string; name: string; at: Date; reason: ReplacementReason; note: string | null } | null;
  };
  alerts: { id: string; ruleName: string; metric: string; value: number | null; severity: string; openedAt: Date }[];
  diagnosis: StoredDiagnosis | null;
};

/** The numbers a diagnosis reads. Names, tag wording, status reasons and message text are left out on purpose. */
export async function getDiagnosisInput(id: string): Promise<DiagnosisInput | null> {
  const [own] = await sql<(DiagnosisInput["own"] & { today: string })[]>`
    with t as (select (now() at time zone coalesce((select value #>> '{}' from settings where key = 'stats_timezone'), 'UTC'))::date as today)
    select d.tld, to_char(t.today, 'YYYY-MM-DD') as today,
      (t.today - d.purchased_at::date)::int as age_days,
      (select (t.today - min(i.smartlead_created_at)::date)::int from inboxes i where i.domain_id = d.id and i.status <> 'removed') as days_in_smartlead
    from domains d cross join t where d.id = ${id}`;
  if (!own) return null;
  const today = own.today;
  const [facts, weeks, causes, peers, changes] = await Promise.all([
    sql.unsafe<FixFact[]>(FIX_FACTS_SQL),
    sql<WeekRow[]>`
      select ((${today}::date - s.day) / 7)::int as week, sum(s.sent)::int as sent, (count(*) filter (where s.sent > 0))::int as days_sent,
        sum(s.human_replies)::int as human_replies, sum(s.replies)::int as all_replies, sum(s.ooo)::int as ooo, sum(s.bounces)::int as bounces
      from domain_daily_stats s
      where s.domain_id = ${id} and s.day > ${today}::date - 28 and s.day <= ${today}::date group by 1`,
    sql<CauseRow[]>`
      select coalesce(e.bounce_cause, 'other') as cause,
        (count(*) filter (where e.occurred_at >= ${today}::date - 6))::int as last7, count(*)::int as last28
      from email_events e
      where e.kind = 'bounce' and e.domain_id = ${id} and e.occurred_at >= ${today}::date - 27 group by 1 order by 1`,
    sql<PeerRow[]>`
      with me as (select client_id, tags from domains where id = ${id}), others as (
        select p.id, p.client_id = me.client_id as same_client, p.client_id = me.client_id and p.tags && me.tags as same_tag
        from domains p cross join me where p.id <> ${id} and p.status in ('active', 'warming'))
      select g.grp, ((${today}::date - s.day) / 7)::int as week, (count(distinct s.domain_id) filter (where s.sent > 0))::int as domains,
        sum(s.sent)::int as sent, sum(s.human_replies)::int as human_replies, sum(s.bounces)::int as bounces
      from domain_daily_stats s join others o on o.id = s.domain_id
      cross join lateral (values ('all'), ('client'), ('tag')) g(grp)
      where s.day > ${today}::date - 28 and s.day <= ${today}::date
        and (g.grp = 'all' or (g.grp = 'client' and o.same_client) or (g.grp = 'tag' and o.same_tag))
      group by 1, 2`,
    sql<DiagnosisInput["changes"]>`
      select from_status as "from", to_status as "to", (${today}::date - at::date)::int as days_ago
      from domain_status_history where domain_id = ${id} and at >= ${today}::date - 60 order by at desc, id desc limit 8`,
  ]);
  return {
    fact: facts.find((f) => f.domainId === id) ?? null,
    own: { tld: own.tld, ageDays: own.ageDays, daysInSmartlead: own.daysInSmartlead },
    weeks: [...weeks], causes: [...causes], peers: [...peers], changes: [...changes],
  };
}

export async function getDomainDetail(id: string): Promise<DomainDetail | null> {
  const [domain] = await sql<DomainDetail["domain"][]>`
    select d.id, d.name, d.tld, d.status, d.client_id, c.name as client_name, c.hue as client_hue,
      v.name as registrar, ip.name as inbox_provider,
      (select dd.cause from dead_domains dd where dd.domain_id = d.id) as dead_cause,
      (select count(*)::int from inboxes i where i.domain_id = d.id and i.status <> 'removed') as inbox_count,
      h.sent, h.human_replies, h.replies, h.bounces,
      h.bounce_rate::float8 as bounce_rate, h.human_reply_rate::float8 as human_reply_rate,
      h.warmup_reputation::float8 as warmup_reputation,
      d.active_since, d.purchased_at, d.expires_at, d.nameservers, d.notes, d.cost_cents,
      d.draining_since, d.burned_at, d.created_at, d.auto_renew, d.registrar_api_access, d.nameservers_checked_at,
      (select count(*)::int from alerts a where a.domain_id = d.id and a.status = 'open') as open_alerts,
      '{}'::int[] as spark,
      s7.sent as sl7_sent, s7.replies as sl7_replies, s7.bounces as sl7_bounces,
      d.tags, grace_days_left(d.status, d.draining_since) as grace_days_left, d.registrar_api_access as api_access, d.nameservers_answering, ho.status as ht_order_status, ho.payment_status as ht_payment,
      nr.status as ns_request_status, nr.message as ns_request_message, nr.target as ns_request_target,
      null as replaced_by_id, null as replaced_by_name, null as replaced_at,
      nullif(im.mailboxes, 0) as icemail_mailboxes, im.monthly as icemail_monthly, im.next_bill as icemail_next_bill,
      case when ix.id is null then null
        when ix.blacklisted then 'Blacklisted'
        when false in (ix.spf, ix.dkim, ix.dmarc, ix.mx) then 'Missing ' || concat_ws(', ',
          case when ix.spf is false then 'SPF' end, case when ix.dkim is false then 'DKIM' end,
          case when ix.dmarc is false then 'DMARC' end, case when ix.mx is false then 'MX' end)
        when ix.status is distinct from 'ACTIVE' then initcap(coalesce(ix.status, 'unknown'))
      end as icemail_issue,
      (select coalesce(sum(i.daily_limit), 0)::int from inboxes i where i.domain_id = d.id and i.status = 'connected') as capacity
    from domains d
    left join clients c on c.id = d.client_id
    left join vendors v on v.id = d.registrar_id
    left join vendors ip on ip.id = d.inbox_provider_id
    left join lateral (
      select count(*)::int as mailboxes,
        sum(case when m.billing_cycle = 'YEARLY' then m.cost / 12 else m.cost end)::float8 as monthly,
        min(m.next_billing_on) filter (where m.next_billing_on >= current_date) as next_bill
      from icemail_mailboxes m where m.domain_id = d.id and m.gone_at is null) im on true
    left join lateral (
      select x.* from icemail_domains x where x.domain_id = d.id and x.gone_at is null order by x.last_seen_at desc limit 1) ix on true
    left join domain_health_7d h on h.domain_id = d.id
    left join smartlead_domain_7d s7 on s7.domain_name = d.name
    left join lateral (
      select o.status, o.payment_status from hypertide_orders o
      where o.domain_id = d.id and o.gone_at is null order by o.last_seen_at desc limit 1) ho on true
    left join lateral (
      select r.status, r.message, r.target from nameserver_requests r
      where r.domain_id = d.id order by r.created_at desc limit 1) nr on true
    where d.id = ${id}`;
  if (!domain) return null;

  const [inboxes, daily, history, lineageRows, alerts, [diagnosis]] = await Promise.all([
    sql<InboxRow[]>`
      select id, email, sender_name, status, warmup_enabled, warmup_per_day, warmup_rampup, daily_limit,
        warmup_reputation::float8 as warmup_reputation, smartlead_account_id, last_synced_at
      from inboxes where domain_id = ${id} order by email`,
    sql<DomainDetail["daily"]>`
      select to_char(g.day, 'YYYY-MM-DD') as day, coalesce(s.sent, 0) as sent,
        coalesce(s.human_replies, 0) as human_replies, coalesce(s.ooo, 0) as ooo, coalesce(s.bounces, 0) as bounces,
        s.warmup_reputation::float8 as warmup_reputation
      from generate_series(current_date - 29, current_date, interval '1 day') g(day)
      left join domain_daily_stats s on s.domain_id = ${id} and s.day = g.day::date
      order by g.day`,
    sql<DomainDetail["history"]>`
      select id, from_status, to_status, reason, actor, forced, at
      from domain_status_history where domain_id = ${id} order by at desc, id desc`,
    sql<{ side: "replaced" | "replacedBy"; domainId: string; name: string; at: Date; reason: ReplacementReason; note: string | null }[]>`
      select 'replaced' as side, ri.old_domain_id as domain_id, od.name, ri.created_at as at, rb.reason, rb.note
      from replacement_items ri join replacement_batches rb on rb.id = ri.batch_id join domains od on od.id = ri.old_domain_id
      where ri.new_domain_id = ${id}
      union all
      select 'replacedBy', ri.new_domain_id, nd.name, ri.created_at, rb.reason, rb.note
      from replacement_items ri join replacement_batches rb on rb.id = ri.batch_id join domains nd on nd.id = ri.new_domain_id
      where ri.old_domain_id = ${id} and rb.status <> 'cancelled'`,
    sql<DomainDetail["alerts"]>`
      select a.id, r.name as rule_name, r.metric, a.value::float8 as value, r.severity, a.opened_at
      from alerts a join health_rules r on r.id = a.rule_id
      where a.domain_id = ${id} and a.status = 'open' order by a.opened_at desc`,
    sql<StoredDiagnosis[]>`
      select id, created_at, created_by, model, result, input_tokens, output_tokens, cost_usd::float8 as cost_usd, feedback
      from domain_diagnoses where domain_id = ${id} order by id desc limit 1`,
  ]);

  const pick = (side: "replaced" | "replacedBy") => {
    const r = lineageRows.find((l) => l.side === side);
    return r ? { domainId: r.domainId, name: r.name, at: r.at, reason: r.reason, note: r.note } : null;
  };

  return { domain, inboxes, daily, history, lineage: { replaced: pick("replaced"), replacedBy: pick("replacedBy") }, alerts, diagnosis: diagnosis ?? null };
}

// Free domains for the replace dialog, preferring the given TLDs. Nothing is
// locked here: start_replacement re-checks each pick inside its transaction.
// Domains used within the reuse window (Settings → Lifecycle) are left out;
// never-used ones come first, then those at a known registrar.
export type StorageCandidate = { id: string; name: string; tld: string | null; registrar: string | null; purchasedAt: Date | null; lastUsedOn: Date | null };

export async function listStorageCandidates(limit = 200) {
  return sql<StorageCandidate[]>`
    select d.id, d.name, d.tld, v.name as registrar, d.purchased_at, d.last_used_on
    from domains d left join vendors v on v.id = d.registrar_id
    where d.status = 'in_storage' and (d.expires_at is null or d.expires_at >= current_date) and (d.last_used_on is null or d.last_used_on + reuse_after_days() <= current_date)
    order by domain_is_free(d) desc, (d.last_used_on is not null), (d.registrar_id is null), d.purchased_at nulls last, d.created_at, d.name
    limit ${limit}`;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export type RenewalRow = { id: string; name: string; status: DomainStatus; registrar: string | null; expiresAt: Date; costCents: number | null; clientName: string | null; clientHue: number | null };

/** Where domains stand, counted per group (registrar account or TLD). */
export type Breakdown = {
  key: string; label: string; sub: string | null; total: number; active: number; setup: number;
  free: number; cooling: number; replaced: number; usedBefore: number; expired: number; expiring30: number; annualCents: number;
};

// An expired domain counts only as expired, never as owned, active or free.
const breakdownCounts = (s: typeof sql) => s`
  count(*) filter (where d.expires_at is null or d.expires_at >= current_date)::int as total,
  count(*) filter (where d.status = 'active' and (d.expires_at is null or d.expires_at >= current_date))::int as active,
  count(*) filter (where d.status in ('provisioning', 'warming') and (d.expires_at is null or d.expires_at >= current_date))::int as setup,
  count(*) filter (where d.status = 'in_storage' and (d.expires_at is null or d.expires_at >= current_date) and (d.last_used_on is null or d.last_used_on + reuse_after_days() <= current_date))::int as free,
  count(*) filter (where d.status = 'in_storage' and (d.expires_at is null or d.expires_at >= current_date) and d.last_used_on + reuse_after_days() > current_date)::int as cooling,
  count(*) filter (where d.status in ('draining', 'burned', 'resting') and (d.expires_at is null or d.expires_at >= current_date))::int as replaced,
  count(*) filter (where d.status = 'in_storage' and (d.expires_at is null or d.expires_at >= current_date) and d.last_used_on is not null)::int as used_before,
  count(*) filter (where d.expires_at < current_date)::int as expired,
  count(*) filter (where d.expires_at between current_date and current_date + 30 and d.status not in ('burned', 'resting'))::int as expiring30,
  coalesce(sum(d.cost_cents) filter (where d.status not in ('burned', 'resting') and (d.expires_at is null or d.expires_at >= current_date)), 0)::int as annual_cents`;

export async function getInventory() {
  const [accounts, tlds, renewals, [totals]] = await Promise.all([
    sql<Breakdown[]>`
      select coalesce(ra.id::text, v.name, 'none') as key, coalesce(v.name, 'No registrar account') as label, ra.label as sub, ${breakdownCounts(sql)}
      from domains d left join vendors v on v.id = d.registrar_id left join registrar_accounts ra on ra.id = d.registrar_account_id
      group by ra.id, v.name, ra.label order by (v.name is null), total desc`,
    sql<Breakdown[]>`
      select coalesce(d.tld, '?') as key, '.' || coalesce(d.tld, '?') as label, null as sub, ${breakdownCounts(sql)}
      from domains d group by d.tld order by total desc`,
    sql<RenewalRow[]>`
      select d.id, d.name, d.status, v.name as registrar, d.expires_at, d.cost_cents, c.name as client_name, c.hue as client_hue
      from domains d left join vendors v on v.id = d.registrar_id left join clients c on c.id = d.client_id
      where d.expires_at between current_date and current_date + 60
      order by d.expires_at, d.name`,
    sql<{ owned: number; expired: number; storage: number; cooling: number; reuseAfterDays: number; annualCents: number; retiredRenewing: number }[]>`
      select count(*) filter (where expires_at is null or expires_at >= current_date)::int as owned,
        count(*) filter (where expires_at < current_date)::int as expired,
        count(*) filter (where status = 'in_storage' and (expires_at is null or expires_at >= current_date))::int as storage,
        count(*) filter (where status = 'in_storage' and (expires_at is null or expires_at >= current_date) and last_used_on + reuse_after_days() > current_date)::int as cooling,
        reuse_after_days() as reuse_after_days,
        coalesce(sum(cost_cents) filter (where status not in ('burned', 'resting') and (expires_at is null or expires_at >= current_date)), 0)::int as annual_cents,
        count(*) filter (where status in ('burned', 'resting') and auto_renew is not false and expires_at between current_date and current_date + 60)::int as retired_renewing
      from domains`,
  ]);
  return { accounts, tlds, renewals, totals };
}

export type HypertideSummary = {
  orders: number; paid: number; unpaid: number; inSetup: number; done: number; cancelled: number; recovery: number;
  retiredBilled: { id: string; name: string; status: DomainStatus }[];
  sendingWithout: number; lastSync: Date | null; replacedLast28: number;
};

// Hypertide orders next to inventory: what is billed, what is still being set
// up, and retired domains whose subscription is still running. Only Done orders
// are billed; the API's "NPC" status is a cancelled order.
export async function getHypertideSummary(): Promise<HypertideSummary> {
  const [[t], retiredBilled, [job]] = await Promise.all([
    sql<Omit<HypertideSummary, "retiredBilled" | "lastSync">[]>`
      select count(*)::int as orders,
        count(*) filter (where payment_status ilike 'paid%')::int as paid,
        count(*) filter (where payment_status not ilike 'paid%' and payment_status not ilike '%recovery%')::int as unpaid,
        count(*) filter (where payment_status ilike 'paid%' and coalesce(status, '') not in ('Done', 'NPC', 'Cancelled'))::int as in_setup,
        count(*) filter (where status in ('NPC', 'Cancelled') and payment_status not ilike '%recovery%')::int as cancelled,
        count(*) filter (where payment_status ilike '%recovery%')::int as recovery,
        count(*) filter (where status = 'Done')::int as done,
        (select count(*)::int from domains d where d.status in ('active', 'warming')
          and not exists (select 1 from hypertide_orders o where o.domain_id = d.id and o.gone_at is null and coalesce(o.status, '') not in ('NPC', 'Cancelled'))) as sending_without,
        (select count(*)::int from domain_status_history where to_status = 'draining' and at > now() - interval '28 days') as replaced_last28
      from hypertide_orders where gone_at is null`,
    sql<HypertideSummary["retiredBilled"]>`
      select distinct d.id, d.name, d.status from hypertide_orders o join domains d on d.id = o.domain_id
      where o.gone_at is null and o.status = 'Done' and d.status in ('burned', 'resting')
      order by d.name`,
    sql<{ lastFinishedAt: Date | null }[]>`select last_finished_at from job_state where job = 'hypertide-orders' and last_ok`,
  ]);
  return { ...t, retiredBilled, lastSync: job?.lastFinishedAt ?? null };
}

// ---------------------------------------------------------------------------
// Replacements
// ---------------------------------------------------------------------------

export type ReplacementRow = {
  id: string;
  reason: ReplacementReason;
  batchNote: string | null;
  actor: string;
  createdAt: Date;
  completedAt: Date | null;
  hypertideReplace: boolean;
  addToCampaigns: boolean;
  stopOldSending: boolean;
  copyTagsAndWarmup: boolean;
  oldDomainId: string;
  oldDomain: string;
  oldStatus: DomainStatus;
  oldInboxes: number;
  oldCampaigns: string[];
  graceEndsAt: Date | null;
  newDomainId: string;
  newDomain: string;
  newStatus: DomainStatus;
  newInboxes: number;
  newWarmupOn: number;
  newReputation: number | null;
  clientName: string | null;
  clientHue: number | null;
  stepNameservers: StepStatus;
  stepInboxes: StepStatus;
  stepSmartlead: StepStatus;
  stepCampaigns: StepStatus;
  note: string | null;
  lastError: string | null;
  htOperation: string | null;
  htNameservers: string[] | null;
  htOrderId: string | null;
  htPaidAt: Date | null;
  campaignsAddedAt: Date | null;
  /** Warmed up enough to join campaigns (see replacement_readiness). */
  ready: boolean;
  warmDays: number | null;
  minDays: number;
  minRep: number;
};

/** One row per replacement, newest first, with what the page shows about both domains. */
export async function listReplacements(limit = 200): Promise<{ rows: ReplacementRow[]; now: number; graceDays: number }> {
  // The database clock, so relative times render the same on server and client.
  const [[{ now, graceDays }], rows] = await Promise.all([sql<{ now: Date; graceDays: number }[]>`
    select now(), coalesce((select (value #>> '{}')::int from settings where key = 'drain_days'), 18) as grace_days`, sql<ReplacementRow[]>`
    with drain as (select coalesce((select (value #>> '{}')::int from settings where key = 'drain_days'), 18) as days)
    select ri.id, rb.reason, rb.note as batch_note, rb.actor, ri.created_at, ri.completed_at,
      rb.hypertide_replace, rb.add_to_campaigns, rb.stop_old_sending, rb.copy_tags_and_warmup,
      od.id as old_domain_id, od.name as old_domain, od.status as old_status,
      (select count(*)::int from inboxes i where i.domain_id = od.id and i.status <> 'removed') as old_inboxes,
      coalesce((select array_agg(distinct c.name order by c.name) from campaign_inboxes ci
        join inboxes i on i.id = ci.inbox_id join campaigns c on c.id = ci.campaign_id where i.domain_id = od.id), '{}') as old_campaigns,
      case when od.status = 'draining' and od.draining_since is not null
        then od.draining_since + make_interval(days => (select days from drain)) end as grace_ends_at,
      nd.id as new_domain_id, nd.name as new_domain, nd.status as new_status,
      n.inboxes as new_inboxes, n.warm as new_warmup_on, n.rep as new_reputation,
      c.name as client_name, c.hue as client_hue,
      ri.step_nameservers, ri.step_inboxes, ri.step_smartlead, ri.step_campaigns, ri.note, ri.last_error,
      ri.ht_operation, ri.hypertide_ns as ht_nameservers, ri.hypertide_order_id as ht_order_id, ri.hypertide_paid_at as ht_paid_at,
      ri.campaigns_added_at, coalesce(rr.ready, false) as ready, rr.warm_days, rr.min_days, rr.min_rep::float8 as min_rep
    from replacement_items ri
    left join replacement_readiness rr on rr.item_id = ri.id
    join replacement_batches rb on rb.id = ri.batch_id
    join domains od on od.id = ri.old_domain_id
    join domains nd on nd.id = ri.new_domain_id
    left join clients c on c.id = coalesce(ri.client_id, nd.client_id)
    cross join lateral (
      select count(*) filter (where i.status = 'connected')::int as inboxes,
        count(*) filter (where i.status = 'connected' and i.warmup_enabled)::int as warm,
        round(avg(i.warmup_reputation) filter (where i.status = 'connected'), 1)::float8 as rep
      from inboxes i where i.domain_id = nd.id
    ) n
    order by ri.created_at desc
    limit ${limit}`]);
  return { rows, now: +now, graceDays };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type RuleRow = {
  id: string; name: string; metric: string; comparison: string; threshold: number;
  minSent: number; windowDays: number; severity: "warning" | "critical"; enabled: boolean; openCount: number;
};

export async function listRules() {
  return sql<RuleRow[]>`
    select r.id, r.name, r.metric, r.comparison, r.threshold::float8 as threshold, r.min_sent, r.window_days, r.severity, r.enabled,
      (select count(*)::int from alerts a where a.rule_id = r.id and a.status = 'open') as open_count
    from health_rules r order by r.created_at`;
}

export async function listOpenAlerts() {
  return sql<AttentionRow[]>`
    select a.id as alert_id, d.id as domain_id, d.name as domain, d.status,
      c.name as client_name, c.hue as client_hue, r.name as rule_name, r.metric, a.value::float8 as value,
      r.severity, a.opened_at, coalesce(h.sent, 0) as sent
    from alerts a
    join domains d on d.id = a.domain_id
    join health_rules r on r.id = a.rule_id
    left join clients c on c.id = d.client_id
    left join domain_health_7d h on h.domain_id = d.id
    where a.status = 'open' and d.status in ('active', 'warming')
    order by (r.severity = 'critical') desc, a.value desc nulls last`;
}

// ---------------------------------------------------------------------------
// Inboxes and replies
// ---------------------------------------------------------------------------

export type InboxListRow = InboxRow & {
  domainId: string; domain: string; domainStatus: DomainStatus; clientName: string | null; clientHue: number | null;
  domainTags: string[]; domainGraceDaysLeft: number | null; domainTld: string | null; domainAlerts: number;
  domainWarmupStartedAt: Date | null; domainWarmupDays: number | null; domainWarmupDoneAt: Date | null;
  sent7: number; replies7: number; human7: number; bounces7: number; campaigns: number;
  smartleadTags: string[]; providerType: string | null; minWaitMins: number | null; dailySent: number | null;
  warmupMin: number | null; warmupReplyRate: number | null; warmupStatus: string | null;
  warmupTag: string | null; warmupRampupOn: boolean | null;
  change: { status: string; error: string | null; changes: Record<string, unknown> } | null;
  domainBornAt: Date | null; smartleadCreatedAt: Date | null; warmupBlockedReason: string | null; connectError: string | null;
  dnsSpf: boolean | null; dnsDkim: boolean | null; dnsDmarc: boolean | null; dnsMx: boolean | null; dnsCheckedAt: Date | null; nsAnswering: boolean | null;
  blDomain: number | null; blIp: number | null; blListings: { kind: string; list: string }[] | null; blCheckedAt: Date | null;
  /** The domain's order at its inbox provider; null when the provider's orders aren't synced. */
  domainOrder: OrderState | null; domainOrderStatus: string | null; domainProvider: string | null;
  /** All the domain's inboxes in Smartlead (not deleted), and how many are disconnected, whatever a view shows. */
  domainInboxes: number; domainDisconnected: number;
  /** Active, in grace, or still paid for: everything else stays out of the default view. */
  domainInScope: boolean;
};

/**
 * A domain's order at Hypertide or Icemail: active (Done at Hypertide, active
 * at Icemail), not done yet, cancelled (NPC or Cancelled), moved onto another
 * domain by a Hypertide replacement, or no live order at all.
 */
export type OrderState = "active" | "pending" | "cancelled" | "replaced" | "missing";

export async function listInboxes() {
  return sql<InboxListRow[]>`
    with ev as (
      select inbox_id,
        count(*) filter (where kind = 'sent')::int as sent7,
        count(*) filter (where kind = 'reply')::int as replies7,
        count(*) filter (where kind = 'reply' and reply_class::text in ('human', 'referral'))::int as human7,
        count(*) filter (where kind = 'bounce')::int as bounces7
      from email_events where occurred_at > now() - interval '7 days' and inbox_id is not null
      group by inbox_id
    ), camp as (
      select inbox_id, count(*)::int as n from campaign_inboxes group by inbox_id
    ), dom as (
      -- Every inbox on the domain, whatever the view shows.
      select domain_id, count(*)::int as n, count(*) filter (where status = 'disconnected')::int as disconnected
      from inboxes where status <> 'removed' group by domain_id
    ), ord as (
      -- A Done order wins over an older cancelled one for the same domain.
      -- Tenant default domains (*.onmicrosoft.com) never have an order of their own.
      select d.id as domain_id, v.name as provider, ho.status as order_status,
        case
          when d.name like '%.onmicrosoft.com' then null
          when v.name = 'Hypertide' then case
            when ho.status = 'Done' then 'active'
            when ho.status in ('NPC', 'Cancelled') then 'cancelled'
            when ho.status is not null then 'pending'
            when exists (select 1 from hypertide_orders o where o.replaced_domains @> array[d.name]) then 'replaced'
            when exists (select 1 from hypertide_orders) then 'missing'
          end
          when v.name = 'Icemail' then case
            when ix.active then 'active'
            when ix.found then 'pending'
            when exists (select 1 from icemail_accounts) then 'missing'
          end
        end as state
      from domains d
      join vendors v on v.id = d.inbox_provider_id
      left join lateral (
        select o.status from hypertide_orders o
        where v.name = 'Hypertide' and (o.domain_id = d.id or o.domain_name = d.name) and o.gone_at is null
        order by case when o.status = 'Done' then 0 when o.status in ('NPC', 'Cancelled') then 2 else 1 end, o.last_seen_at desc limit 1) ho on true
      left join lateral (
        select true as found, x.active from icemail_domains x
        where v.name = 'Icemail' and x.domain_id = d.id and x.gone_at is null
        order by x.active desc nulls last, x.last_seen_at desc limit 1) ix on true
      where exists (select 1 from inboxes i where i.domain_id = d.id and i.status <> 'removed')
    )
    select i.id, i.email, i.sender_name, i.status, i.warmup_enabled, i.warmup_per_day, i.warmup_rampup, i.daily_limit,
      i.warmup_reputation::float8 as warmup_reputation, i.smartlead_account_id, i.last_synced_at,
      d.id as domain_id, d.name as domain, d.status as domain_status, c.name as client_name, c.hue as client_hue,
      d.tags as domain_tags, grace_days_left(d.status, d.draining_since) as domain_grace_days_left, d.tld as domain_tld,
      d.warmup_started_at as domain_warmup_started_at, d.warmup_days as domain_warmup_days, d.warmup_done_at as domain_warmup_done_at,
      (select count(*)::int from alerts a where a.domain_id = d.id and a.status = 'open') as domain_alerts,
      coalesce(ev.sent7, 0) as sent7, coalesce(ev.replies7, 0) as replies7, coalesce(ev.human7, 0) as human7,
      coalesce(ev.bounces7, 0) as bounces7, coalesce(camp.n, i.campaign_count, 0) as campaigns,
      i.smartlead_tags, i.provider_type, i.min_wait_mins, i.daily_sent, i.warmup_min, i.warmup_reply_rate, i.warmup_status,
      i.warmup_tag, i.warmup_rampup_on,
      ch.change,
      coalesce(d.purchased_at, d.registered_at)::timestamptz as domain_born_at, i.smartlead_created_at, i.warmup_blocked_reason, i.connect_error,
      d.dns_spf, d.dns_dkim, d.dns_dmarc, d.dns_mx, d.dns_checked_at, d.nameservers_answering as ns_answering,
      d.blacklist_domain_count as bl_domain, d.blacklist_ip_count as bl_ip, d.blacklist_listings as bl_listings, d.blacklist_checked_at as bl_checked_at,
      ord.state as domain_order, ord.order_status as domain_order_status, ord.provider as domain_provider,
      dom.n as domain_inboxes, dom.disconnected as domain_disconnected,
      coalesce(st.current or st.order_live, false) as domain_in_scope
    from inboxes i join domains d on d.id = i.domain_id left join clients c on c.id = d.client_id
    left join domain_standing st on st.domain_id = d.id
    left join ev on ev.inbox_id = i.id
    left join camp on camp.inbox_id = i.id
    left join ord on ord.domain_id = d.id
    left join dom on dom.domain_id = d.id
    left join lateral (
      select jsonb_build_object('status', x.status, 'error', x.error, 'changes', x.changes) as change
      from inbox_setting_changes x where x.inbox_id = i.id and x.created_at > now() - interval '2 days'
      order by x.created_at desc limit 1) ch on true
    where i.status <> 'removed'
    order by d.name, i.email`;
}

export type PlanRow = {
  id: string; name: string; enabled: boolean; mode: "shuffle" | "random_total";
  totalMin: number; totalMax: number; inboxMin: number; inboxMax: number;
  clientId: string | null; clientName: string | null; clientHue: number | null; domainIds: string[];
  runHour: number; lastRunOn: string | null; lastResult: { asked: number; total: number; inboxes: number; clamped: boolean; min: number; max: number } | null;
  inboxes: number;
};

export async function listSendingPlans() {
  return sql<PlanRow[]>`
    select p.id, p.name, p.enabled, p.mode, p.total_min, p.total_max, p.inbox_min, p.inbox_max, p.client_id,
      c.name as client_name, c.hue as client_hue, p.domain_ids, p.run_hour, to_char(p.last_run_on, 'YYYY-MM-DD') as last_run_on, p.last_result,
      (select count(*)::int from inboxes i join domains d on d.id = i.domain_id
        where i.status = 'connected' and i.smartlead_account_id is not null
          and (p.client_id is null or (d.client_id = p.client_id and d.status in ('active', 'warming')))
          and (cardinality(p.domain_ids) = 0 or d.id = any(p.domain_ids))) as inboxes
    from sending_plans p left join clients c on c.id = p.client_id
    order by p.created_at`;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export type StatDomain = {
  /** Active or in its grace period today, and if not, why. */
  current: boolean; standing: import("./review").Standing | null;
  id: string; name: string; status: DomainStatus; clientId: string | null; clientName: string | null; clientHue: number | null;
  tags: string[]; inboxes: number; capacity: number;
  /** Sender names on the domain's connected inboxes, and their mail provider (Outlook, Google, SMTP). */
  senders: string[]; esp: string | null;
  /** The domain's own tags, then the Smartlead tags on its inboxes that aren't already among them. */
  allTags: string[];
  prevSent: number; prevReplies: number; prevHuman: number; prevBounces: number;
} & import("./smartlead-state").SlCounts;
/**
 * One domain on one day; only days with any activity. `replies` counts every
 * reply, out of office included; `slReplies` is Smartlead's own count, which
 * leaves out out-of-office replies.
 */
export type StatDay = { d: string; day: string; sent: number; replies: number; slReplies: number; human: number; ooo: number; negative: number; bounces: number; rep: number | null };
export type StatsData = { from: string; to: string; today: string; domains: StatDomain[]; days: StatDay[]; slSyncedAt: Date | null };

/**
 * Per-domain, per-day numbers for any range (up to 92 days), plus each
 * domain's totals for the same weekdays before (previousRange), for the change.
 */
export async function getStats(from: string, to: string): Promise<StatsData> {
  const [pf, pt] = previousRange(from, to);
  const [[{ today, slSyncedAt }], domains, days] = await Promise.all([
    sql<{ today: string; slSyncedAt: Date | null }[]>`
      select to_char((now() at time zone coalesce((select value #>> '{}' from settings where key = 'stats_timezone'), 'UTC'))::date, 'YYYY-MM-DD') as today,
        (select last_finished_at from job_state where job = 'smartlead-accounts') as sl_synced_at`,
    sql<StatDomain[]>`
      with r as (select ${from}::date as f, ${to}::date as t, ${pf}::date as pf, ${pt}::date as pt)
      select d.id, d.name, d.status, d.client_id, c.name as client_name, c.hue as client_hue, d.tags,
        (select count(*)::int from inboxes i where i.domain_id = d.id and i.status = 'connected') as inboxes,
        (select coalesce(sum(i.daily_limit), 0)::int from inboxes i where i.domain_id = d.id and i.status = 'connected') as capacity,
        (select coalesce(array_agg(distinct trim(i.sender_name) order by trim(i.sender_name)), '{}') from inboxes i
          where i.domain_id = d.id and i.status = 'connected' and trim(coalesce(i.sender_name, '')) <> '') as senders,
        (select case when count(distinct i.provider_type) > 1 then 'MIXED' else max(i.provider_type) end from inboxes i
          where i.domain_id = d.id and i.status = 'connected') as esp,
        coalesce(d.tags, '{}') || (select coalesce(array_agg(x.t order by x.n desc, x.t), '{}') from (
          select trim(t) as t, count(*) as n from inboxes i cross join unnest(i.smartlead_tags) t
          where i.domain_id = d.id and i.status <> 'removed' and trim(t) <> ''
            and lower(trim(t)) <> all (select lower(dt) from unnest(coalesce(d.tags, '{}')) dt) group by 1) x) as all_tags,
        coalesce(p.sent, 0) as prev_sent, coalesce(p.replies, 0) as prev_replies, coalesce(p.human, 0) as prev_human, coalesce(p.bounces, 0) as prev_bounces,
        sl.sl_connected, sl.sl_disconnected, sl.sl_removed, coalesce(st.current, false) as current, st.standing
      from domains d cross join r
      left join clients c on c.id = d.client_id
      left join domain_standing st on st.domain_id = d.id
      left join lateral (
      select count(*) filter (where i.status = 'connected')::int as sl_connected,
        count(*) filter (where i.status = 'disconnected')::int as sl_disconnected,
        count(*) filter (where i.status = 'removed')::int as sl_removed
      from inboxes i where i.domain_id = d.id) sl on true
      left join lateral (
        select sum(s.sent)::int as sent, sum(s.replies)::int as replies, sum(s.human_replies)::int as human, sum(s.bounces)::int as bounces
        from domain_daily_stats s where s.domain_id = d.id and s.day between r.pf and r.pt) p on true
      where d.status in ('warming', 'active', 'draining')
        or exists (select 1 from domain_daily_stats x where x.domain_id = d.id and (x.day between r.f and r.t or x.day between r.pf and r.pt))
      order by d.name`,
    sql<StatDay[]>`
      select s.domain_id as d, to_char(s.day, 'YYYY-MM-DD') as day, s.sent, s.replies, coalesce(x.replies, 0) as sl_replies,
        s.human_replies as human, s.ooo, s.negative, s.bounces, s.warmup_reputation::float8 as rep
      from domain_daily_stats s
      join domains dd on dd.id = s.domain_id
      left join smartlead_domain_daily x on x.domain_name = dd.name and x.day = s.day
      where s.day between ${from}::date and ${to}::date and (s.sent > 0 or s.replies > 0 or s.bounces > 0)
      order by s.day`,
  ]);
  return { from, to, today, domains, days, slSyncedAt };
}

export type ReplyRow = {
  id: number; occurredAt: Date; replyClass: import("./classify").ReplyClass | null; classOverridden: boolean;
  preview: string | null; leadEmail: string | null; inboxEmail: string | null; domainId: string | null; domain: string | null;
  campaignName: string | null; clientName: string | null; clientHue: number | null; recipientEsp: string | null;
};

/** One reply or bounce in full, for the detail panel: what they wrote and what was sent. */
export type EventDetail = { body: string | null; sent: string | null; sentSubject: string | null; notice: string | null; remote: string | null; ccs: string[] };

export async function getEventDetail(id: number): Promise<EventDetail | null> {
  const [r] = await sql<{ body: string | null; sent: string | null; sentSubject: string | null; notice: string | null; ccs: string | null; html: string | null }[]>`
    select coalesce(payload->>'reply_body', payload->'reply_message'->>'html', payload->'reply_message'->>'text') as body,
      coalesce(payload->'sent_message'->>'text', payload->>'sent_message_body') as sent,
      coalesce(payload->>'custom_subject', payload->>'subject', subject) as sent_subject,
      payload->'bounce_message'->>'text' as notice,
      payload->'bounce_message'->>'html' as html,
      (payload->'cc_emails')::text as ccs
    from email_events where id = ${id} and kind in ('reply', 'bounce')`;
  if (!r) return null;
  const { newText } = await import("./classify");
  // The receiving server's own error sits only in the HTML of Office 365 notices.
  const plain = r.html ? newText(r.html.replace(/&gt;/g, ">")) : "";
  const remote = plain.match(/Remote server returned an error.{0,300}?(?= Message rejected by| Notification Details|$)/i)?.[0] ?? null;
  let ccs: string[] = [];
  try { const v = JSON.parse(r.ccs ?? "null"); if (Array.isArray(v)) ccs = v.map(String); } catch { /* not a list */ }
  return {
    body: r.body ? newText(r.body) : null,
    sent: r.sent ? r.sent.replace(/\r/g, "").trim() : null,
    sentSubject: r.sentSubject,
    notice: r.notice ? r.notice.replace(/\r/g, "").trim() : null,
    remote,
    ccs,
  };
}

/** Monday to today, in the stats timezone. */
export async function thisWeek() {
  const { to } = await lastDays(1);
  return { from: monday(to), to };
}

/** The last n days in the stats timezone, today included. */
export async function lastDays(n: number) {
  const [r] = await sql<{ from: string; to: string }[]>`
    with t as (select (now() at time zone coalesce((select value #>> '{}' from settings where key = 'stats_timezone'), 'UTC'))::date as d)
    select to_char(d - ${n - 1}::int, 'YYYY-MM-DD') as from, to_char(d, 'YYYY-MM-DD') as to from t`;
  return r;
}

/** A reply or bounce for the client → domain views. */
export type EventRow = {
  id: number; occurredAt: Date; replyClass: ReplyRow["replyClass"]; classOverridden: boolean;
  preview: string | null; subject: string | null; leadEmail: string | null; leadName: string | null; inboxEmail: string | null;
  domainId: string | null; domain: string | null; campaignName: string | null; sequence: number | null;
  clientId: string | null; clientName: string | null; clientHue: number | null; recipientEsp: string | null;
  /** Smartlead's master-inbox link for the lead. */
  link: string | null;
  /** The bounce notice's text (bounces only), shortened. */
  bounceText: string | null;
  /** The receiving server's error quoted in the notice's HTML, e.g. "553 … badmailfrom list (#5.7.1)". */
  bounceRemote: string | null;
  /** Why it bounced, worked out when it arrived (bounces only; older ones until the bounce_causes job reaches them). */
  bounceCause: import("./bounces").BounceReason | null;
  /** Is the sending domain active or in its grace period today? */
  current: boolean;
};
export type EventsData = { from: string; to: string; today: string; events: EventRow[]; sent: Record<string, number>; currentDomains: string[] };

/**
 * Replies or bounces between two days (inclusive, in the stats timezone),
 * with each domain's sent count for the same days so rates can be shown.
 */
export async function getEvents(kind: "reply" | "bounce", from: string, to: string): Promise<EventsData> {
  const [[t], events, sent] = await Promise.all([
    sql<{ today: string }[]>`
      select to_char((now() at time zone coalesce((select value #>> '{}' from settings where key = 'stats_timezone'), 'UTC'))::date, 'YYYY-MM-DD') as today`,
    sql<EventRow[]>`
      with tz as (select coalesce((select value #>> '{}' from settings where key = 'stats_timezone'), 'UTC') as z)
      select e.id, e.occurred_at, e.reply_class, e.class_overridden, e.preview, e.subject, e.lead_email,
        nullif(trim(e.payload->>'to_name'), '') as lead_name, e.inbox_email,
        e.domain_id, coalesce(d.name, e.domain_name) as domain, e.campaign_name, e.sequence_number as sequence,
        coalesce(d.client_id, e.client_id) as client_id, c.name as client_name, c.hue as client_hue, e.recipient_esp, e.bounce_cause,
        coalesce(st.current, false) as current,
        coalesce(e.payload->>'ui_master_inbox_link', e.payload->>'app_url') as link,
        case when e.kind = 'bounce' then left(coalesce(e.payload->'bounce_message'->>'text', e.payload->>'description'), 600) end as bounce_text,
        -- Office 365 quotes the receiving server's own error only in the HTML version.
        case when e.kind = 'bounce' then left(replace(substring(regexp_replace(coalesce(e.payload->'bounce_message'->>'html', ''), '<[^>]+>', ' ', 'g')
          from '(?:Remote server returned an error|[[:<:]]Error:[[:space:]]+[45][0-9]{2}[ -]).{0,250}'), '&gt;', '>'), 300) end as bounce_remote
      from email_events e cross join tz
      -- The sending domain's client, as on every other page; the event's own only when the domain has none.
      left join domains d on d.id = e.domain_id left join clients c on c.id = coalesce(d.client_id, e.client_id)
      left join domain_standing st on st.domain_id = e.domain_id
      where e.kind = ${kind}::event_kind
        and (e.occurred_at at time zone tz.z)::date between ${from}::date and ${to}::date
      order by e.occurred_at desc
      limit 5000`,
    sql<{ domainId: string; sent: number; current: boolean }[]>`
      select s.domain_id, sum(s.sent)::int as sent, coalesce(bool_or(st.current), false) as current from domain_daily_stats s
      left join domain_standing st on st.domain_id = s.domain_id
      where s.day between ${from}::date and ${to}::date group by s.domain_id`,
  ]);
  return { from, to, today: t.today, events, sent: Object.fromEntries(sent.map((s) => [s.domainId, s.sent])), currentDomains: sent.filter((s) => s.current).map((s) => s.domainId) };
}

/**
 * Everything the weekly review judges, per domain: the range's numbers, the
 * same weekdays before (previousRange), why its bounces happened, and its
 * inboxes. Plus each campaign's bounces, to spot lists that need re-verifying.
 */
export async function getReview(from: string, to: string): Promise<import("./review").ReviewData> {
  const [pf, pt] = previousRange(from, to);
  const [[t], domains, campaigns] = await Promise.all([
    sql<{ today: string; slSyncedAt: Date | null }[]>`
      select to_char((now() at time zone coalesce((select value #>> '{}' from settings where key = 'stats_timezone'), 'UTC'))::date, 'YYYY-MM-DD') as today,
        (select last_finished_at from job_state where job = 'smartlead-accounts') as sl_synced_at`,
    sql<import("./review").ReviewDomain[]>`
      with tz as (select coalesce((select value #>> '{}' from settings where key = 'stats_timezone'), 'UTC') as z),
      cur as (
        select domain_id, sum(sent)::int as sent, sum(replies)::int as replies, sum(human_replies)::int as human, sum(bounces)::int as bounces,
          sum(ooo)::int as ooo, sum(auto_replies)::int as auto, sum(negative)::int as negative
        from domain_daily_stats where day between ${from}::date and ${to}::date group by 1),
      prev as (
        select domain_id, sum(sent)::int as sent, sum(human_replies)::int as human, sum(replies)::int as replies, sum(bounces)::int as bounces
        from domain_daily_stats where day between ${pf}::date and ${pt}::date group by 1),
      ev as (
        select e.domain_id,
          jsonb_object_agg(e.cause, e.n) filter (where e.cur) as causes,
          coalesce(sum(e.n) filter (where not e.cur and e.cause in ('spam', 'blocklist')), 0)::int as prev_spam
        from (
          select domain_id, coalesce(bounce_cause, 'other') as cause, (occurred_at at time zone tz.z)::date >= ${from}::date as cur, count(*)::int as n
          from email_events cross join tz
          where kind = 'bounce' and domain_id is not null
            and (occurred_at at time zone tz.z)::date between ${pf}::date and ${to}::date
            and ((occurred_at at time zone tz.z)::date <= ${pt}::date or (occurred_at at time zone tz.z)::date >= ${from}::date)
          group by 1, 2, 3) e
        group by 1),
      rep as (
        select domain_id, round(avg(warmup_reputation), 1)::float8 as rep, (count(*) filter (where warmup_reputation < 90))::int as low
        from inboxes where status = 'connected' and warmup_reputation is not null group by 1),
      -- Any reply counts, out of office included: it shows the mail reached an
      -- inbox. Replies are on record from the first day one came in.
      since as (select min(day) as day from domain_daily_stats where replies > 0),
      hr as (
        select domain_id, max(day) filter (where replies > 0) as last_reply, min(day) filter (where sent > 0) as first_sent
        from domain_daily_stats where day <= ${to}::date group by 1),
      quiet as (
        select hr.domain_id, hr.last_reply is null as never,
          (${to}::date - coalesce(hr.last_reply, greatest(hr.first_sent, since.day)))::int as days,
          (select coalesce(sum(s.sent), 0)::int from domain_daily_stats s
            where s.domain_id = hr.domain_id and s.day <= ${to}::date and s.day > coalesce(hr.last_reply, '-infinity'::date)) as sent_since
        from hr cross join since where hr.first_sent is not null)
      select d.id, d.name, d.status::text as status, d.client_id, c.name as client_name, c.hue as client_hue, d.tags,
        (select count(*)::int from inboxes i where i.domain_id = d.id and i.status = 'connected') as inboxes,
        (select count(*)::int from inboxes i where i.domain_id = d.id and i.status = 'disconnected') as disconnected,
        (coalesce(d.blacklist_domain_count, 0) + coalesce(d.blacklist_ip_count, 0))::int as blacklisted,
        coalesce(cur.sent, 0) as sent, coalesce(cur.replies, 0) as replies, coalesce(cur.human, 0) as human, coalesce(cur.bounces, 0) as bounces,
        coalesce(cur.ooo, 0) as ooo, coalesce(cur.auto, 0) as auto, coalesce(cur.negative, 0) as negative,
        coalesce(ev.causes, '{}'::jsonb) as causes,
        coalesce(prev.sent, 0) as prev_sent, coalesce(prev.human, 0) as prev_human, coalesce(prev.replies, 0) as prev_replies, coalesce(prev.bounces, 0) as prev_bounces, coalesce(ev.prev_spam, 0) as prev_spam,
        -- How old the domain is, and how long it has been in Smartlead.
        (current_date - coalesce(d.purchased_at, d.registered_at)::date)::int as age_days,
        (select (current_date - min(i.smartlead_created_at)::date)::int from inboxes i where i.domain_id = d.id and i.status <> 'removed') as connected_days,
        st.provider, st.standing, st.grace_left,
        rep.rep, coalesce(rep.low, 0) as low_rep_inboxes,
        quiet.days as quiet_days, coalesce(quiet.never, false) as never_replied, coalesce(quiet.sent_since, 0) as sent_since_reply,
        (select coalesce(array_agg(x.t order by x.n desc, x.t), '{}') from (
          select trim(t) as t, count(*) as n from inboxes i cross join unnest(i.smartlead_tags) t
          where i.domain_id = d.id and i.status <> 'removed' and trim(t) <> '' group by 1) x) as sl_tags,
        (select case when count(distinct i.provider_type) > 1 then 'MIXED' else max(i.provider_type) end from inboxes i
          where i.domain_id = d.id and i.status <> 'removed') as esp, d.tld,
        rp.name as replaced_by,
        -- Where the order stands at the domain's provider, Hypertide or Icemail. NPC is what
        -- Hypertide's dashboard shows as Cancelled. "none": no order on this account.
        case when rp.name is not null then 'replaced'
          when st.order_state = 'cancelled' then 'cancelled'
          when st.order_state = 'gone' then 'gone'
          when st.order_state in ('active', 'pending') then 'live'
          when st.order_state = 'missing' then 'none'
        end as ht,
        sl.sl_removed as removed
      from domains d
      left join clients c on c.id = d.client_id
      join domain_standing st on st.domain_id = d.id
      left join lateral (
      select count(*) filter (where i.status = 'connected')::int as sl_connected,
        count(*) filter (where i.status = 'disconnected')::int as sl_disconnected,
        count(*) filter (where i.status = 'removed')::int as sl_removed
      from inboxes i where i.domain_id = d.id) sl on true
      left join lateral (
        select coalesce(
          (select nd.name from replacement_items ri
            join replacement_batches rb on rb.id = ri.batch_id join domains nd on nd.id = ri.new_domain_id
            where ri.old_domain_id = d.id and rb.status <> 'cancelled' order by ri.created_at desc limit 1),
          (select o.domain_name from hypertide_orders o where o.replaced_domains @> array[d.name] order by o.last_seen_at desc limit 1)) as name) rp on true
      left join cur on cur.domain_id = d.id
      left join prev on prev.domain_id = d.id
      left join ev on ev.domain_id = d.id
      left join rep on rep.domain_id = d.id
      left join quiet on quiet.domain_id = d.id
      -- Live today, or anything that has numbers in this range: the page splits them.
      where st.current or cur.sent > 0 or cur.replies > 0 or cur.bounces > 0
      order by d.name`,
    sql<import("./review").ReviewCampaign[]>`
      with tz as (select coalesce((select value #>> '{}' from settings where key = 'stats_timezone'), 'UTC') as z)
      select e.campaign_id::int as id, max(e.campaign_name) as name, max(c.name) as client_name,
        count(*)::int as bounces, (count(*) filter (where e.bounce_cause = 'missing'))::int as missing
      from email_events e cross join tz
      left join domains d on d.id = e.domain_id left join clients c on c.id = coalesce(d.client_id, e.client_id)
      where e.kind = 'bounce' and e.campaign_id is not null
        and (e.occurred_at at time zone tz.z)::date between ${from}::date and ${to}::date
      group by e.campaign_id`,
  ]);
  return { from, to, today: t.today, slSyncedAt: t.slSyncedAt, domains, campaigns };
}

/** Each domain's numbers per day, for the trend lines on Compare. Only days with something on them. */
export type CompareDay = {
  domainId: string; day: string; sent: number; replies: number; human: number; ooo: number; auto: number; bounces: number; blocked: number; rep: number | null;
};
export async function getCompareDaily(from: string, to: string): Promise<CompareDay[]> {
  return sql<CompareDay[]>`
    with tz as (select coalesce((select value #>> '{}' from settings where key = 'stats_timezone'), 'UTC') as z),
    blocked as (
      select e.domain_id, (e.occurred_at at time zone tz.z)::date as day, count(*)::int as n
      from email_events e cross join tz
      where e.kind = 'bounce' and e.bounce_cause in ('spam', 'blocklist') and e.domain_id is not null
        and (e.occurred_at at time zone tz.z)::date between ${from}::date and ${to}::date
      group by 1, 2)
    select s.domain_id, to_char(s.day, 'YYYY-MM-DD') as day, s.sent, s.replies, s.human_replies as human, s.ooo, s.auto_replies as auto, s.bounces, coalesce(b.n, 0) as blocked, s.warmup_reputation as rep
    from domain_daily_stats s left join blocked b on b.domain_id = s.domain_id and b.day = s.day
    where s.day between ${from}::date and ${to}::date and (s.sent > 0 or s.replies > 0 or s.bounces > 0 or s.warmup_reputation is not null)`;
}

export type ClientSendingRow = {
  id: string; name: string; hue: number; promisedDaily: number | null; sendWeekends: boolean;
  domains: number; inboxes: number; capacity: number; disconnected: number; lostCapacity: number;
};
export type ClientDomainRow = {
  id: string; name: string; status: string; standing: import("./review").Standing | null; current: boolean; provider: string | null;
  sent: number; /** Finished days only, to set against the days before. */ sentFinished: number; prevSent: number;
  human: number; bounces: number; inboxes: number; disconnected: number; capacity: number; tags: string[];
};
export type ClientSendingData = {
  client: ClientSendingRow; from: string; to: string; today: string;
  /** The finished days of the range and the same weekdays before them. */ prevFrom: string | null; prevTo: string | null;
  days: import("./client-sending").SendDay[]; prevDays: { day: string; sent: number }[]; domains: ClientDomainRow[];
};

const clientRows = (where: { id?: string }) => sql<ClientSendingRow[]>`
  select c.id, c.name, c.hue, c.promised_daily, c.send_weekends,
    (select count(*)::int from domains d join domain_standing st on st.domain_id = d.id where d.client_id = c.id and d.status = 'active' and st.current) as domains,
    k.inboxes, k.capacity, k.disconnected, k.lost_capacity
  from clients c
  left join lateral (
    select count(*) filter (where i.status = 'connected' and st.current)::int as inboxes,
      coalesce(sum(i.daily_limit) filter (where i.status = 'connected' and st.current), 0)::int as capacity,
      -- Down but paid for: reconnecting these is the quickest way to get volume back.
      count(*) filter (where i.status = 'disconnected' and st.order_live)::int as disconnected,
      coalesce(sum(i.daily_limit) filter (where i.status = 'disconnected' and st.order_live), 0)::int as lost_capacity
    from inboxes i join domains d on d.id = i.domain_id join domain_standing st on st.domain_id = d.id
    where d.client_id = c.id and d.status = 'active') k on true
  where c.archived_at is null ${where.id ? sql`and c.id = ${where.id}` : sql``}
  order by c.name`;

/** Every client with what it was promised and the last 28 days it sent, on any domain. */
export async function getClientsSending() {
  const { to: today } = await lastDays(1);
  const from = addDays(today, -28);
  const [clients, days] = await Promise.all([
    clientRows({}),
    sql<{ clientId: string; day: string; sent: number }[]>`
      select d.client_id, to_char(s.day, 'YYYY-MM-DD') as day, sum(s.sent)::int as sent
      from domain_daily_stats s join domains d on d.id = s.domain_id
      where d.client_id is not null and s.day >= ${from}::date and s.day <= ${today}::date
      group by 1, 2`,
  ]);
  return { today, from, clients, days };
}

/** One client's sending per day and by domain, with the same weekdays before to compare with. */
export async function getClientSending(id: string, from: string, to: string): Promise<ClientSendingData | null> {
  const { to: today } = await lastDays(1);
  const [client] = await clientRows({ id });
  if (!client) return null;
  // Today isn't over, so it would read as a drop against a full day last week.
  const last = to >= today ? addDays(today, -1) : to;
  const prev = last >= from ? previousRange(from, last) : null;
  const [days, prevDays, domains] = await Promise.all([
    sql<import("./client-sending").SendDay[]>`
      select to_char(g.day, 'YYYY-MM-DD') as day, coalesce(sum(s.sent), 0)::int as sent, coalesce(sum(s.replies), 0)::int as replies,
        coalesce(sum(s.human_replies), 0)::int as human, coalesce(sum(s.bounces), 0)::int as bounces,
        (count(s.domain_id) filter (where s.sent > 0))::int as senders
      from generate_series(${from}::date, ${to}::date, interval '1 day') g(day)
      left join (domain_daily_stats s join domains d on d.id = s.domain_id and d.client_id = ${id}) on s.day = g.day::date
      group by g.day order by g.day`,
    prev ? sql<{ day: string; sent: number }[]>`
      select to_char(g.day, 'YYYY-MM-DD') as day, coalesce(sum(s.sent), 0)::int as sent
      from generate_series(${prev[0]}::date, ${prev[1]}::date, interval '1 day') g(day)
      left join (domain_daily_stats s join domains d on d.id = s.domain_id and d.client_id = ${id}) on s.day = g.day::date
      group by g.day order by g.day` : Promise.resolve([]),
    sql<ClientDomainRow[]>`
      with m as (
        select s.domain_id,
          coalesce(sum(s.sent) filter (where s.day between ${from}::date and ${to}::date), 0)::int as sent,
          coalesce(sum(s.sent) filter (where s.day between ${from}::date and ${last}::date), 0)::int as sent_finished,
          coalesce(sum(s.sent) filter (where ${prev?.[0] ?? null}::date is not null and s.day between ${prev?.[0] ?? null}::date and ${prev?.[1] ?? null}::date), 0)::int as prev_sent,
          coalesce(sum(s.human_replies) filter (where s.day between ${from}::date and ${to}::date), 0)::int as human,
          coalesce(sum(s.bounces) filter (where s.day between ${from}::date and ${to}::date), 0)::int as bounces
        from domain_daily_stats s join domains x on x.id = s.domain_id
        where x.client_id = ${id} and s.day >= least(${from}::date, coalesce(${prev?.[0] ?? null}::date, ${from}::date)) and s.day <= ${to}::date
        group by 1)
      select d.id, d.name, d.status::text as status, st.standing, st.current, st.provider,
        coalesce(m.sent, 0) as sent, coalesce(m.sent_finished, 0) as sent_finished, coalesce(m.prev_sent, 0) as prev_sent,
        coalesce(m.human, 0) as human, coalesce(m.bounces, 0) as bounces,
        (select count(*)::int from inboxes i where i.domain_id = d.id and i.status = 'connected') as inboxes,
        (select count(*)::int from inboxes i where i.domain_id = d.id and i.status = 'disconnected') as disconnected,
        (select coalesce(sum(i.daily_limit), 0)::int from inboxes i where i.domain_id = d.id and i.status = 'connected') as capacity,
        (select coalesce(array_agg(distinct x.t), '{}') from (
          select trim(t) as t from unnest(d.tags) t
          union select trim(t) from inboxes i cross join unnest(i.smartlead_tags) t where i.domain_id = d.id and i.status <> 'removed') x where x.t <> '') as tags
      from domains d join domain_standing st on st.domain_id = d.id
      left join m on m.domain_id = d.id
      where d.client_id = ${id} and (st.current or m.sent > 0 or m.prev_sent > 0)
      order by coalesce(m.sent, 0) desc, d.name`,
  ]);
  return { client, from, to, today, prevFrom: prev?.[0] ?? null, prevTo: prev?.[1] ?? null, days, prevDays, domains };
}

/** One domain's bounces in a range, for Performance. */
export async function getBounceDetail(domainId: string, from: string, to: string): Promise<import("./bounce-detail").BounceDetail> {
  const events = await sql<import("./bounce-detail").BounceEvent[]>`
    with tz as (select coalesce((select value #>> '{}' from settings where key = 'stats_timezone'), 'UTC') as z)
    select e.bounce_cause as cause, e.occurred_at as at, e.campaign_id::int as campaign_id, e.campaign_name, e.recipient_esp as esp,
      left(coalesce(e.payload->'bounce_message'->>'text', e.payload->>'description', e.payload->>'bounce_reason'), 600) as text,
      left(replace(substring(regexp_replace(coalesce(e.payload->'bounce_message'->>'html', ''), '<[^>]+>', ' ', 'g')
        from '(?:Remote server returned an error|[[:<:]]Error:[[:space:]]+[45][0-9]{2}[ -]).{0,250}'), '&gt;', '>'), 300) as remote
    from email_events e cross join tz
    where e.kind = 'bounce' and e.domain_id = ${domainId}
      and (e.occurred_at at time zone tz.z)::date between ${from}::date and ${to}::date
    order by e.occurred_at desc
    limit 2000`;
  const { summarizeBounces } = await import("./bounce-detail");
  return summarizeBounces(events);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings() {
  // Read as text: the camel transform would rename keys inside the JSON
  // (forwarding_domain → forwardingDomain) and the template would look empty.
  const rows = await sql<{ key: string; value: string }[]>`select key, value::text as value from settings`;
  const map = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value) as unknown]));
  return {
    drainDays: Number(map.drain_days ?? 7),
    clientSource: map.client_source === "mapped" ? ("mapped" as const) : ("tags" as const),
    warmupProgram: parseWarmupProgram(map.warmup_program),
    clientTagList: parseSavedPairs(map.client_tag_list),
    storageLowThreshold: Number(map.storage_low_threshold ?? 20),
    reuseAfterDays: Number(map.reuse_after_days ?? 120),
    inboxLimit: Number(map.inbox_limit ?? 60) || 60,
    hypertideNameservers: Array.isArray(map.hypertide_nameservers) ? (map.hypertide_nameservers as string[]) : [],
    hypertideTemplate: {
      plan: (map.hypertide_order_template as { plan?: string })?.plan === "google" ? ("google" as const) : ("entra" as const),
      inbox_quantity: (map.hypertide_order_template as { inbox_quantity?: number })?.inbox_quantity === 25 ? (25 as const) : (50 as const),
      forwarding_domain: String((map.hypertide_order_template as { forwarding_domain?: string })?.forwarding_domain ?? ""),
      client_name: String((map.hypertide_order_template as { client_name?: string })?.client_name ?? ""),
    },
  };
}

export type JobStateRow = { job: string; lastStartedAt: Date | null; lastFinishedAt: Date | null; lastOk: boolean | null; lastError: string | null; lastDetail: Record<string, unknown> | null };

export async function listJobState() {
  return sql<JobStateRow[]>`select job, last_started_at, last_finished_at, last_ok, last_error, last_detail from job_state`;
}

/** Registrar accounts added in Settings, without their keys. */
export type RegistrarAccountRow = {
  id: string; provider: import("@/lib/registrar-providers").Provider; label: string; keyHint: string | null;
  createdBy: string; createdAt: Date; lastSyncedAt: Date | null; lastOk: boolean | null; lastError: string | null; domains: number;
};

export async function listRegistrarAccounts() {
  return sql<RegistrarAccountRow[]>`
    select a.id, a.provider, a.label, a.key_hint, a.created_by, a.created_at, a.last_synced_at, a.last_ok, a.last_error,
      (select count(*)::int from domains d where d.registrar_account_id = a.id) as domains
    from registrar_accounts a order by a.provider, a.created_at`;
}

export type IcemailAccountRow = {
  id: string; label: string; keyHint: string | null; workspaceName: string | null; webhookToken: string;
  walletBalance: number | null; walletCurrency: string | null;
  lastSyncedAt: Date | null; lastOk: boolean | null; lastError: string | null;
  domains: number; mailboxes: number; linked: number; monthly: number;
  /** Mailboxes billing in the next 7 days, and what they cost then. */
  renewing: number; renewingCost: number;
  events: { id: number; event: string; receivedAt: Date; data: Record<string, unknown> | null }[];
};

export async function listIcemailAccounts() {
  return sql<IcemailAccountRow[]>`
    select a.id, a.label, a.key_hint, a.workspace_name, a.webhook_token,
      a.wallet_balance::float8 as wallet_balance, a.wallet_currency, a.last_synced_at, a.last_ok, a.last_error,
      (select count(*)::int from icemail_domains x where x.account_id = a.id and x.gone_at is null) as domains,
      coalesce(m.mailboxes, 0) as mailboxes, coalesce(m.linked, 0) as linked, coalesce(m.monthly, 0) as monthly,
      coalesce(m.renewing, 0) as renewing, coalesce(m.renewing_cost, 0) as renewing_cost,
      coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'event', e.event, 'receivedAt', e.received_at, 'data', e.payload -> 'data') order by e.received_at desc)
        from (select * from icemail_events e where e.account_id = a.id order by e.received_at desc limit 6) e), '[]'::jsonb) as events
    from icemail_accounts a
    left join lateral (
      select count(*)::int as mailboxes, (count(*) filter (where x.inbox_id is not null))::int as linked,
        coalesce(sum(case when x.billing_cycle = 'YEARLY' then x.cost / 12 else x.cost end), 0)::float8 as monthly,
        (count(*) filter (where x.next_billing_on between current_date and current_date + 7))::int as renewing,
        coalesce(sum(x.cost) filter (where x.next_billing_on between current_date and current_date + 7), 0)::float8 as renewing_cost
      from icemail_mailboxes x where x.account_id = a.id and x.gone_at is null) m on true
    order by a.created_at`;
}

// ---------------------------------------------------------------------------
// Overview insights
// ---------------------------------------------------------------------------

export type Issues = {
  flagged: number; dead: number; noZone: number; disconnected: number; lowRep: number; htUnpaid: number; htCancelledLive: number;
  billedRetired: number; expiredInUse: number; expiringNoRenew: number; expiring30: number; readyForCampaigns: number; nsFailed: number; settingsFailed: number; stuckSetup: number; freeLow: boolean; free: number;
};
export type ClientInsight = {
  id: string; name: string; hue: number; active: number; warming: number; inboxes: number; capacity: number;
  sent: number; replies: number; human: number; bounces: number; sentPrev: number;
  promisedDaily: number | null; sendWeekends: boolean; sentYesterday: number; yesterday: string;
};
export type TrendDay = { day: string; sent: number; replies: number; human: number; bounces: number };

export type DeadDomainRow = {
  domainId: string; name: string; status: DomainStatus; tld: string | null;
  clientName: string | null; clientHue: number | null; inboxProvider: string | null;
  cause: import("./dead").DeadCause; connected: number; disconnected: number; removed: number;
  providerType: string | null; lastSendDay: Date | null;
};

/** Active domains nothing can send from, worst first: those still in campaigns (connected, DNS gone) lead. */
export async function listDeadDomains() {
  return sql<DeadDomainRow[]>`
    select x.domain_id, d.name, d.status, d.tld, c.name as client_name, c.hue as client_hue, ip.name as inbox_provider,
      x.cause, x.connected, x.disconnected, x.removed, x.provider_type, x.last_send_day
    from live_dead_domains x join domains d on d.id = x.domain_id
    left join clients c on c.id = d.client_id
    left join vendors ip on ip.id = d.inbox_provider_id
    order by (x.cause = 'dns_gone') desc, x.cause, x.last_send_day desc nulls last, d.name`;
}

export type ConnectionRow = {
  provider: string; name: string; domainId: string | null; clientName: string | null; clientHue: number | null; state: ConnectionProblem;
  connected: number; disconnected: number; removed: number; warmupOff: number; warmupBlocked: number;
};
export type ConnectionProvider = { provider: string; orders: number; connected: number; ok: number; problems: number; settingUp: number; retiring: number };
export type ConnectionCheckData = {
  providers: ConnectionProvider[]; problems: ConnectionRow[]; withoutOrder: number;
  syncs: { label: string; at: Date | null; stale: boolean }[];
};

/**
 * Active orders against Smartlead: how many of each provider's are connected and
 * warming, the domains that aren't, and whether the syncs behind this are running.
 * A sync counts as stale once it has failed or missed a few runs.
 */
export async function getConnectionCheck(): Promise<ConnectionCheckData> {
  const [providers, problems, [extra], jobs] = await Promise.all([
    sql<ConnectionProvider[]>`
      select provider, count(*)::int as orders,
        count(*) filter (where state in ('ok', 'warmup_off', 'warmup_blocked', 'dns_gone'))::int as connected,
        count(*) filter (where state = 'ok')::int as ok,
        count(*) filter (where problem)::int as problems,
        count(*) filter (where state = 'setting_up')::int as setting_up,
        count(*) filter (where state = 'retiring')::int as retiring
      from order_connections group by provider order by provider`,
    sql<ConnectionRow[]>`
      select x.provider, x.name, x.domain_id, c.name as client_name, c.hue as client_hue, x.state,
        x.connected, x.disconnected, x.removed, x.warmup_off, x.warmup_blocked
      from order_connections x
      left join domains d on d.id = x.domain_id
      left join clients c on c.id = d.client_id
      where x.problem order by x.provider, x.state, x.name`,
    sql<{ withoutOrder: number }[]>`
      select count(*)::int as without_order from domains d
      where d.status in ('active', 'warming') and d.name !~ '\.onmicrosoft\.com$'
        and exists (select 1 from inboxes i where i.domain_id = d.id and i.status = 'connected')
        and not exists (select 1 from order_connections x where x.domain_id = d.id)`,
    sql<{ job: string; at: Date | null; stale: boolean }[]>`
      select job, last_finished_at as at,
        last_ok is not true or last_finished_at < now() - case job when 'hypertide-orders' then interval '30 minutes' else interval '2 hours' end as stale
      from job_state where job in ('hypertide-orders', 'smartlead-accounts', 'icemail')`,
  ]);
  const job = (name: string, label: string) => {
    const j = jobs.find((x) => x.job === name);
    return { label, at: j?.at ?? null, stale: j?.stale ?? true };
  };
  const has = (p: string) => providers.some((x) => x.provider === p);
  const syncs = [
    job("smartlead-accounts", "Smartlead"),
    ...(has("Hypertide") ? [job("hypertide-orders", "Hypertide")] : []),
    ...(has("Icemail") ? [job("icemail", "Icemail")] : []),
  ];
  return { providers, problems, withoutOrder: extra.withoutOrder, syncs };
}

export async function getInsights() {
  const [[issues], [cap], clients, trend] = await Promise.all([
    sql<Issues[]>`
      select
        (select count(distinct a.domain_id)::int from alerts a join domain_standing st on st.domain_id = a.domain_id
          where a.status = 'open' and st.current) as flagged,
        (select count(*)::int from live_dead_domains) as dead,
        (select count(*)::int from domains d join domain_standing st on st.domain_id = d.id where d.nameservers_answering = false and (st.current or st.order_live)) as no_zone,
        (select count(*)::int from inboxes i join domain_standing st on st.domain_id = i.domain_id where i.status = 'disconnected' and (st.current or st.order_live)) as disconnected,
        (select count(*)::int from inboxes i join domain_standing st on st.domain_id = i.domain_id where i.status = 'connected' and i.warmup_reputation < 90 and st.current) as low_rep,
        (select count(*)::int from hypertide_orders where gone_at is null and payment_status not ilike 'paid%' and payment_status not ilike '%recovery%') as ht_unpaid,
        (select count(distinct o.domain_id)::int from hypertide_orders o join domains d on d.id = o.domain_id
          join domain_standing st on st.domain_id = d.id
          where o.gone_at is null and o.status in ('NPC', 'Cancelled') and st.connected > 0 and st.standing <> 'grace'
          and d.status in ('active', 'warming', 'provisioning')
          and not exists (select 1 from hypertide_orders o2 where o2.domain_id = d.id and o2.gone_at is null and coalesce(o2.status, '') not in ('NPC', 'Cancelled'))) as ht_cancelled_live,
        (select count(distinct o.domain_id)::int from hypertide_orders o join domains d on d.id = o.domain_id
          where o.gone_at is null and o.status = 'Done' and d.status in ('burned', 'resting')) as billed_retired,
        (select count(*)::int from domains d where d.status in ('active', 'warming', 'provisioning') and d.expires_at < current_date) as expired_in_use,
        (select count(*)::int from domains d where d.status in ('active', 'warming', 'provisioning') and d.expires_at between current_date and current_date + 14 and d.auto_renew is not true
          and not exists (select 1 from replacement_items ri join replacement_batches rb on rb.id = ri.batch_id where ri.old_domain_id = d.id and rb.status <> 'cancelled')) as expiring_no_renew,
        (select count(*)::int from domains d where d.status in ('active', 'warming', 'provisioning') and d.expires_at between current_date and current_date + 30) as expiring30,
        (select count(*)::int from replacement_readiness where ready) as ready_for_campaigns,
        (select count(*)::int from nameserver_requests where status = 'failed' and created_at > now() - interval '7 days') as ns_failed,
        (select count(distinct inbox_id)::int from inbox_setting_changes where status = 'failed' and created_at > now() - interval '2 days') as settings_failed,
        (select count(*)::int from domains d where d.status = 'provisioning'
          and coalesce((select max(h.at) from domain_status_history h where h.domain_id = d.id), d.created_at) < now() - interval '10 days') as stuck_setup,
        (select count(*)::int from domains d where domain_is_free(d)) as free,
        (select count(*) from domains d where domain_is_free(d)) <= coalesce((select (value #>> '{}')::int from settings where key = 'storage_low_threshold'), 20) as free_low`,
    sql<{ capacity: number; sentToday: number; inboxes: number }[]>`
      select coalesce(sum(i.daily_limit), 0)::int as capacity, coalesce(sum(i.daily_sent), 0)::int as sent_today, count(*)::int as inboxes
      from inboxes i join domains d on d.id = i.domain_id join domain_standing st on st.domain_id = d.id
      where i.status = 'connected' and d.status = 'active' and st.current`,
    sql<ClientInsight[]>`
      select c.id, c.name, c.hue,
        count(distinct d.id) filter (where d.status = 'active' and st.current)::int as active,
        count(distinct d.id) filter (where d.status = 'provisioning' or (d.status = 'warming' and st.current))::int as warming,
        (select count(*)::int from inboxes i join domains x on x.id = i.domain_id join domain_standing y on y.domain_id = x.id where x.client_id = c.id and i.status = 'connected' and x.status = 'active' and y.current) as inboxes,
        (select coalesce(sum(i.daily_limit), 0)::int from inboxes i join domains x on x.id = i.domain_id join domain_standing y on y.domain_id = x.id where x.client_id = c.id and i.status = 'connected' and x.status = 'active' and y.current) as capacity,
        coalesce(sum(s.sent) filter (where s.day > current_date - 7), 0)::int as sent,
        coalesce(sum(s.replies) filter (where s.day > current_date - 7), 0)::int as replies,
        coalesce(sum(s.human_replies) filter (where s.day > current_date - 7), 0)::int as human,
        coalesce(sum(s.bounces) filter (where s.day > current_date - 7), 0)::int as bounces,
        coalesce(sum(s.sent) filter (where s.day <= current_date - 7), 0)::int as sent_prev,
        c.promised_daily, c.send_weekends,
        -- Everything the client's domains sent yesterday, live today or not: that's what went out.
        (select coalesce(sum(y.sent), 0)::int from domain_daily_stats y join domains x on x.id = y.domain_id
          where x.client_id = c.id and y.day = (now() at time zone coalesce((select value #>> '{}' from settings where key = 'stats_timezone'), 'UTC'))::date - 1) as sent_yesterday,
        to_char((now() at time zone coalesce((select value #>> '{}' from settings where key = 'stats_timezone'), 'UTC'))::date - 1, 'YYYY-MM-DD') as yesterday
      from clients c
      left join domains d on d.client_id = c.id
      left join domain_standing st on st.domain_id = d.id
      -- Sending numbers count only domains that are live today.
      left join domain_daily_stats s on s.domain_id = d.id and st.current and s.day > current_date - 14
      where c.archived_at is null
      group by c.id
      order by 8 desc, c.name`,
    sql<TrendDay[]>`
      select to_char(g.day, 'YYYY-MM-DD') as day, coalesce(sum(s.sent), 0)::int as sent, coalesce(sum(s.replies), 0)::int as replies,
        coalesce(sum(s.human_replies), 0)::int as human, coalesce(sum(s.bounces), 0)::int as bounces
      from generate_series(current_date - 13, current_date, interval '1 day') g(day)
      left join (domain_daily_stats s join domain_standing st on st.domain_id = s.domain_id and st.current) on s.day = g.day::date
      group by g.day order by g.day`,
  ]);
  return { issues, capacity: cap, clients, trend };
}
