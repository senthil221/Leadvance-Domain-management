import type postgres from "postgres";
import type { Smartlead } from "../integrations/smartlead";
import { parseAccount, parseCampaign, parseClient, parseDomainHealth, type SmartleadAccount } from "../integrations/smartlead-parse";

// Pulls Smartlead's view of the world into the database. Each function is
// one worker job. Queries only read single-word result columns so they work
// with the worker's plain connection and the app's camel-cased one.

type Sql = postgres.Sql;

/** Clients by Smartlead id; matches existing clients by name the first time. */
export async function syncClients(sql: Sql, sl: Smartlead) {
  const clients = (await sl.listClients()).map(parseClient).filter((c): c is NonNullable<typeof c> => c !== null);
  for (const c of clients) {
    const linked = await sql`update clients set smartlead_client_id = ${c.id}
      where smartlead_client_id is null and lower(name) = lower(${c.name})
        and not exists (select 1 from clients x where x.smartlead_client_id = ${c.id})
      returning id`;
    if (!linked.length) {
      await sql`insert into clients (name, smartlead_client_id, hue)
        values (${c.name}, ${c.id}, (select (count(*) * 47 + 255) % 360 from clients))
        on conflict do nothing`;
    }
  }
  return { clients: clients.length };
}

/**
 * Inboxes and their settings. A domain seen in Smartlead but missing from
 * inventory is added (active if any inbox has a campaign limit, else warming),
 * so the inventory fills itself from what is already sending.
 */
