import type postgres from "postgres";
import type { Porkbun } from "../integrations/porkbun";

type Sql = postgres.Sql;

/**
 * Every Porkbun domain into inventory. New ones start in storage; existing
 * ones get the registrar, dates and flags refreshed but keep their status.
 */
export async function syncPorkbunDomains(sql: Sql, pb: Porkbun) {
  const domains = await pb.listAll();
  if (domains.length === 0) return { porkbunDomains: 0, added: 0, updated: 0 };

  const rows = domains.map((d) => ({
    name: d.name,
    status: d.status,
    created: d.createdAt?.toISOString().slice(0, 10) ?? null,
    expires: d.expiresAt?.toISOString().slice(0, 10) ?? null,
    auto_renew: d.autoRenew,
    api_access: d.apiAccess,
  }));

  return sql.begin(async (tx) => {
    await tx`select set_config('app.actor', 'porkbun sync', true)`;
    const [porkbun] = await tx`select id from vendors where name = 'Porkbun'`;
    const result = await tx`
      insert into domains (name, registrar_id, purchased_at, expires_at, auto_renew, registrar_api_access, registrar_status)
      select r.name, ${porkbun.id}, r.created::date, r.expires::date, r.auto_renew, r.api_access, r.status
      from jsonb_to_recordset(${tx.json(rows)}) as r(name text, status text, created text, expires text, auto_renew boolean, api_access boolean)
      on conflict (name) do update set
        registrar_id         = excluded.registrar_id,
        purchased_at         = coalesce(domains.purchased_at, excluded.purchased_at),
        expires_at           = coalesce(excluded.expires_at, domains.expires_at),
        auto_renew           = excluded.auto_renew,
        registrar_api_access = excluded.registrar_api_access,
        registrar_status     = excluded.registrar_status
      returning (xmax = 0) as inserted`;
    const added = result.filter((r) => r.inserted).length;
    return { porkbunDomains: domains.length, added, updated: result.length - added };
  });
}

/** Current nameservers for the Porkbun domains checked longest ago. */
export async function syncPorkbunNameservers(sql: Sql, pb: Porkbun, batch = 60) {
  const due = await sql`
    select d.id, d.name from domains d join vendors v on v.id = d.registrar_id
    where v.name = 'Porkbun' and d.registrar_api_access is not false and d.status not in ('burned', 'resting')
    order by d.nameservers_checked_at nulls first, d.name
    limit ${batch}`;
  let checked = 0, failed = 0;
  let lastError: string | null = null;
  for (const d of due) {
    try {
      const ns = await pb.getNs(d.name as string);
      await sql`update domains set nameservers = ${ns}, nameservers_checked_at = now() where id = ${d.id}`;
      checked++;
    } catch (e) {
      failed++;
      lastError = e instanceof Error ? e.message : String(e);
      // Don't retry a failing domain on every run.
      await sql`update domains set nameservers_checked_at = now() where id = ${d.id}`;
    }
  }
  if (failed && !checked) throw new Error(lastError ?? "nameserver checks failed");
  return { checked, failed };
}
