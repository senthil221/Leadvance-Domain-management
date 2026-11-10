import "server-only";
import { sql } from "@/lib/db";
import { getReplaceCalls } from "@/lib/queries";
import { CALL_META } from "@/lib/replace-list";

export type BatchRow = {
  id: string; status: "running" | "done" | "cancelled"; startsAt: string; seedsPerCampaign: number; createdBy: string | null;
  createdAt: string; finishedAt: string | null;
  domains: {
    id: string; domainId: string; domain: string; role: "test" | "control"; controlId: string | null; client: string | null; clientHue: number | null;
    campaigns: {
      id: string; variant: "sales" | "neutral"; step: string; lastError: string | null; smartleadId: number | null; subject: string;
      inboxes: number; leadsAdded: number | null; total: number; sent: number; replied: number; bounced: number;
      lastSentAt: string | null; startedAt: string | null; closedAt: string | null; polledAt: string | null;
    }[];
  }[];
};

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

/** The latest test batches with each domain's two campaigns and their counts. */
export async function listBatches(limit = 30): Promise<BatchRow[]> {
  const batches = await sql<{ id: string; status: BatchRow["status"]; startsAt: Date; seedsPerCampaign: number; createdBy: string | null; createdAt: Date; finishedAt: Date | null }[]>`
    select id, status, starts_at, seeds_per_campaign, created_by, created_at, finished_at
    from placement_batches order by created_at desc limit ${limit}`;
  if (!batches.length) return [];
  const ids = batches.map((b) => b.id);
  const [domains, campaigns] = await Promise.all([
    sql<{ id: string; batchId: string; domainId: string; domain: string; role: "test" | "control"; controlId: string | null; client: string | null; clientHue: number | null }[]>`
      select pd.id, pd.batch_id, pd.domain_id, d.name as domain, pd.role, pd.control_id, c.name as client, c.hue as client_hue
      from placement_domains pd join domains d on d.id = pd.domain_id left join clients c on c.id = pd.client_id
      where pd.batch_id = any(${ids}::uuid[]) order by pd.role desc, d.name`,
    sql<{ id: string; placementDomainId: string; variant: "sales" | "neutral"; step: string; lastError: string | null; smartleadCampaignId: string | null; subject: string;
      inboxes: number; leadsAdded: number | null; total: number; sent: number; replied: number; bounced: number; lastSentAt: Date | null;
      startedAt: Date | null; closedAt: Date | null; polledAt: Date | null }[]>`
      select pc.id, pc.placement_domain_id, pc.variant, pc.step, pc.last_error, pc.smartlead_campaign_id, pc.subject,
        cardinality(pc.account_ids) as inboxes, pc.leads_added, pc.started_at, pc.closed_at, pc.polled_at,
        count(ps.seed_email)::int as total, count(ps.sent_at)::int as sent, count(ps.replied_at)::int as replied,
        count(ps.bounced_at)::int as bounced, max(ps.sent_at) as last_sent_at
      from placement_campaigns pc left join placement_sends ps on ps.campaign_id = pc.id
      where pc.batch_id = any(${ids}::uuid[])
      group by pc.id order by pc.variant desc`,
  ]);
  return batches.map((b) => ({
    id: b.id, status: b.status, startsAt: iso(b.startsAt)!, seedsPerCampaign: b.seedsPerCampaign, createdBy: b.createdBy,
    createdAt: iso(b.createdAt)!, finishedAt: iso(b.finishedAt),
    domains: domains.filter((d) => d.batchId === b.id).map((d) => ({
      id: d.id, domainId: d.domainId, domain: d.domain, role: d.role, controlId: d.controlId, client: d.client, clientHue: d.clientHue,
      campaigns: campaigns.filter((c) => c.placementDomainId === d.id).map((c) => ({
        id: c.id, variant: c.variant, step: c.step, lastError: c.lastError, smartleadId: c.smartleadCampaignId ? Number(c.smartleadCampaignId) : null,
        subject: c.subject, inboxes: c.inboxes, leadsAdded: c.leadsAdded, total: c.total, sent: c.sent, replied: c.replied, bounced: c.bounced,
        lastSentAt: iso(c.lastSentAt), startedAt: iso(c.startedAt), closedAt: iso(c.closedAt), polledAt: iso(c.polledAt),
      })),
    })),
  }));
}

export type TestCandidate = {
  id: string; name: string; status: string; clientId: string | null; client: string | null; clientHue: number | null;
  inboxes: number; senders: string[]; sent14: number; replies14: number;
  /** The Replace list's call on it, if it is on the list. */ call: string | null; callTone: string | null;
  /** Live client campaigns its inboxes send in, most of its inboxes first. */ campaigns: { id: number; name: string; inboxes: number }[];
  inTest: boolean;
};

/** Sending domains that can be tested or used as a control: active or warming, with a connected Smartlead inbox. */
export async function testCandidates(): Promise<TestCandidate[]> {
  const [rows, campaigns, calls] = await Promise.all([
    sql<{ id: string; name: string; status: string; clientId: string | null; client: string | null; clientHue: number | null; inboxes: number; senders: string[] | null; sent14: number; replies14: number; inTest: boolean }[]>`
      select d.id, d.name, d.status, d.client_id, c.name as client, c.hue as client_hue,
        count(i.id)::int as inboxes,
        array_agg(distinct i.sender_name) filter (where i.sender_name is not null) as senders,
        coalesce(st.sent, 0)::int as sent14, coalesce(st.replies, 0)::int as replies14,
        exists (select 1 from placement_domains pd join placement_batches b on b.id = pd.batch_id where pd.domain_id = d.id and b.status = 'running') as in_test
      from domains d
      join inboxes i on i.domain_id = d.id and i.status = 'connected' and i.smartlead_account_id is not null
      left join clients c on c.id = d.client_id
      left join (select domain_id, sum(sent) as sent, sum(replies) as replies from domain_daily_stats where day > current_date - 14 group by 1) st on st.domain_id = d.id
      where d.status in ('active', 'warming')
      group by d.id, c.name, c.hue, st.sent, st.replies
      order by d.name`,
    sql<{ domainId: string; id: string; name: string; inboxes: number }[]>`
      select i.domain_id, ca.id, ca.name, count(*)::int as inboxes
      from campaign_inboxes ci join inboxes i on i.id = ci.inbox_id join campaigns ca on ca.id = ci.campaign_id
      where upper(coalesce(ca.status, '')) in ('ACTIVE', 'START', 'STARTED', 'SCHEDULED', 'PAUSED')
      group by i.domain_id, ca.id, ca.name`,
    getReplaceCalls().catch(() => null),
  ]);
  const callOf = new Map((calls?.items ?? []).map((i) => [i.domainId, i.call]));
  const byDomain = new Map<string, { id: number; name: string; inboxes: number }[]>();
  for (const c of campaigns) {
    const list = byDomain.get(c.domainId) ?? [];
    list.push({ id: Number(c.id), name: c.name, inboxes: c.inboxes });
    byDomain.set(c.domainId, list);
  }
  return rows.map((r) => {
    const call = callOf.get(r.id) ?? null;
    return {
      ...r, senders: r.senders ?? [], call: call ? CALL_META[call].label : null, callTone: call ? CALL_META[call].tone : null,
      campaigns: (byDomain.get(r.id) ?? []).sort((a, b) => b.inboxes - a.inboxes || a.name.localeCompare(b.name)),
    };
  });
}

export async function statsTimezone() {
  const [row] = await sql<{ tz: string | null }[]>`select value #>> '{}' as tz from settings where key = 'stats_timezone'`;
  return row?.tz || "UTC";
}
