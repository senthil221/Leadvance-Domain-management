import type postgres from "postgres";
import { asArray, type Smartlead } from "../integrations/smartlead";
import { SEEDS_SQL, seedStatus } from "../lib/placement-seeds";
import {
  GIVE_UP_HOURS, PLACEMENT_PREFIX, WAIT_HOURS, bodyHtml, leadFor, parseStatRow, pickInboxes, pickSeeds,
  type InboxChoice, type SeedChoice, type Variant,
} from "../lib/placement-tests";

// Placement tests: creating a batch (which inboxes send, which seeds each
// campaign gets), then the job that builds each campaign in Smartlead one step
// at a time, reads who was sent what and who auto-replied, and stops each
// campaign once its replies have had WAIT_HOURS.

/** A refusal worded for people. */
export class PlacementError extends Error {}

export type BatchInput = {
  groups: {
    domainIds: string[];
    controlDomainId: string;
    sales: { subject: string; body: string; sourceCampaignId: number | null };
  }[];
  neutral: { subject: string; body: string };
  seedsPerCampaign: number;
  inboxesPerDomain: number;
  startsAt: string;
  createdBy: string | null;
};

const SETUP = ["create", "settings", "schedule", "sequence", "accounts", "leads", "start"] as const;
type SetupStep = (typeof SETUP)[number];
const MAX_ATTEMPTS = 5;
const POLL_MINUTES = 15;
const HOUR = 3_600_000;

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

