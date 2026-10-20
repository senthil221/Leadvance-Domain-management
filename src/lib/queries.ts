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
      array(
        select coalesce(s.sent, 0)
        from generate_series(current_date - 13, current_date, interval '1 day') g(day)
        left join domain_daily_stats s on s.domain_id = d.id and s.day = g.day::date
        order by g.day
      ) as spark
    from domains d
    left join clients c on c.id = d.client_id
    left join vendors v on v.id = d.registrar_id
    left join domain_health_7d h on h.domain_id = d.id
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
      d.draining_since, d.burned_at, d.created_at,
      (select count(*)::int from alerts a where a.domain_id = d.id and a.status = 'open') as open_alerts,
      '{}'::int[] as spark
    from domains d
    left join clients c on c.id = d.client_id
    left join vendors v on v.id = d.registrar_id
    left join vendors ip on ip.id = d.inbox_provider_id
    left join domain_health_7d h on h.domain_id = d.id
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
        count(*) filter (where status in ('burned', 'resting') and expires_at between current_date and current_date + 60)::int as retired_renewing
      from domains`,
  ]);
  return { registrars, renewals, totals };
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
  completedAt: Date | null;
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
      ri.step_nameservers, ri.step_inboxes, ri.step_smartlead, ri.step_campaigns, ri.last_error, ri.completed_at
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

export type InboxListRow = InboxRow & { domainId: string; domain: string; domainStatus: DomainStatus; clientName: string | null; clientHue: number | null };

export async function listInboxes() {
  return sql<InboxListRow[]>`
    select i.id, i.email, i.sender_name, i.status, i.warmup_enabled, i.warmup_per_day, i.warmup_rampup, i.daily_limit,
      i.warmup_reputation::float8 as warmup_reputation, i.smartlead_account_id, i.last_synced_at,
      d.id as domain_id, d.name as domain, d.status as domain_status, c.name as client_name, c.hue as client_hue
    from inboxes i join domains d on d.id = i.domain_id left join clients c on c.id = d.client_id
    where i.status <> 'removed'
    order by d.name, i.email`;
}

export type ReplyRow = {
  id: number; occurredAt: Date; replyClass: "human" | "ooo" | "auto" | "negative" | null; classOverridden: boolean;
  preview: string | null; leadEmail: string | null; inboxEmail: string | null; domainId: string | null; domain: string | null;
  campaignName: string | null; clientName: string | null; clientHue: number | null; recipientEsp: string | null;
};

export async function listReplies(limit = 500) {
  return sql<ReplyRow[]>`
    select e.id, e.occurred_at, e.reply_class, e.class_overridden, e.preview, e.lead_email, e.inbox_email,
      e.domain_id, coalesce(d.name, e.domain_name) as domain, e.campaign_name, c.name as client_name, c.hue as client_hue, e.recipient_esp
    from email_events e left join domains d on d.id = e.domain_id left join clients c on c.id = e.client_id
    where e.kind = 'reply'
    order by e.occurred_at desc limit ${limit}`;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings() {
  const rows = await sql<{ key: string; value: unknown }[]>`select key, value from settings`;
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { drainDays: Number(map.drain_days ?? 7), storageLowThreshold: Number(map.storage_low_threshold ?? 20) };
}

export type JobStateRow = { job: string; lastStartedAt: Date | null; lastFinishedAt: Date | null; lastOk: boolean | null; lastError: string | null; lastDetail: Record<string, unknown> | null };

export async function listJobState() {
  return sql<JobStateRow[]>`select job, last_started_at, last_finished_at, last_ok, last_error, last_detail from job_state`;
}
