import "server-only";
import { sql } from "./db";
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

export async function listVendors() {
  return sql<VendorRow[]>`select id, name, kind, api_supported from vendors order by kind, name`;
}

export type NavCounts = { byStatus: Record<DomainStatus, number>; openAlerts: number; runningBatches: number };

export async function getNavCounts(): Promise<NavCounts> {
  const [statusRows, [extra]] = await Promise.all([
    sql<{ status: DomainStatus; n: number }[]>`select status, count(*)::int as n from domains group by status`,
    sql<{ openAlerts: number; runningBatches: number }[]>`
      select
        (select count(*)::int from alerts where status = 'open') as open_alerts,
        (select count(*)::int from replacement_batches where status = 'running') as running_batches`,
  ]);
  const byStatus = Object.fromEntries(statusRows.map((r) => [r.status, r.n])) as Record<DomainStatus, number>;
  return { byStatus, ...extra };
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
    sql<{ active: number; storage: number; warming: number; retiredLast28: number; storageLow: number; flagged: number }[]>`
      select
        (select count(distinct a.domain_id)::int from alerts a join domains d on d.id = a.domain_id
          where a.status = 'open' and d.status in ('active', 'warming')) as flagged,
        count(*) filter (where status = 'active')::int as active,
        count(*) filter (where status = 'in_storage')::int as storage,
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
      where a.status = 'open' and d.status in ('active', 'warming')
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
      where d.status in ('provisioning', 'warming', 'active', 'draining')
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
    weeksLeft: weeklyBurn > 0 ? totals.storage / weeklyBurn : null,
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
  expiresAt: Date | null;
  openAlerts: number;
  spark: number[];
  sl7Sent: number | null;
  sl7Replies: number | null;
  sl7Bounces: number | null;
  tags: string[];
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
};

export async function listDomains() {
  return sql<DomainRow[]>`
    select d.id, d.name, d.tld, d.status, d.client_id, c.name as client_name, c.hue as client_hue,
      v.name as registrar,
      (select count(*)::int from inboxes i where i.domain_id = d.id and i.status <> 'removed') as inbox_count,
      h.sent, h.human_replies, h.replies, h.bounces,
      h.bounce_rate::float8 as bounce_rate, h.human_reply_rate::float8 as human_reply_rate,
      h.warmup_reputation::float8 as warmup_reputation,
      d.active_since, d.purchased_at, d.expires_at,
      (select count(*)::int from alerts a where a.domain_id = d.id and a.status = 'open') as open_alerts,
      s7.sent as sl7_sent, s7.replies as sl7_replies, s7.bounces as sl7_bounces,
      array(
        select coalesce(s.sent, 0)
        from generate_series(current_date - 13, current_date, interval '1 day') g(day)
        left join domain_daily_stats s on s.domain_id = d.id and s.day = g.day::date
        order by g.day
      ) as spark,
      d.tags, d.nameservers, d.draining_since, d.burned_at, d.cost_cents, d.registrar_api_access as api_access, d.nameservers_checked_at, d.nameservers_answering,
      ho.status as ht_order_status, ho.payment_status as ht_payment,
      nr.status as ns_request_status, nr.message as ns_request_message, nr.target as ns_request_target,
      rp.new_domain_id as replaced_by_id, rp.name as replaced_by_name, rp.created_at as replaced_at,
      (select coalesce(sum(i.daily_limit), 0)::int from inboxes i where i.domain_id = d.id and i.status = 'connected') as capacity
    from domains d
    left join clients c on c.id = d.client_id
    left join vendors v on v.id = d.registrar_id
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
};