export async function syncAccounts(sql: Sql, sl: Smartlead) {
  const accounts = (await sl.listEmailAccounts()).map(parseAccount).filter((a): a is SmartleadAccount => a !== null);
  if (accounts.length === 0) return { accounts: 0, newDomains: 0, upserted: 0, removed: 0 };

  const rows = accounts.map((a) => ({
    id: a.id, email: a.email, domain: a.domain, sender_name: a.senderName, client_id: a.clientId,
    daily_limit: a.dailyLimit, warmup_enabled: a.warmupEnabled, warmup_per_day: a.warmupPerDay,
    warmup_rampup: a.warmupRampup, warmup_reputation: a.warmupReputation, connected: a.connected,
    tags: a.tags, provider_type: a.providerType, min_wait_mins: a.minWaitMins, daily_sent: a.dailySent,
    campaign_count: a.campaignCount, warmup_status: a.warmupStatus, warmup_min: a.warmupMin, warmup_reply_rate: a.warmupReplyRate,
  }));
  const ids = accounts.map((a) => a.id);
  const emails = accounts.map((a) => a.email);
  // Built per query, from the connection running it.
  const recordset = (q: postgres.Sql | postgres.TransactionSql) => q`jsonb_to_recordset(${q.json(rows)}) as r(
    id bigint, email text, domain text, sender_name text, client_id bigint, daily_limit int, warmup_enabled boolean,
    warmup_per_day int, warmup_rampup int, warmup_reputation numeric, connected boolean, tags text[], provider_type text,
    min_wait_mins int, daily_sent int, campaign_count int, warmup_status text, warmup_min int, warmup_reply_rate int)`;

  return sql.begin(async (tx) => {
    await tx`select set_config('app.actor', 'smartlead sync', true)`;

    const newDomains = await tx`
      insert into domains (name, status, client_id, inbox_provider_id)
      select r.domain,
        (case when max(coalesce(r.daily_limit, 0)) > 0 then 'active' else 'warming' end)::domain_status,
        (select c.id from clients c where c.smartlead_client_id = max(r.client_id)),
        (select v.id from vendors v where v.name = 'Hypertide')
      from ${recordset(tx)}
      where r.domain ~ '^[a-z0-9-]+(\\.[a-z0-9-]+)+$'
      group by r.domain
      on conflict (name) do nothing
      returning id`;

    // An account id that moved to a new address frees the old row first.
    await tx`update inboxes set smartlead_account_id = null
      where smartlead_account_id = any(${ids}::bigint[]) and not (email = any(${emails}::text[]))`;

    const upserted = await tx`
      insert into inboxes (domain_id, email, sender_name, smartlead_account_id, warmup_enabled, warmup_per_day, warmup_rampup,
        daily_limit, warmup_reputation, status, last_synced_at, pending_changes, smartlead_tags, provider_type, min_wait_mins,
        daily_sent, campaign_count, warmup_status, warmup_min, warmup_reply_rate)
      select d.id, r.email, r.sender_name, r.id, r.warmup_enabled, r.warmup_per_day, r.warmup_rampup,
        r.daily_limit, r.warmup_reputation, case when r.connected then 'connected' else 'disconnected' end, now(), null,
        coalesce(r.tags, '{}'), r.provider_type, r.min_wait_mins, r.daily_sent, r.campaign_count, r.warmup_status, r.warmup_min, r.warmup_reply_rate
      from ${recordset(tx)} join domains d on d.name = r.domain
      on conflict (email) do update set
        domain_id            = excluded.domain_id,
        sender_name          = coalesce(excluded.sender_name, inboxes.sender_name),
        smartlead_account_id = excluded.smartlead_account_id,
        warmup_enabled       = coalesce(excluded.warmup_enabled, inboxes.warmup_enabled),
        warmup_per_day       = coalesce(excluded.warmup_per_day, inboxes.warmup_per_day),
        warmup_rampup        = coalesce(excluded.warmup_rampup, inboxes.warmup_rampup),
        daily_limit          = coalesce(excluded.daily_limit, inboxes.daily_limit),
        warmup_reputation    = coalesce(excluded.warmup_reputation, inboxes.warmup_reputation),
        status               = excluded.status,
        last_synced_at       = now(),
        pending_changes      = null,
        smartlead_tags       = excluded.smartlead_tags,
        provider_type        = coalesce(excluded.provider_type, inboxes.provider_type),
        min_wait_mins        = coalesce(excluded.min_wait_mins, inboxes.min_wait_mins),
        daily_sent           = excluded.daily_sent,
        campaign_count       = excluded.campaign_count,
        warmup_status        = coalesce(excluded.warmup_status, inboxes.warmup_status),
        warmup_min           = coalesce(excluded.warmup_min, inboxes.warmup_min),
        warmup_reply_rate    = coalesce(excluded.warmup_reply_rate, inboxes.warmup_reply_rate)
      returning id`;

    const removed = await tx`
      update inboxes set status = 'removed', last_synced_at = now()
      where smartlead_account_id is not null and status <> 'removed' and not (smartlead_account_id = any(${ids}::bigint[]))
      returning id`;

    // A domain sitting in storage (say, imported from Porkbun first) that turns
    // out to be sending in Smartlead is really active or warming. So is one set
    // up by hand (provisioning) once its inboxes connect; domains inside a
    // running replacement are left to the replacement steps.
    const promoted = await tx`
      select transition_domain(d.id,
        (case when max(coalesce(i.daily_limit, 0)) > 0 then 'active' else 'warming' end)::domain_status,
        (case when d.status = 'in_storage' then 'found sending in Smartlead' else 'inboxes connected in Smartlead' end),
        'smartlead sync', null, true) as id
      from domains d join inboxes i on i.domain_id = d.id and i.status = 'connected'
      where (d.status = 'in_storage' or (d.status = 'provisioning' and not exists (
        select 1 from replacement_items ri join replacement_batches rb on rb.id = ri.batch_id
        where ri.new_domain_id = d.id and rb.status = 'running' and ri.completed_at is null)))
      group by d.id, d.status`;

    // Domains without a client take the one their Smartlead inboxes belong to.
    await tx`
      update domains d set client_id = c.id
      from (select r.domain, max(r.client_id) as sl_client from ${recordset(tx)} group by r.domain) x
      join clients c on c.smartlead_client_id = x.sl_client
      where d.name = x.domain and d.client_id is null and d.status <> 'in_storage'`;

    const tagged = await clientsFromTags(tx);
    return { accounts: accounts.length, newDomains: newDomains.length, promoted: promoted.length, upserted: upserted.length, removed: removed.length, ...tagged };
  });
}

/**
 * Smartlead inbox tags are client names (one per inbox). Every tag becomes a
 * client, and a domain without a client takes the tag most of its inboxes carry.
 */
