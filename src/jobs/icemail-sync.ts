import type postgres from "postgres";
import { createIcemail, type Icemail } from "../integrations/icemail";
import { open } from "../lib/secret-box";

type Sql = postgres.Sql;

export type IcemailAccount = { id: string; label: string; client: Icemail };

/** Every workspace added in Settings; one whose key can't be decrypted is left out and reported. Writes follow INTEGRATIONS_DRY_RUN. */
export async function loadIcemailAccounts(sql: Sql, { dryRun = process.env.INTEGRATIONS_DRY_RUN !== "false" }: { dryRun?: boolean } = {}) {
  const accounts: IcemailAccount[] = [];
  const broken: { id: string; error: string }[] = [];
  const rows = await sql`select id, label, credentials from icemail_accounts order by created_at`.catch(() => []);
  for (const r of rows) {
    try {
      accounts.push({ id: r.id as string, label: r.label as string, client: createIcemail({ apiKey: open(r.credentials as string).apiKey, sql, dryRun }) });
    } catch (e) {
      broken.push({ id: r.id as string, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { accounts, broken };
}

/**
 * One workspace's domains and mailboxes into the mirror tables, linked to the
 * domains and inboxes the Smartlead sync already knows by name and email.
 * A domain Icemail has that the app doesn't is added as an Icemail domain;
 * one with live mailboxes still sitting in storage is being set up, so it
 * isn't offered as a free domain. Rows Icemail stops listing are marked gone.
 */
export async function syncIcemailAccount(sql: Sql, account: IcemailAccount) {
  const { client } = account;
  const workspace = await client.workspace();
  const [domains, mailboxes, wallet, prices] = await Promise.all([
    client.listDomains(),
    client.listMailboxes(),
    client.wallet().catch(() => null),
    client.prices().catch(() => null),
  ]);

  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.actor', 'icemail sync', true)`;
    const [vendor] = await tx`select id from vendors where name = 'Icemail'`;
    if (!vendor) throw new Error("No vendor row for Icemail; run the database migrations");

    const names = [...new Set([...domains.map((d) => d.name), ...mailboxes.map((m) => m.domain).filter((x): x is string => Boolean(x))])];
    const added = names.length
      ? await tx`insert into domains (name, inbox_provider_id) select unnest(${names}::text[]), ${vendor.id}::uuid
          on conflict (name) do nothing returning id`
      : [];

    if (domains.length) {
      await tx`
        insert into icemail_domains (id, account_id, domain_name, domain_id, status, active, imported, prewarmed, blacklisted,
          spf, dkim, dmarc, mx, provider, mailbox_count, created_on, expires_on)
        select r.id, ${account.id}::uuid, r.name, d.id, r.status, r.active, r.imported, r.prewarmed, r.blacklisted,
          r.spf, r.dkim, r.dmarc, r.mx, r.provider, r.mailbox_count, r.created_on::date, r.expires_on::date
        from jsonb_to_recordset(${tx.json(domains.map((d) => ({ ...d, mailbox_count: d.mailboxCount, created_on: d.createdOn, expires_on: d.expiresOn })))})
          as r(id text, name text, status text, active boolean, imported boolean, prewarmed boolean, blacklisted boolean,
            spf boolean, dkim boolean, dmarc boolean, mx boolean, provider text, mailbox_count int, created_on text, expires_on text)
        left join domains d on d.name = r.name
        on conflict (id) do update set
          account_id = excluded.account_id, domain_name = excluded.domain_name, domain_id = excluded.domain_id,
          status = excluded.status, active = excluded.active, imported = excluded.imported, prewarmed = excluded.prewarmed,
          blacklisted = excluded.blacklisted, spf = excluded.spf, dkim = excluded.dkim, dmarc = excluded.dmarc, mx = excluded.mx,
          provider = excluded.provider, mailbox_count = excluded.mailbox_count, created_on = excluded.created_on,
          expires_on = excluded.expires_on, last_seen_at = now(), gone_at = null`;
    }
    const goneDomains = await tx`
      update icemail_domains set gone_at = now()
      where account_id = ${account.id} and gone_at is null and not (id = any(${domains.map((d) => d.id)}::text[])) returning id`;

    if (mailboxes.length) {
      await tx`
        insert into icemail_mailboxes (id, account_id, icemail_domain_id, domain_id, inbox_id, email, first_name, last_name,
          provider, status, active, master_inbox, cost, billing_cycle, next_billing_on, created_on)
        select r.id, ${account.id}::uuid, r.domain_id, d.id, i.id, r.email, r.first_name, r.last_name,
          r.provider, r.status, r.active, r.master_inbox, r.cost, r.billing_cycle, r.next_billing_on::date, r.created_on::date
        from jsonb_to_recordset(${tx.json(mailboxes.map((m) => ({
          id: m.id, domain_id: m.domainId, domain: m.domain, email: m.email, first_name: m.firstName, last_name: m.lastName,
          provider: m.provider, status: m.status, active: m.active, master_inbox: m.masterInbox, cost: m.cost,
          billing_cycle: m.billingCycle, next_billing_on: m.nextBillingOn, created_on: m.createdOn,
        })))})
          as r(id text, domain_id text, domain text, email text, first_name text, last_name text, provider text, status text,
            active boolean, master_inbox boolean, cost numeric, billing_cycle text, next_billing_on text, created_on text)
        left join domains d on d.name = r.domain
        left join inboxes i on i.email = r.email
        on conflict (id) do update set
          account_id = excluded.account_id, icemail_domain_id = excluded.icemail_domain_id, domain_id = excluded.domain_id,
          inbox_id = excluded.inbox_id, email = excluded.email, first_name = excluded.first_name, last_name = excluded.last_name,
          provider = excluded.provider, status = excluded.status, active = excluded.active, master_inbox = excluded.master_inbox,
          cost = excluded.cost, billing_cycle = excluded.billing_cycle, next_billing_on = excluded.next_billing_on,
          created_on = excluded.created_on, last_seen_at = now(), gone_at = null`;
    }
    const goneMailboxes = await tx`
      update icemail_mailboxes set gone_at = now()
      where account_id = ${account.id} and gone_at is null and not (id = any(${mailboxes.map((m) => m.id)}::text[])) returning id`;

    // Inboxes Smartlead added after Icemail last listed them.
    await tx`
      update icemail_mailboxes m set inbox_id = i.id from inboxes i
      where m.inbox_id is null and i.email = m.email`;

    await tx`
      update domains d set inbox_provider_id = ${vendor.id}
      where d.inbox_provider_id is distinct from ${vendor.id}
        and exists (select 1 from icemail_mailboxes m where m.domain_id = d.id and m.gone_at is null)`;

    // Bought at Icemail: the registration ends when Icemail says.
    await tx`
      update domains d set expires_at = x.expires_on from icemail_domains x
      where x.domain_id = d.id and x.gone_at is null and not coalesce(x.imported, true) and x.expires_on is not null
        and d.expires_at is distinct from x.expires_on and d.registrar_id is null`;

    const provisioning = await tx`
      select transition_domain(d.id, 'provisioning', 'mailboxes on Icemail', 'icemail sync') as id
      from domains d
      where d.status = 'in_storage'
        and exists (select 1 from icemail_mailboxes m where m.domain_id = d.id and m.gone_at is null)`;

    const [auto] = await tx`select * from replace_dropped_domains()`;

    const linked = mailboxes.length
      ? (await tx`select count(*)::int as n from icemail_mailboxes where account_id = ${account.id} and gone_at is null and inbox_id is not null`)[0].n
      : 0;

    return { added: added.length, goneDomains: goneDomains.length, goneMailboxes: goneMailboxes.length, provisioning: provisioning.length, linked: Number(linked), autoReplaced: auto.moved as number, autoRestored: auto.restored as number };
  });

  await sql`
    update icemail_accounts set workspace_id = coalesce(${workspace.id}, workspace_id), workspace_name = coalesce(${workspace.name}, workspace_name),
      wallet_balance = coalesce(${wallet?.balance ?? null}, wallet_balance), wallet_currency = coalesce(${wallet?.currency ?? null}, wallet_currency),
      auto_topup = coalesce(${wallet?.autoTopup ?? null}, auto_topup),
      price_google = coalesce(${prices?.google ?? null}, price_google), price_microsoft = coalesce(${prices?.microsoft ?? null}, price_microsoft),
      last_synced_at = now(), last_ok = true, last_error = null, domain_count = ${domains.length}, mailbox_count = ${mailboxes.length}
    where id = ${account.id}`;

  return { domains: domains.length, mailboxes: mailboxes.length, ...result };
}

/** Every workspace in turn; one failing doesn't stop the rest. */
export async function syncAllIcemail(sql: Sql, accounts: IcemailAccount[], broken: { id: string; error: string }[] = []) {
  for (const b of broken) {
    await sql`update icemail_accounts set last_synced_at = now(), last_ok = false, last_error = ${b.error} where id = ${b.id}`;
  }
  if (!accounts.length && !broken.length) return { skipped: "No Icemail workspace connected (Settings → Connections)" };
  let domains = 0, mailboxes = 0, linked = 0, autoReplaced = 0, autoRestored = 0, failed = broken.length;
  const errors: string[] = broken.map((b) => b.error);
  for (const a of accounts) {
    try {
      const r = await syncIcemailAccount(sql, a);
      domains += r.domains; mailboxes += r.mailboxes; linked += r.linked; autoReplaced += r.autoReplaced; autoRestored += r.autoRestored;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${a.label}: ${msg}`);
      await sql`update icemail_accounts set last_synced_at = now(), last_ok = false, last_error = ${msg.slice(0, 1000)} where id = ${a.id}`;
    }
  }
  if (failed && failed === accounts.length + broken.length) throw new Error(errors.join("; "));
  return { workspaces: accounts.length + broken.length, domains, mailboxes, linked, autoReplaced, autoRestored, ...(failed ? { failed, errors: errors.join("; ").slice(0, 500) } : {}) };
}
