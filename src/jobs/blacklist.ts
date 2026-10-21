import type postgres from "postgres";
import type { BlacklistEntry, SmartleadApp } from "../integrations/smartlead-app";

type Sql = postgres.Sql;

/**
 * Blacklist status per sending domain. Smartlead scans blacklists per
 * campaign and lists every sending domain in it, so this walks the campaigns
 * that still send and keeps the first answer per domain (the status is about
 * the domain and its IP, not the campaign).
 */
export async function syncBlacklists(sql: Sql, app: SmartleadApp, concurrency = 4) {
  const campaigns = await sql`
    select id from campaigns where upper(coalesce(status, '')) in ('ACTIVE', 'PAUSED', 'START', 'STARTED', 'SCHEDULED') order by id`;
  const byDomain = new Map<string, BlacklistEntry>();
  let failed = 0;
  let lastError: string | null = null;
  const queue = campaigns.map((c) => Number(c.id));
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        for (const e of await app.blacklist(id)) if (!byDomain.has(e.domain)) byDomain.set(e.domain, e);
      } catch (e) {
        failed++;
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));
  if (campaigns.length && failed === campaigns.length) throw new Error(lastError ?? "every blacklist request failed");

  const rows = [...byDomain.values()].map((e) => ({ domain: e.domain, dc: e.domainCount, ic: e.ipCount, listings: e.listings }));
  const updated = rows.length
    ? await sql`
        update domains d set blacklist_domain_count = r.dc, blacklist_ip_count = r.ic, blacklist_listings = r.listings, blacklist_checked_at = now()
        from jsonb_to_recordset(${sql.json(rows)}) as r(domain text, dc int, ic int, listings jsonb)
        where d.name = r.domain
        returning d.id`
    : [];
  const listed = rows.filter((r) => r.dc + r.ic > 0).length;
  return { campaigns: campaigns.length, domains: updated.length, listed, failed };
}
