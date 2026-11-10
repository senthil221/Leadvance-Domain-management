import type postgres from "postgres";
import type { RegistrarAccount } from "../integrations/registrars";

type Sql = postgres.Sql;

/**
 * One registrar account's domains into inventory. New ones start in storage;
 * existing ones get the registrar, account, dates and flags refreshed but
 * keep their status. Nameservers from the list (Spaceship) fill in domains
 * that have none yet; the DNS check keeps them current after that. Each listed
 * domain is stamped as seen; after a whole list, the account's domains not on
 * it count as gone from the account (domain_gone_from_registrar).
 */
export async function syncRegistrarDomains(sql: Sql, account: RegistrarAccount) {
  const domains = await account.client.listAll();
  if (domains.length === 0) return { domains: 0, added: 0, updated: 0, gone: 0 };

  const rows = domains.map((d) => ({
    name: d.name,
    status: d.status,
    created: d.createdAt?.toISOString().slice(0, 10) ?? null,
    expires: d.expiresAt?.toISOString().slice(0, 10) ?? null,
    auto_renew: d.autoRenew,
    api_access: d.apiAccess,
    ns: d.nameservers ?? [],
  }));

  return sql.begin(async (tx) => {
    await tx`select set_config('app.actor', ${`${account.vendor} sync`}, true)`;
    const [vendor] = await tx`select id from vendors where name = ${account.vendor}`;
    if (!vendor) throw new Error(`No vendor row for ${account.vendor}; run the database migrations`);
    const result = await tx`
      insert into domains (name, registrar_id, registrar_account_id, purchased_at, expires_at, auto_renew, registrar_api_access, registrar_status, nameservers, registrar_seen_at)
      select r.name, ${vendor.id}, ${account.id}::uuid, r.created::date, r.expires::date, r.auto_renew, r.api_access, r.status,
        array(select jsonb_array_elements_text(r.ns)), now()
      from jsonb_to_recordset(${tx.json(rows)}) as r(name text, status text, created text, expires text, auto_renew boolean, api_access boolean, ns jsonb)
      on conflict (name) do update set
        registrar_id         = excluded.registrar_id,
        registrar_account_id = coalesce(excluded.registrar_account_id, domains.registrar_account_id),
        purchased_at         = coalesce(domains.purchased_at, excluded.purchased_at),
        expires_at           = coalesce(excluded.expires_at, domains.expires_at),
        auto_renew           = coalesce(excluded.auto_renew, domains.auto_renew),
        registrar_api_access = excluded.registrar_api_access,
        registrar_status     = coalesce(excluded.registrar_status, domains.registrar_status),
        nameservers          = case when cardinality(domains.nameservers) = 0 then excluded.nameservers else domains.nameservers end,
        registrar_seen_at    = now()
      returning (xmax = 0) as inserted`;
    const added = result.filter((r) => r.inserted).length;
    // A whole list: what this account had before and didn't list now has left
    // it. A list under half the account's known domains is taken as cut short,
    // and nothing is judged from it.
    let gone = 0;
    if (account.id) {
      const [{ known }] = await tx`select count(*)::int as known from domains where registrar_account_id = ${account.id}::uuid and archived_at is null`;
      if (domains.length >= known / 2) {
        await tx`update registrar_accounts set listed_at = now() where id = ${account.id}::uuid`;
        [{ gone }] = await tx`select count(*)::int as gone from domains
          where registrar_account_id = ${account.id}::uuid and archived_at is null and (registrar_seen_at is null or registrar_seen_at < now())`;
      }
    }
    return { domains: domains.length, added, updated: result.length - added, gone };
  });
}

/** Every account in turn; one failing doesn't stop the rest. */
export async function syncAllRegistrars(sql: Sql, accounts: RegistrarAccount[], broken: { id: string; error: string }[] = []) {
  for (const b of broken) {
    await sql`update registrar_accounts set last_synced_at = now(), last_ok = false, last_error = ${b.error} where id = ${b.id}`;
  }
  if (!accounts.length && !broken.length) return { skipped: "No registrar connected (Settings → Connections)" };
  let domains = 0, added = 0, gone = 0, failed = broken.length;
  const errors: string[] = broken.map((b) => b.error);
  for (const a of accounts) {
    try {
      const r = await syncRegistrarDomains(sql, a);
      domains += r.domains; added += r.added; gone += r.gone ?? 0;
      if (a.id) await sql`update registrar_accounts set last_synced_at = now(), last_ok = true, last_error = null, domain_count = ${r.domains} where id = ${a.id}`;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${a.vendor} (${a.label}): ${msg}`);
      if (a.id) await sql`update registrar_accounts set last_synced_at = now(), last_ok = false, last_error = ${msg.slice(0, 1000)} where id = ${a.id}`;
    }
  }
  if (failed && failed === accounts.length + broken.length) throw new Error(errors.join("; "));
  return { accounts: accounts.length + broken.length, domains, added, gone, ...(failed ? { failed, errors: errors.join("; ").slice(0, 500) } : {}) };
}
