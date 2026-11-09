import { Resolver } from "node:dns/promises";
import type postgres from "postgres";
import { classifyReply } from "../lib/classify";
import { mxProvider, seedReason } from "../lib/placement-seeds";

// Placement seeds: collects the addresses whose auto-reply says the person has
// left, from campaign replies (email_events) and Smartlead's untracked replies,
// keeps their auto-reply count up to date, drops any that a person has since
// replied from or that bounced, and looks up who receives each company's mail.

export type MxLookup = (domain: string) => Promise<{ exchange: string; priority: number }[]>;

const resolver = new Resolver({ timeout: 4000, tries: 2 });
resolver.setServers(["1.1.1.1", "8.8.8.8"]);
const dnsMx: MxLookup = (domain) => resolver.resolveMx(domain);

/** Cheap text match in the database before the real test in seedReason. */
const PREFILTER = String.raw`no longer|longer (working|with)|has left|have left|left the|departed|retired|moved on|monitored|not in use|not active`;
/** Personal mailboxes: someone still reads them whatever the auto-reply says. */
const FREEMAIL = /^(?:gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|aol|proton|protonmail|gmx|mail|yandex|zoho)\.[a-z.]+$/;
/** The address an auto-reply is sent from rather than the mailbox we wrote to ("former-employee+noreply@"). */
const ALIAS = /(?:^|[._+-])(?:no-?reply|do-?not-?reply|auto-?respon\w*|auto-?reply|mailer-?daemon|postmaster|former-?(?:employee|staff)s?|formerstaff|alias\d*)(?:[._+-]|$)/;
const AUTO = new Set(["auto", "ooo"]);
/** Raised whenever the rules for what makes a seed change: the next run reads a year of replies again and rebuilds the list. */
export const SEED_RULES = 2;
const DAY = 86_400_000;

type Candidate = {
  email: string; domain: string; name: string | null; source: "reply" | "untracked"; excerpt: string; forwards: boolean;
  first: Date; last: Date; campaignName: string | null; clientId: string | null;
};

const domainOf = (email: string) => email.split("@")[1] ?? "";
const usable = (email: string | null) =>
  !!email && /^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) && !FREEMAIL.test(domainOf(email)) && !ALIAS.test(email.split("@")[0]);