/** Plans a batch and saves it: the job builds the campaigns. Throws PlacementError for anything a person should fix. */
export async function createPlacementBatch(sql: postgres.Sql, input: BatchInput, now = new Date()) {
  const testIds = input.groups.flatMap((g) => g.domainIds);
  const controlIds = [...new Set(input.groups.map((g) => g.controlDomainId))];
  if (!testIds.length) throw new PlacementError("Pick at least one domain to test");
  if (new Set(testIds).size !== testIds.length) throw new PlacementError("A domain is in the batch twice");
  if (controlIds.some((c) => testIds.includes(c))) throw new PlacementError("A control can't also be tested in the same batch");
  for (const g of input.groups) {
    if (!g.sales.subject.trim() || !g.sales.body.trim()) throw new PlacementError("Every client needs a subject and body for the real copy");
  }
  if (!input.neutral.subject.trim() || !input.neutral.body.trim()) throw new PlacementError("The neutral note needs a subject and body");
  const allIds = [...testIds, ...controlIds];

  const busy = await sql<{ name: string }[]>`
    select d.name from placement_domains pd join placement_batches b on b.id = pd.batch_id join domains d on d.id = pd.domain_id
    where b.status = 'running' and pd.domain_id = any(${allIds}::uuid[])`;
  if (busy.length) throw new PlacementError(`Already in a running test: ${busy.map((b) => b.name).join(", ")}`);

  const inboxRows = await sql<{ domain_id: string; domain: string; client_id: string | null; account_id: string; email: string; sender_name: string | null; reputation: string | null }[]>`
    select d.id as domain_id, d.name as domain, d.client_id, i.smartlead_account_id as account_id, i.email, i.sender_name, i.warmup_reputation as reputation
    from domains d join inboxes i on i.domain_id = d.id
    where d.id = any(${allIds}::uuid[]) and i.status = 'connected' and i.smartlead_account_id is not null`;
  const names = await sql<{ id: string; name: string; client_id: string | null }[]>`select id, name, client_id from domains where id = any(${allIds}::uuid[])`;
  const domainName = new Map(names.map((d) => [d.id, d.name]));
  const clientOf = new Map(names.map((d) => [d.id, d.client_id]));
  const inboxes = new Map<string, InboxChoice[]>();
  for (const r of inboxRows) {
    const list = inboxes.get(r.domain_id) ?? [];
    list.push({ accountId: Number(r.account_id), email: r.email, senderName: r.sender_name, reputation: r.reputation == null ? null : Number(r.reputation) });
    inboxes.set(r.domain_id, list);
  }
  const noInbox = allIds.filter((id) => !inboxes.get(id)?.length).map((id) => domainName.get(id) ?? id);
  if (noInbox.length) throw new PlacementError(`No connected Smartlead inbox on ${noInbox.join(", ")}`);

  // Ready seeds, and every test email already sent or waiting to go.
  const nowMs = now.getTime();
  const seedRows = await sql.unsafe<{ email: string; domain: string; name: string | null; forwards: boolean; last_reply_at: Date; person_replied_at: Date | null; bounced_at: Date | null; provider: string | null; silent_to_control: boolean }[]>(SEEDS_SQL);
  const ready: SeedChoice[] = seedRows
    .filter((s) => seedStatus({
      forwards: s.forwards, lastReplyAt: iso(s.last_reply_at)!, personRepliedAt: iso(s.person_replied_at), bouncedAt: iso(s.bounced_at),
      provider: s.provider as never, silentToControl: s.silent_to_control,
    }, nowMs) === "ready")
    .map((s) => ({ email: s.email, domain: s.domain, name: s.name, lastReplyAt: iso(s.last_reply_at)! }));
  const history = await sql<{ email: string; domain_id: string; sent_at: Date }[]>`
    select ps.seed_email as email, pd.domain_id, coalesce(ps.sent_at, b.starts_at) as sent_at
    from placement_sends ps
    join placement_campaigns pc on pc.id = ps.campaign_id
    join placement_domains pd on pd.id = pc.placement_domain_id
    join placement_batches b on b.id = pc.batch_id
    where ps.sent_at is not null or (b.status = 'running' and pc.step not in ('failed', 'cancelled'))`;

  // Two campaigns for every tested domain and every control.
  const roles = [...testIds.map((id) => ({ id, role: "test" as const })), ...controlIds.map((id) => ({ id, role: "control" as const }))];
  const wants = roles.flatMap((r) => (["sales", "neutral"] as Variant[]).map((v) => ({ key: `${r.id}|${v}`, domainId: r.id, count: input.seedsPerCampaign })));
  const { picks, short } = pickSeeds(ready, history.map((h) => ({ email: h.email, domainId: h.domain_id, sentAt: iso(h.sent_at)! })), wants, nowMs);
  const fewest = Math.min(...wants.map((w) => picks.get(w.key)!.length));
  if (fewest < Math.min(6, input.seedsPerCampaign)) {
    const need = wants.reduce((n, w) => n + w.count, 0);
    throw new PlacementError(`Not enough ready seeds: ${ready.length} are ready and this batch needs ${need} emails, and a seed gets at most 3 a week and never two from one domain. Test fewer domains or use fewer seeds per campaign`);
  }

  const day = now.toISOString().slice(0, 10);
  return sql.begin(async (tx) => {
    const [batch] = await tx<{ id: string }[]>`
      insert into placement_batches (starts_at, seeds_per_campaign, created_by)
      values (${input.startsAt}, ${input.seedsPerCampaign}, ${input.createdBy}) returning id`;
    const pdId = new Map<string, string>();
    for (const id of controlIds) {
      const [row] = await tx<{ id: string }[]>`
        insert into placement_domains (batch_id, domain_id, role, client_id) values (${batch.id}, ${id}, 'control', ${clientOf.get(id) ?? null}) returning id`;
      pdId.set(id, row.id);
    }
    for (const g of input.groups) {
      for (const id of g.domainIds) {
        const [row] = await tx<{ id: string }[]>`
          insert into placement_domains (batch_id, domain_id, role, client_id, control_id)
          values (${batch.id}, ${id}, 'test', ${clientOf.get(id) ?? null}, ${pdId.get(g.controlDomainId)!}) returning id`;
        pdId.set(id, row.id);
      }
    }
    // A control shared by several groups takes the first group's copy.
    const copyFor = new Map<string, BatchInput["groups"][number]["sales"]>();
    for (const g of input.groups) {
      for (const id of g.domainIds) copyFor.set(id, g.sales);
      if (!copyFor.has(g.controlDomainId)) copyFor.set(g.controlDomainId, g.sales);
    }
    let campaigns = 0, emails = 0;
    for (const r of roles) {
      const sales = copyFor.get(r.id)!;
      const accounts = pickInboxes(inboxes.get(r.id)!, input.inboxesPerDomain).map((i) => i.accountId);
      for (const v of ["sales", "neutral"] as Variant[]) {
        const copy = v === "sales" ? sales : input.neutral;
        const [c] = await tx<{ id: string }[]>`
          insert into placement_campaigns (batch_id, placement_domain_id, variant, name, subject, body, source_campaign_id, account_ids)
          values (${batch.id}, ${pdId.get(r.id)!}, ${v}, ${`${PLACEMENT_PREFIX}${domainName.get(r.id)} · ${v === "sales" ? "Sales" : "Neutral"} · ${day}`},
            ${copy.subject.trim()}, ${copy.body.trim()}, ${sales.sourceCampaignId}, ${accounts}) returning id`;
        const seeds = picks.get(`${r.id}|${v}`)!;
        for (const s of seeds) {
          const lead = leadFor(s);
          await tx`insert into placement_sends (campaign_id, seed_email, first_name, company) values (${c.id}, ${s.email}, ${lead.first_name}, ${lead.company_name})`;
        }
        campaigns++;
        emails += seeds.length;
      }
    }
    return { batchId: batch.id, campaigns, emails, short: short.length };
  });
}