export async function getDomainDetail(id: string): Promise<DomainDetail | null> {
  const [domain] = await sql<DomainDetail["domain"][]>`
    select d.id, d.name, d.tld, d.status, d.client_id, c.name as client_name, c.hue as client_hue,
      v.name as registrar, ip.name as inbox_provider,
      (select count(*)::int from inboxes i where i.domain_id = d.id and i.status <> 'removed') as inbox_count,
      h.sent, h.human_replies, h.replies, h.bounces,
      h.bounce_rate::float8 as bounce_rate, h.human_reply_rate::float8 as human_reply_rate,
      h.warmup_reputation::float8 as warmup_reputation,
      d.active_since, d.purchased_at, d.expires_at, d.nameservers, d.notes, d.cost_cents,
      d.draining_since, d.burned_at, d.created_at, d.auto_renew, d.registrar_api_access, d.nameservers_checked_at,
      (select count(*)::int from alerts a where a.domain_id = d.id and a.status = 'open') as open_alerts,
      '{}'::int[] as spark,
      s7.sent as sl7_sent, s7.replies as sl7_replies, s7.bounces as sl7_bounces,
      d.tags, d.registrar_api_access as api_access, d.nameservers_answering, ho.status as ht_order_status, ho.payment_status as ht_payment,
      nr.status as ns_request_status, nr.message as ns_request_message, nr.target as ns_request_target,
      null as replaced_by_id, null as replaced_by_name, null as replaced_at,
      (select coalesce(sum(i.daily_limit), 0)::int from inboxes i where i.domain_id = d.id and i.status = 'connected') as capacity
    from domains d
    left join clients c on c.id = d.client_id
    left join vendors v on v.id = d.registrar_id
    left join vendors ip on ip.id = d.inbox_provider_id
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

  const [inboxes, daily, history, lineageRows, alerts] = await Promise.all([
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
  ]);

  const pick = (side: "replaced" | "replacedBy") => {
    const r = lineageRows.find((l) => l.side === side);
    return r ? { domainId: r.domainId, name: r.name, at: r.at, reason: r.reason, note: r.note } : null;
  };

  return { domain, inboxes, daily, history, lineage: { replaced: pick("replaced"), replacedBy: pick("replacedBy") }, alerts };
}

// Free domains for the replace dialog, preferring the given TLDs. Nothing is
// locked here: start_replacement re-checks each pick inside its transaction.
export type StorageCandidate = { id: string; name: string; tld: string | null; registrar: string | null; purchasedAt: Date | null };

export async function listStorageCandidates(limit = 200) {
  return sql<StorageCandidate[]>`
    select d.id, d.name, d.tld, v.name as registrar, d.purchased_at
    from domains d left join vendors v on v.id = d.registrar_id
    where d.status = 'in_storage'
    order by d.purchased_at nulls last, d.created_at, d.name
    limit ${limit}`;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export type RenewalRow = { id: string; name: string; status: DomainStatus; registrar: string | null; expiresAt: Date; costCents: number | null; clientName: string | null; clientHue: number | null };

export async function getInventory() {
  const [registrars, renewals, [totals]] = await Promise.all([
    sql<{ registrar: string; total: number; storage: number; annualCents: number }[]>`
      select coalesce(v.name, 'Unknown') as registrar, count(*)::int as total,
        count(*) filter (where d.status = 'in_storage')::int as storage,
        coalesce(sum(d.cost_cents) filter (where d.status not in ('burned', 'resting')), 0)::int as annual_cents
      from domains d left join vendors v on v.id = d.registrar_id
      group by 1 order by total desc`,
    sql<RenewalRow[]>`
      select d.id, d.name, d.status, v.name as registrar, d.expires_at, d.cost_cents, c.name as client_name, c.hue as client_hue
      from domains d left join vendors v on v.id = d.registrar_id left join clients c on c.id = d.client_id
      where d.expires_at between current_date and current_date + 60
      order by d.expires_at, d.name`,
    sql<{ owned: number; storage: number; annualCents: number; retiredRenewing: number }[]>`
      select count(*)::int as owned, count(*) filter (where status = 'in_storage')::int as storage,
        coalesce(sum(cost_cents) filter (where status not in ('burned', 'resting')), 0)::int as annual_cents,
        count(*) filter (where status in ('burned', 'resting') and auto_renew is not false and expires_at between current_date and current_date + 60)::int as retired_renewing
      from domains`,
  ]);
  return { registrars, renewals, totals };
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
        count(*) filter (where payment_status ilike 'paid%' and status is distinct from 'Done' and status is distinct from 'NPC')::int as in_setup,
        count(*) filter (where status = 'NPC' and payment_status not ilike '%recovery%')::int as cancelled,
        count(*) filter (where payment_status ilike '%recovery%')::int as recovery,
        count(*) filter (where status = 'Done')::int as done,
        (select count(*)::int from domains d where d.status in ('active', 'warming')
          and not exists (select 1 from hypertide_orders o where o.domain_id = d.id and o.gone_at is null and o.status is distinct from 'NPC')) as sending_without,
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

export type BatchItem = {
  id: string;
  oldDomainId: string;
  oldDomain: string;
  newDomainId: string;
  newDomain: string;
  clientName: string | null;
  clientHue: number | null;
  stepNameservers: StepStatus;
  stepInboxes: StepStatus;
  stepSmartlead: StepStatus;
  stepCampaigns: StepStatus;
  lastError: string | null;
  note: string | null;
  completedAt: Date | null;
  htOrderId: string | null;
  htStatus: string | null;
  htPaidAt: Date | null;
};

export type Batch = {
  id: string;
  reason: ReplacementReason;
  note: string | null;
  actor: string;
  status: "running" | "completed" | "partial" | "cancelled";
  createdAt: Date;
  completedAt: Date | null;
  items: BatchItem[];
};

export async function listBatches(limit = 50): Promise<Batch[]> {
  const batches = await sql<Omit<Batch, "items">[]>`
    select id, reason, note, actor, status, created_at, completed_at
    from replacement_batches order by created_at desc limit ${limit}`;
  if (batches.length === 0) return [];
  const items = await sql<(BatchItem & { batchId: string })[]>`
    select ri.id, ri.batch_id, ri.old_domain_id, od.name as old_domain, ri.new_domain_id, nd.name as new_domain,
      c.name as client_name, c.hue as client_hue,
      ri.step_nameservers, ri.step_inboxes, ri.step_smartlead, ri.step_campaigns, ri.last_error, ri.note, ri.completed_at,
      ri.hypertide_order_id as ht_order_id, ri.hypertide_status as ht_status, ri.hypertide_paid_at as ht_paid_at
    from replacement_items ri
    join domains od on od.id = ri.old_domain_id
    join domains nd on nd.id = ri.new_domain_id
    left join clients c on c.id = ri.client_id
    where ri.batch_id in ${sql(batches.map((b) => b.id))}
    order by od.name`;
  return batches.map((b) => ({ ...b, items: items.filter((i) => i.batchId === b.id) }));
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
  sent7: number; replies7: number; human7: number; bounces7: number; campaigns: number;
  smartleadTags: string[]; providerType: string | null; minWaitMins: number | null; dailySent: number | null;
  warmupMin: number | null; warmupReplyRate: number | null; warmupStatus: string | null;
  warmupTag: string | null; warmupRampupOn: boolean | null;
  change: { status: string; error: string | null; changes: Record<string, unknown> } | null;
  domainBornAt: Date | null; smartleadCreatedAt: Date | null; warmupBlockedReason: string | null; connectError: string | null;
  dnsSpf: boolean | null; dnsDkim: boolean | null; dnsDmarc: boolean | null; dnsMx: boolean | null; dnsCheckedAt: Date | null; nsAnswering: boolean | null;
  blDomain: number | null; blIp: number | null; blListings: { kind: string; list: string }[] | null; blCheckedAt: Date | null;
};

export async function listInboxes() {
  return sql<InboxListRow[]>`
    with ev as (
      select inbox_id,
        count(*) filter (where kind = 'sent')::int as sent7,
        count(*) filter (where kind = 'reply')::int as replies7,
        count(*) filter (where kind = 'reply' and reply_class = 'human')::int as human7,
        count(*) filter (where kind = 'bounce')::int as bounces7
      from email_events where occurred_at > now() - interval '7 days' and inbox_id is not null
      group by inbox_id
    ), camp as (
      select inbox_id, count(*)::int as n from campaign_inboxes group by inbox_id
    )
    select i.id, i.email, i.sender_name, i.status, i.warmup_enabled, i.warmup_per_day, i.warmup_rampup, i.daily_limit,
      i.warmup_reputation::float8 as warmup_reputation, i.smartlead_account_id, i.last_synced_at,
      d.id as domain_id, d.name as domain, d.status as domain_status, c.name as client_name, c.hue as client_hue,
      coalesce(ev.sent7, 0) as sent7, coalesce(ev.replies7, 0) as replies7, coalesce(ev.human7, 0) as human7,
      coalesce(ev.bounces7, 0) as bounces7, coalesce(camp.n, i.campaign_count, 0) as campaigns,
      i.smartlead_tags, i.provider_type, i.min_wait_mins, i.daily_sent, i.warmup_min, i.warmup_reply_rate, i.warmup_status,
      i.warmup_tag, i.warmup_rampup_on,
      ch.change,
      coalesce(d.purchased_at, d.registered_at)::timestamptz as domain_born_at, i.smartlead_created_at, i.warmup_blocked_reason, i.connect_error,
      d.dns_spf, d.dns_dkim, d.dns_dmarc, d.dns_mx, d.dns_checked_at, d.nameservers_answering as ns_answering,
      d.blacklist_domain_count as bl_domain, d.blacklist_ip_count as bl_ip, d.blacklist_listings as bl_listings, d.blacklist_checked_at as bl_checked_at
    from inboxes i join domains d on d.id = i.domain_id left join clients c on c.id = d.client_id
    left join ev on ev.inbox_id = i.id
    left join camp on camp.inbox_id = i.id
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
  id: string; name: string; status: DomainStatus; clientId: string | null; clientName: string | null; clientHue: number | null;
  tags: string[]; inboxes: number; capacity: number;
  prevSent: number; prevReplies: number; prevHuman: number; prevBounces: number;
};
/** One domain on one day; only days with any activity. */
export type StatDay = { d: string; day: string; sent: number; replies: number; human: number; ooo: number; negative: number; bounces: number; rep: number | null };
export type StatsData = { from: string; to: string; today: string; domains: StatDomain[]; days: StatDay[] };