export async function syncPlacementSeeds(sql: postgres.Sql, { lookupMx = dnsMx, maxLookups = 300, since }: {
  lookupMx?: MxLookup; maxLookups?: number; since?: Date;
} = {}) {
  const startedAt = new Date();
  // Only what arrived since the last good run (with a day's overlap); a year back the first time, or when the rules changed.
  let rebuild = false;
  if (!since) {
    const [state] = await sql<{ to: string | null; rules: string | null }[]>`
      select last_detail->>'scannedTo' as "to", last_detail->>'rules' as rules from job_state where job = 'placement-seeds' and last_ok`;
    rebuild = !!state?.to && state.rules !== String(SEED_RULES);
    since = state?.to && !rebuild ? new Date(new Date(state.to).getTime() - DAY) : new Date(startedAt.getTime() - 365 * DAY);
  }

  const found = new Map<string, Candidate>();
  const add = (c: Candidate) => {
    const was = found.get(c.email);
    if (!was) return void found.set(c.email, c);
    const newer = c.last > was.last ? c : was;
    found.set(c.email, {
      ...newer, name: newer.name ?? was.name ?? c.name, forwards: was.forwards || c.forwards,
      first: c.first < was.first ? c.first : was.first, last: newer.last,
    });
  };

  const events = await sql<{ email: string; preview: string; at: Date; campaign_name: string | null; client_id: string | null }[]>`
    select lower(lead_email) as email, preview, occurred_at as at, campaign_name, client_id
    from email_events
    where kind = 'reply' and reply_class in ('auto', 'ooo') and lead_email is not null
      and received_at >= ${since} and preview ~* ${PREFILTER}`;
  for (const e of events) {
    const why = usable(e.email) ? seedReason(e.preview) : null;
    if (why) add({ email: e.email, domain: domainOf(e.email), name: null, source: "reply", ...why, first: e.at, last: e.at, campaignName: e.campaign_name, clientId: e.client_id });
  }

  const untracked = await sql<{ email: string; name: string | null; subject: string | null; body: string; at: Date; client_id: string | null }[]>`
    select lower(u.sender_email) as email, u.sender_name as name, u.subject, u.body, coalesce(u.received_at, u.first_seen_at) as at, d.client_id
    from untracked_replies u
    left join inboxes i on i.smartlead_account_id = u.account_id
    left join domains d on d.id = i.domain_id
    where u.sender_email is not null and u.kind <> 'bounce' and u.first_seen_at >= ${since} and u.body ~* ${PREFILTER}`;
  for (const u of untracked) {
    if (!usable(u.email) || !AUTO.has(classifyReply(u.body, u.subject))) continue;
    const why = seedReason(u.body);
    if (why) add({ email: u.email, domain: domainOf(u.email), name: u.name, source: "untracked", ...why, first: u.at, last: u.at, campaignName: null, clientId: u.client_id });
  }

  // New rules: what they no longer take goes, and forwarding is judged afresh. Bounces and later replies are counted again below.
  if (rebuild) await sql`delete from placement_seeds`;
  let added = 0;
  for (const c of found.values()) {
    const [row] = await sql<{ inserted: boolean }[]>`
      insert into placement_seeds (email, domain, name, source, excerpt, forwards, first_reply_at, last_reply_at, campaign_name, client_id)
      values (${c.email}, ${c.domain}, ${c.name}, ${c.source}, ${c.excerpt}, ${c.forwards}, ${c.first}, ${c.last}, ${c.campaignName}, ${c.clientId})
      on conflict (email) do update set
        name = coalesce(excluded.name, placement_seeds.name),
        excerpt = case when excluded.last_reply_at >= placement_seeds.last_reply_at then excluded.excerpt else placement_seeds.excerpt end,
        campaign_name = case when excluded.last_reply_at >= placement_seeds.last_reply_at
          then coalesce(excluded.campaign_name, placement_seeds.campaign_name) else placement_seeds.campaign_name end,
        client_id = case when excluded.last_reply_at >= placement_seeds.last_reply_at
          then coalesce(excluded.client_id, placement_seeds.client_id) else placement_seeds.client_id end,
        forwards = placement_seeds.forwards or excluded.forwards,
        first_reply_at = least(placement_seeds.first_reply_at, excluded.first_reply_at),
        last_reply_at = greatest(placement_seeds.last_reply_at, excluded.last_reply_at),
        updated_at = now()
      returning (xmax = 0) as inserted`;
    if (row?.inserted) added++;
  }

  const dropped = await refreshSeeds(sql);
  const mx = await lookUpDomains(sql, lookupMx, maxLookups);
  const [{ seeds }] = await sql<{ seeds: number }[]>`select count(*)::int as seeds from placement_seeds`;
  return { seeds, found: found.size, added, ...(rebuild ? { rebuilt: true } : {}), ...dropped, ...mx, rules: SEED_RULES, scannedTo: startedAt.toISOString() };
}

/**
 * Every seed's auto-reply count, the first reply a person wrote from it after
 * its first auto-reply, and its latest bounce, from both sources.
 */