type CampaignRow = {
  id: string; batch_id: string; name: string; subject: string; body: string; source_campaign_id: string | null; settings: Record<string, unknown>;
  account_ids: string[]; smartlead_campaign_id: string | null; step: string; attempts: number; leads_added: number | null;
  started_at: Date | null; starts_at: Date; batch_status: string; placement_domain_id: string;
};

/** Settings copied from the client's campaign, so the test sends the way it does. */
const KEEP_SETTINGS = ["track_settings", "send_as_plain_text", "force_plain_text", "unsubscribe_text", "add_unsubscribe_tag", "enable_ai_esp_matching"];
const DEFAULT_SETTINGS = { track_settings: ["DONT_TRACK_EMAIL_OPEN", "DONT_TRACK_LINK_CLICK"], send_as_plain_text: false };

const idOf = (r: unknown) => {
  const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  const d = (o.data && typeof o.data === "object" ? o.data : {}) as Record<string, unknown>;
  const n = Number(o.id ?? o.campaign_id ?? d.id);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export async function runPlacementTests(sql: postgres.Sql, sl: Smartlead, { timezone = "UTC", now = () => new Date() }: { timezone?: string; now?: () => Date } = {}) {
  const out = { built: 0, failed: 0, polled: 0, closed: 0, cancelled: 0, finished: 0 };

  // Cancelled batches: stop what reached Smartlead, drop the rest.
  const cancel = await sql<{ id: string; smartlead_campaign_id: string | null }[]>`
    select pc.id, pc.smartlead_campaign_id from placement_campaigns pc join placement_batches b on b.id = pc.batch_id
    where b.status = 'cancelled' and pc.step not in ('closed', 'failed', 'cancelled')`;
  for (const c of cancel) {
    if (c.smartlead_campaign_id) {
      try { await sl.setCampaignStatus(Number(c.smartlead_campaign_id), "STOPPED"); } catch { /* stopped by hand, or gone */ }
    }
    await sql`update placement_campaigns set step = 'cancelled', closed_at = now() where id = ${c.id}`;
    out.cancelled++;
  }

  const open = await sql<CampaignRow[]>`
    select pc.*, b.starts_at, b.status as batch_status from placement_campaigns pc join placement_batches b on b.id = pc.batch_id
    where b.status = 'running' and pc.step not in ('closed', 'failed', 'cancelled')
    order by b.created_at, pc.id`;

  for (const c of open.filter((x) => (SETUP as readonly string[]).includes(x.step))) {
    if (sl.dryRun) {
      await sql`update placement_campaigns set step = 'failed', last_error = 'Smartlead is in dry-run mode (INTEGRATIONS_DRY_RUN), so nothing was created' where id = ${c.id}`;
      out.failed++;
      continue;
    }
    const ok = await buildCampaign(sql, sl, c, timezone, now());
    if (ok) out.built++; else if (c.attempts + 1 >= MAX_ATTEMPTS) out.failed++;
  }

  const sending = await sql<CampaignRow[]>`
    select pc.*, b.starts_at, b.status as batch_status from placement_campaigns pc join placement_batches b on b.id = pc.batch_id
    where b.status = 'running' and pc.step = 'sending'
      and (pc.polled_at is null or pc.polled_at < ${new Date(now().getTime() - POLL_MINUTES * 60_000)})`;
  for (const c of sending) {
    try {
      await pollCampaign(sql, sl, c);
      out.polled++;
      if (await closeIfDone(sql, sl, c, now())) out.closed++;
    } catch (e) {
      await sql`update placement_campaigns set last_error = ${String(e instanceof Error ? e.message : e).slice(0, 500)}, polled_at = now() where id = ${c.id}`;
    }
  }

  const done = await sql`
    update placement_batches b set status = 'done', finished_at = now()
    where b.status = 'running' and not exists (
      select 1 from placement_campaigns pc where pc.batch_id = b.id and pc.step not in ('closed', 'failed', 'cancelled'))`;
  out.finished = done.count;
  return out;
}

/** Runs a campaign's remaining setup steps in Smartlead; true when it was started. */
async function buildCampaign(sql: postgres.Sql, sl: Smartlead, c: CampaignRow, timezone: string, now: Date) {
  let step = c.step as SetupStep | "sending";
  let id = c.smartlead_campaign_id ? Number(c.smartlead_campaign_id) : null;
  try {
    while (step !== "sending") {
      switch (step) {
        case "create": {
          id = idOf(await sl.createCampaign(c.name));
          if (!id) throw new Error("Smartlead created the campaign but didn't say its id");
          await sql`update placement_campaigns set smartlead_campaign_id = ${id} where id = ${c.id}`;
          step = "settings";
          break;
        }
        case "settings": {
          let settings: Record<string, unknown> = c.settings && Object.keys(c.settings).length ? c.settings : { ...DEFAULT_SETTINGS };
          if (c.source_campaign_id && !Object.keys(c.settings ?? {}).length) {
            const src = (await sl.getCampaign(Number(c.source_campaign_id))) as Record<string, unknown> | null;
            const kept = Object.fromEntries(KEEP_SETTINGS.filter((k) => src && src[k] != null).map((k) => [k, src![k]]));
            if (Object.keys(kept).length) settings = kept;
          }
          await sql`update placement_campaigns set settings = ${sql.json(settings as postgres.JSONValue)} where id = ${c.id}`;
          await sl.updateCampaignSettings(id!, { ...settings, stop_lead_settings: "REPLY_TO_AN_EMAIL", follow_up_percentage: 100 });
          step = "schedule";
          break;
        }
        case "schedule": {
          const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from placement_sends where campaign_id = ${c.id}`;
          const start = new Date(Math.max(new Date(c.starts_at).getTime(), now.getTime()));
          await sl.updateCampaignSchedule(id!, {
            timezone, days_of_the_week: [0, 1, 2, 3, 4, 5, 6], start_hour: "08:00", end_hour: "19:00",
            min_time_btw_emails: 5, max_new_leads_per_day: Math.max(1, n), schedule_start_time: start.toISOString(),
          });
          step = "sequence";
          break;
        }
        case "sequence":
          await sl.saveSequences(id!, [{ seq_number: 1, seq_delay_details: { delay_in_days: 0 }, subject: c.subject, email_body: bodyHtml(c.body) }]);
          step = "accounts";
          break;
        case "accounts":
          await sl.addAccountsToCampaign(id!, c.account_ids.map(Number));
          step = "leads";
          break;
        case "leads": {
          const sends = await sql<{ seed_email: string; first_name: string | null; company: string | null }[]>`
            select seed_email, first_name, company from placement_sends where campaign_id = ${c.id}`;
          const r = (await sl.addLeads(id!, sends.map((s) => ({ email: s.seed_email, first_name: s.first_name ?? "", company_name: s.company ?? "" })))) as Record<string, unknown> | null;
          const added = Number(r?.upload_count ?? r?.total_leads ?? sends.length);
          await sql`update placement_campaigns set leads_added = ${Number.isFinite(added) ? added : sends.length} where id = ${c.id}`;
          step = "start";
          break;
        }
        case "start":
          await sl.setCampaignStatus(id!, "START");
          await sql`update placement_campaigns set started_at = now() where id = ${c.id}`;
          step = "sending";
          break;
      }
      await sql`update placement_campaigns set step = ${step}, last_error = null where id = ${c.id}`;
    }
    return true;
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e).slice(0, 500);
    await sql`update placement_campaigns set attempts = attempts + 1, last_error = ${msg},
      step = case when attempts + 1 >= ${MAX_ATTEMPTS} then 'failed' else step end where id = ${c.id}`;
    return false;
  }
}

/** Who was sent the campaign, who auto-replied and who bounced: Smartlead's statistics, the webhook, and untracked replies. */
async function pollCampaign(sql: postgres.Sql, sl: Smartlead, c: CampaignRow) {
  const smId = Number(c.smartlead_campaign_id);
  const rows: NonNullable<ReturnType<typeof parseStatRow>>[] = [];
  for (let offset = 0; offset < 10_000; offset += 100) {
    const page = asArray(await sl.campaignStatistics(smId, offset, 100));
    for (const r of page) {
      const p = parseStatRow(r);
      if (p) rows.push(p);
    }
    if (page.length < 100) break;
  }
  if (rows.length) {
    await sql`
      update placement_sends ps set
        sent_at = coalesce(ps.sent_at, x.sent_at),
        reply_source = case when ps.replied_at is null and x.replied_at is not null then 'smartlead' else ps.reply_source end,
        replied_at = coalesce(ps.replied_at, x.replied_at),
        bounced_at = coalesce(ps.bounced_at, case when x.bounced then coalesce(x.sent_at, now()) end)
      from jsonb_to_recordset(${sql.json(rows.map((r) => ({ email: r.email, sent_at: r.sentAt, replied_at: r.repliedAt, bounced: r.bounced })))})
        as x(email text, sent_at timestamptz, replied_at timestamptz, bounced boolean)
      where ps.campaign_id = ${c.id} and ps.seed_email = x.email`;
  }
  // The webhook's replies and bounces for this campaign.
  await sql`
    update placement_sends ps set replied_at = e.at, reply_source = 'webhook', sent_at = coalesce(ps.sent_at, e.at)
    from (select lower(lead_email) as email, min(occurred_at) as at from email_events
          where campaign_id = ${smId} and kind = 'reply' group by 1) e
    where ps.campaign_id = ${c.id} and ps.seed_email = e.email and ps.replied_at is null`;
  await sql`
    update placement_sends ps set bounced_at = e.at, sent_at = coalesce(ps.sent_at, e.at)
    from (select lower(lead_email) as email, min(occurred_at) as at from email_events
          where campaign_id = ${smId} and kind = 'bounce' group by 1) e
    where ps.campaign_id = ${c.id} and ps.seed_email = e.email and ps.bounced_at is null`;
  // Auto-replies Smartlead couldn't tie to the lead (sent from another address) land in untracked
  // replies: the seed's own address, or its company when no other seed there had mail from this domain.
  await sql`
    update placement_sends ps set replied_at = u.at, reply_source = 'untracked'
    from (
      select ps2.seed_email, min(coalesce(u.received_at, u.first_seen_at)) as at
      from placement_sends ps2
      join untracked_replies u on u.account_id = any(${c.account_ids.map(Number)}::bigint[])
        and coalesce(u.received_at, u.first_seen_at) > ps2.sent_at
        and (lower(u.sender_email) = ps2.seed_email
          or (split_part(lower(u.sender_email), '@', 2) = split_part(ps2.seed_email, '@', 2)
              and (select count(*) from placement_sends o join placement_campaigns oc on oc.id = o.campaign_id
                   where oc.placement_domain_id = ${c.placement_domain_id}
                     and split_part(o.seed_email, '@', 2) = split_part(ps2.seed_email, '@', 2)) = 1))
      where ps2.campaign_id = ${c.id} and ps2.sent_at is not null and ps2.replied_at is null
      group by 1
    ) u
    where ps.campaign_id = ${c.id} and ps.seed_email = u.seed_email and ps.replied_at is null`;
  await sql`update placement_campaigns set polled_at = now() where id = ${c.id}`;
}

/** Stops a campaign once every lead it will send has had WAIT_HOURS to answer (or it ran out of time), and passes what it learned to the seeds. */
async function closeIfDone(sql: postgres.Sql, sl: Smartlead, c: CampaignRow, now: Date) {
  const [s] = await sql<{ total: number; sent: number; last: Date | null }[]>`
    select count(*)::int as total, count(sent_at)::int as sent, max(sent_at) as last from placement_sends where campaign_id = ${c.id}`;
  const expected = Math.min(s.total, c.leads_added ?? s.total);
  const began = Math.max(new Date(c.starts_at).getTime(), c.started_at ? new Date(c.started_at).getTime() : 0);
  const waited = s.last ? now.getTime() - new Date(s.last).getTime() >= WAIT_HOURS * HOUR : false;
  const allSent = s.sent >= expected;
  const outOfTime = now.getTime() - began >= GIVE_UP_HOURS * HOUR && (waited || !s.last);
  if (!((allSent && waited) || outOfTime)) return false;
  try { await sl.setCampaignStatus(Number(c.smartlead_campaign_id), "STOPPED"); } catch { /* already stopped or completed */ }
  await sql`update placement_campaigns set step = 'closed', closed_at = now() where id = ${c.id}`;
  await sql`update placement_seeds s set last_reply_at = greatest(s.last_reply_at, ps.replied_at), updated_at = now()
    from placement_sends ps where ps.campaign_id = ${c.id} and ps.seed_email = s.email and ps.replied_at is not null`;
  await sql`update placement_seeds s set bounced_at = greatest(s.bounced_at, ps.bounced_at), updated_at = now()
    from placement_sends ps where ps.campaign_id = ${c.id} and ps.seed_email = s.email and ps.bounced_at is not null`;
  return true;
}