export async function clientsFromTags(sql: postgres.Sql | postgres.TransactionSql) {
  const created = await sql`
    insert into clients (name, hue)
    select t.name, (abs(hashtext(t.name)) % 360)
    from (select distinct trim(unnest(smartlead_tags)) as name from inboxes where status <> 'removed') t
    where t.name <> '' and not exists (select 1 from clients c where lower(c.name) = lower(t.name))
    returning id`;
  const assigned = await sql`
    update domains d set client_id = x.client_id
    from (
      select distinct on (i.domain_id) i.domain_id, c.id as client_id
      from inboxes i cross join lateral unnest(i.smartlead_tags) tag
      join clients c on lower(c.name) = lower(trim(tag)) and c.archived_at is null
      where i.status <> 'removed'
      group by i.domain_id, c.id
      order by i.domain_id, count(*) desc
    ) x
    where d.id = x.domain_id and d.client_id is null
    returning d.id`;
  return { clientsFromTags: created.length, domainsTagged: assigned.length };
}

const LIVE_CAMPAIGN = new Set(["ACTIVE", "PAUSED", "START", "STARTED", "SCHEDULED"]);

/** Campaigns, and which inboxes send in each live one. */
export async function syncCampaigns(sql: Sql, sl: Smartlead) {
  const campaigns = (await sl.listCampaigns()).map(parseCampaign).filter((c): c is NonNullable<typeof c> => c !== null);
  if (campaigns.length) {
    await sql`
      insert into campaigns (id, name, status, client_id, synced_at)
      select c.id, c.name, c.status, (select x.id from clients x where x.smartlead_client_id = c.client_id), now()
      from jsonb_to_recordset(${sql.json(campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status, client_id: c.clientId })))})
        as c(id bigint, name text, status text, client_id bigint)
      on conflict (id) do update set name = excluded.name, status = excluded.status,
        client_id = coalesce(excluded.client_id, campaigns.client_id), synced_at = now()`;
  }

  let mapped = 0;
  for (const c of campaigns.filter((x) => LIVE_CAMPAIGN.has((x.status ?? "").toUpperCase()))) {
    const accountIds = (await sl.campaignEmailAccounts(c.id))
      .map((a) => {
        const o = a as Record<string, unknown>;
        return Number(o.email_account_id ?? o.id);
      })
      .filter(Number.isFinite);
    await sql.begin(async (tx) => {
      await tx`delete from campaign_inboxes where campaign_id = ${c.id}`;
      if (accountIds.length) {
        await tx`insert into campaign_inboxes (campaign_id, inbox_id)
          select ${c.id}, i.id from inboxes i where i.smartlead_account_id = any(${accountIds}::bigint[])
          on conflict do nothing`;
      }
    });
    mapped++;
  }
  const [assigned] = await sql`select campaigns, domains from assign_clients_from_campaigns()`;
  return { campaigns: campaigns.length, mapped, campaignClients: Number(assigned.campaigns), domainClients: Number(assigned.domains) };
}

// YYYY-MM-DD for a date in a timezone.
export function dayIn(tz: string, offsetDays = 0, now = new Date()) {
  const d = new Date(now.getTime() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/**
 * Smartlead's per-domain totals for the last 7 days. Its domain analytics
 * return nothing for one- or two-day ranges, so the app's daily numbers come
 * from the Email Sent webhook and these are kept as a cross-check.
 */
export async function syncDomainStats(sql: Sql, sl: Smartlead, tz: string) {
  const raw = await sl.domainHealth(dayIn(tz, -7), dayIn(tz, 0), tz);
  const { rows, recognised } = parseDomainHealth(raw);
  if (!recognised) {
    throw new Error(`Unrecognised domain-wise analytics response, sample: ${JSON.stringify(raw).slice(0, 400)}`);
  }
  await sql.begin(async (tx) => {
    await tx`delete from smartlead_domain_7d`;
    if (rows.length) {
      await tx`
        insert into smartlead_domain_7d (domain_name, sent, replies, bounces, synced_at)
        select r.domain, r.sent, coalesce(r.replies, 0), coalesce(r.bounces, 0), now()
        from jsonb_to_recordset(${tx.json(rows.map((r) => ({ domain: r.domain, sent: r.sent, replies: r.replies, bounces: r.bounces })))})
          as r(domain text, sent int, replies int, bounces int)
        on conflict (domain_name) do update set sent = excluded.sent, replies = excluded.replies, bounces = excluded.bounces, synced_at = now()`;
    }
  });
  return { domains7d: rows.length, sent7d: rows.reduce((n, r) => n + r.sent, 0) };
}