async function refreshSeeds(sql: postgres.Sql) {
  const seeds = await sql<{ email: string; first: Date; autos: number; person: Date | null; bounced: Date | null }[]>`
    select email, first_reply_at as first, auto_replies as autos, person_replied_at as person, bounced_at as bounced from placement_seeds`;
  if (!seeds.length) return { personReplied: 0, bounced: 0 };
  const emails = seeds.map((s) => s.email);
  const fromEvents = await sql<{ email: string; autos: number; person: Date | null; bounced: Date | null }[]>`
    select lower(e.lead_email) as email,
      count(*) filter (where e.kind = 'reply' and e.reply_class in ('auto', 'ooo'))::int as autos,
      min(e.occurred_at) filter (where e.kind = 'reply' and (e.reply_class is null or e.reply_class not in ('auto', 'ooo')) and e.occurred_at > s.first_reply_at) as person,
      max(e.occurred_at) filter (where e.kind = 'bounce') as bounced
    from email_events e join placement_seeds s on s.email = lower(e.lead_email)
    where e.kind in ('reply', 'bounce')
    group by 1`;
  const fromUntracked = await sql<{ email: string; subject: string | null; body: string | null; at: Date }[]>`
    select lower(sender_email) as email, subject, body, coalesce(received_at, first_seen_at) as at
    from untracked_replies where lower(sender_email) = any(${emails}::text[])`;

  const ev = new Map(fromEvents.map((e) => [e.email, e]));
  const un = new Map<string, { autos: number; person: Date | null }>();
  const firstOf = new Map(seeds.map((s) => [s.email, s.first]));
  for (const u of fromUntracked) {
    const x = un.get(u.email) ?? { autos: 0, person: null };
    if (AUTO.has(classifyReply(u.body, u.subject))) x.autos++;
    else if (u.at > firstOf.get(u.email)! && (!x.person || u.at < x.person)) x.person = u.at;
    un.set(u.email, x);
  }

  const time = (d: Date | null) => d?.getTime() ?? null;
  const changes = seeds.flatMap((s) => {
    const e = ev.get(s.email);
    const u = un.get(s.email);
    const autos = Math.max(1, (e?.autos ?? 0) + (u?.autos ?? 0));
    const people = [e?.person, u?.person].filter((d): d is Date => !!d);
    const person = people.length ? new Date(Math.min(...people.map((d) => d.getTime()))) : null;
    const bounced = e?.bounced ?? null;
    if (autos === s.autos && time(person) === time(s.person) && time(bounced) === time(s.bounced)) return [];
    return [{ email: s.email, autos, person: person?.toISOString() ?? null, bounced: bounced?.toISOString() ?? null }];
  });
  if (changes.length) {
    await sql`update placement_seeds s set auto_replies = x.autos, person_replied_at = x.person, bounced_at = x.bounced, updated_at = now()
      from jsonb_to_recordset(${sql.json(changes)}) as x(email text, autos int, person timestamptz, bounced timestamptz)
      where s.email = x.email`;
  }
  const [counts] = await sql<{ person: number; bounced: number }[]>`
    select count(*) filter (where person_replied_at is not null)::int as person,
      count(*) filter (where bounced_at > last_reply_at)::int as bounced
    from placement_seeds`;
  return { personReplied: counts.person, bounced: counts.bounced };
}

/** Errors that mean the domain has no MX (or doesn't exist), rather than a lookup that failed. */
const NO_MX = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN"]);

/** Looks up MX for seed domains never checked, or last checked over 30 days ago. A failed lookup is tried again a day later. */
async function lookUpDomains(sql: postgres.Sql, lookupMx: MxLookup, max: number) {
  const due = await sql<{ domain: string }[]>`
    select distinct s.domain from placement_seeds s
    left join placement_seed_domains d on d.domain = s.domain
    where d.checked_at is null or d.checked_at < now() - interval '30 days'
    order by 1 limit ${max}`;
  let lookedUp = 0;
  let lookupErrors = 0;
  for (let i = 0; i < due.length; i += 10) {
    await Promise.all(due.slice(i, i + 10).map(async ({ domain }) => {
      let result: ReturnType<typeof mxProvider> | null = null;
      let error: string | null = null;
      try {
        result = mxProvider(await lookupMx(domain));
      } catch (e) {
        const code = (e as { code?: string }).code ?? "";
        if (NO_MX.has(code)) result = { provider: "none", name: null, host: null };
        else error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      }
      if (result) lookedUp++; else lookupErrors++;
      await sql`
        insert into placement_seed_domains (domain, provider, provider_name, mx_host, checked_at, error)
        values (${domain}, ${result?.provider ?? null}, ${result?.name ?? null}, ${result?.host ?? null},
          ${result ? sql`now()` : sql`now() - interval '29 days'`}, ${error})
        on conflict (domain) do update set
          -- A failed lookup keeps what the last good one found.
          provider = case when excluded.provider is null then placement_seed_domains.provider else excluded.provider end,
          provider_name = case when excluded.provider is null then placement_seed_domains.provider_name else excluded.provider_name end,
          mx_host = case when excluded.provider is null then placement_seed_domains.mx_host else excluded.mx_host end,
          checked_at = excluded.checked_at, error = excluded.error`;
    }));
  }
  return { lookedUp, lookupErrors };
}