/**
 * Per-domain, per-day numbers for any range (up to 92 days), plus each
 * domain's totals for the same-length period just before, for the change.
 */
export async function getStats(from: string, to: string): Promise<StatsData> {
  const [[{ today }], domains, days] = await Promise.all([
    sql<{ today: string }[]>`
      select to_char((now() at time zone coalesce((select value #>> '{}' from settings where key = 'stats_timezone'), 'UTC'))::date, 'YYYY-MM-DD') as today`,
    sql<StatDomain[]>`
      with r as (select ${from}::date as f, ${to}::date as t, (${to}::date - ${from}::date + 1) as len)
      select d.id, d.name, d.status, d.client_id, c.name as client_name, c.hue as client_hue, d.tags,
        (select count(*)::int from inboxes i where i.domain_id = d.id and i.status = 'connected') as inboxes,
        (select coalesce(sum(i.daily_limit), 0)::int from inboxes i where i.domain_id = d.id and i.status = 'connected') as capacity,
        coalesce(p.sent, 0) as prev_sent, coalesce(p.replies, 0) as prev_replies, coalesce(p.human, 0) as prev_human, coalesce(p.bounces, 0) as prev_bounces
      from domains d cross join r
      left join clients c on c.id = d.client_id
      left join lateral (
        select sum(s.sent)::int as sent, sum(s.replies)::int as replies, sum(s.human_replies)::int as human, sum(s.bounces)::int as bounces
        from domain_daily_stats s where s.domain_id = d.id and s.day between r.f - r.len and r.f - 1) p on true
      where d.status in ('warming', 'active', 'draining')
        or exists (select 1 from domain_daily_stats x where x.domain_id = d.id and x.day between r.f - r.len and r.t)
      order by d.name`,
    sql<StatDay[]>`
      select s.domain_id as d, to_char(s.day, 'YYYY-MM-DD') as day, s.sent, s.replies, s.human_replies as human, s.ooo, s.negative, s.bounces,
        s.warmup_reputation::float8 as rep
      from domain_daily_stats s
      where s.day between ${from}::date and ${to}::date and (s.sent > 0 or s.replies > 0 or s.bounces > 0)
      order by s.day`,
  ]);
  return { from, to, today, domains, days };
}

export type ReplyRow = {
  id: number; occurredAt: Date; replyClass: "human" | "ooo" | "auto" | "negative" | null; classOverridden: boolean;
  preview: string | null; leadEmail: string | null; inboxEmail: string | null; domainId: string | null; domain: string | null;
  campaignName: string | null; clientName: string | null; clientHue: number | null; recipientEsp: string | null;
};

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
};
export type EventsData = { from: string; to: string; today: string; events: EventRow[]; sent: Record<string, number> };

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
        e.client_id, c.name as client_name, c.hue as client_hue, e.recipient_esp,
        coalesce(e.payload->>'ui_master_inbox_link', e.payload->>'app_url') as link,
        case when e.kind = 'bounce' then left(coalesce(e.payload->'bounce_message'->>'text', e.payload->>'description'), 600) end as bounce_text,
        -- Office 365 quotes the receiving server's own error only in the HTML version.
        case when e.kind = 'bounce' then left(replace(substring(regexp_replace(coalesce(e.payload->'bounce_message'->>'html', ''), '<[^>]+>', ' ', 'g')
          from 'Remote server returned an error.{0,250}'), '&gt;', '>'), 300) end as bounce_remote
      from email_events e cross join tz
      left join domains d on d.id = e.domain_id left join clients c on c.id = e.client_id
      where e.kind = ${kind}::event_kind
        and (e.occurred_at at time zone tz.z)::date between ${from}::date and ${to}::date
      order by e.occurred_at desc
      limit 5000`,
    sql<{ domainId: string; sent: number }[]>`
      select domain_id, sum(sent)::int as sent from domain_daily_stats
      where day between ${from}::date and ${to}::date group by domain_id`,
  ]);
  return { from, to, today: t.today, events, sent: Object.fromEntries(sent.map((s) => [s.domainId, s.sent])) };
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
    storageLowThreshold: Number(map.storage_low_threshold ?? 20),
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

// ---------------------------------------------------------------------------
// Overview insights
// ---------------------------------------------------------------------------

export type Issues = {
  flagged: number; noZone: number; disconnected: number; lowRep: number; htUnpaid: number; htCancelledLive: number;
  billedRetired: number; renew14: number; nsFailed: number; settingsFailed: number; stuckSetup: number; freeLow: boolean; free: number;
};
export type ClientInsight = {
  id: string; name: string; hue: number; active: number; warming: number; inboxes: number; capacity: number;
  sent: number; replies: number; human: number; bounces: number; sentPrev: number;
};
export type TrendDay = { day: string; sent: number; replies: number; human: number; bounces: number };

export async function getInsights() {
  const [[issues], [cap], clients, trend] = await Promise.all([
    sql<Issues[]>`
      select
        (select count(distinct a.domain_id)::int from alerts a join domains d on d.id = a.domain_id
          where a.status = 'open' and d.status in ('active', 'warming')) as flagged,
        (select count(*)::int from domains where nameservers_answering = false and status not in ('burned', 'resting')) as no_zone,
        (select count(*)::int from inboxes i join domains d on d.id = i.domain_id where i.status = 'disconnected' and d.status in ('active', 'warming')) as disconnected,
        (select count(*)::int from inboxes i join domains d on d.id = i.domain_id where i.status = 'connected' and i.warmup_reputation < 90 and d.status in ('active', 'warming')) as low_rep,
        (select count(*)::int from hypertide_orders where gone_at is null and payment_status not ilike 'paid%' and payment_status not ilike '%recovery%') as ht_unpaid,
        (select count(distinct o.domain_id)::int from hypertide_orders o join domains d on d.id = o.domain_id
          where o.gone_at is null and o.status = 'NPC' and d.status in ('active', 'warming', 'provisioning')
          and not exists (select 1 from hypertide_orders o2 where o2.domain_id = d.id and o2.gone_at is null and o2.status is distinct from 'NPC')) as ht_cancelled_live,
        (select count(distinct o.domain_id)::int from hypertide_orders o join domains d on d.id = o.domain_id
          where o.gone_at is null and o.status = 'Done' and d.status in ('burned', 'resting')) as billed_retired,
        (select count(*)::int from domains where expires_at between current_date and current_date + 14 and status not in ('burned', 'resting')) as renew14,
        (select count(*)::int from nameserver_requests where status = 'failed' and created_at > now() - interval '7 days') as ns_failed,
        (select count(distinct inbox_id)::int from inbox_setting_changes where status = 'failed' and created_at > now() - interval '2 days') as settings_failed,
        (select count(*)::int from domains d where d.status = 'provisioning'
          and coalesce((select max(h.at) from domain_status_history h where h.domain_id = d.id), d.created_at) < now() - interval '10 days') as stuck_setup,
        (select count(*)::int from domains where status = 'in_storage') as free,
        (select count(*) from domains where status = 'in_storage') <= coalesce((select (value #>> '{}')::int from settings where key = 'storage_low_threshold'), 20) as free_low`,
    sql<{ capacity: number; sentToday: number; inboxes: number }[]>`
      select coalesce(sum(i.daily_limit), 0)::int as capacity, coalesce(sum(i.daily_sent), 0)::int as sent_today, count(*)::int as inboxes
      from inboxes i join domains d on d.id = i.domain_id
      where i.status = 'connected' and d.status = 'active'`,
    sql<ClientInsight[]>`
      select c.id, c.name, c.hue,
        count(distinct d.id) filter (where d.status = 'active')::int as active,
        count(distinct d.id) filter (where d.status in ('provisioning', 'warming'))::int as warming,
        (select count(*)::int from inboxes i join domains x on x.id = i.domain_id where x.client_id = c.id and i.status = 'connected' and x.status = 'active') as inboxes,
        (select coalesce(sum(i.daily_limit), 0)::int from inboxes i join domains x on x.id = i.domain_id where x.client_id = c.id and i.status = 'connected' and x.status = 'active') as capacity,
        coalesce(sum(s.sent) filter (where s.day > current_date - 7), 0)::int as sent,
        coalesce(sum(s.replies) filter (where s.day > current_date - 7), 0)::int as replies,
        coalesce(sum(s.human_replies) filter (where s.day > current_date - 7), 0)::int as human,
        coalesce(sum(s.bounces) filter (where s.day > current_date - 7), 0)::int as bounces,
        coalesce(sum(s.sent) filter (where s.day <= current_date - 7), 0)::int as sent_prev
      from clients c
      left join domains d on d.client_id = c.id
      left join domain_daily_stats s on s.domain_id = d.id and s.day > current_date - 14
      where c.archived_at is null
      group by c.id
      order by 8 desc, c.name`,
    sql<TrendDay[]>`
      select to_char(g.day, 'YYYY-MM-DD') as day, coalesce(sum(s.sent), 0)::int as sent, coalesce(sum(s.replies), 0)::int as replies,
        coalesce(sum(s.human_replies), 0)::int as human, coalesce(sum(s.bounces), 0)::int as bounces
      from generate_series(current_date - 13, current_date, interval '1 day') g(day)
      left join domain_daily_stats s on s.day = g.day::date
      group by g.day order by g.day`,
  ]);
  return { issues, capacity: cap, clients, trend };
}
