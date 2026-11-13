import "server-only";
import { sql } from "./db";
import { cancelBy, verdictOf, type IcemailVerdict, type Person } from "./icemail-board";
import { getReplaceCalls, listClients } from "./queries";

// Everything the Icemail page shows: each workspace's wallet and prices, every
// connected domain with its verdict and billing date, the free domains an
// order can go on, and the orders and cancels queued from the page.

export type IcemailAccountInfo = {
  id: string; label: string; workspaceName: string | null;
  walletBalance: number | null; walletCurrency: string | null; autoTopup: boolean | null;
  priceGoogle: number | null; priceMicrosoft: number | null;
  lastSyncedAt: Date | null; lastOk: boolean | null; lastError: string | null;
  domains: number; mailboxes: number; monthly: number;
  /** Inboxes billing in the next 7 days and what they cost then. */ renewing: number; renewingCost: number;
};

export type IcemailCancelInfo = { id: string; status: string; reason: string; deletesOn: Date | null; message: string | null; createdAt: Date; createdBy: string };

export type IcemailDomainRow = {
  id: string; accountId: string; name: string; domainId: string | null;
  status: string | null; icemailStatus: string | null; provider: string | null; imported: boolean | null; expiresOn: Date | null;
  clientId: string | null; clientName: string | null; clientHue: number | null;
  mailboxes: number; monthly: number | null; nextBill: Date | null; ageDays: number | null;
  connected: number; sent7: number; replies7: number; bounces7: number; daysSinceSent: number | null;
  blacklisted: boolean | null; issue: string | null;
  /** The names on its inboxes, to order the same senders elsewhere. */ people: Person[];
  cancel: IcemailCancelInfo | null;
  verdict: IcemailVerdict; reasons: string[];
  cancelBy: string | null; cancelDaysLeft: number | null;
};

/** A free domain in the inventory: ordering on it first moves its nameservers to Icemail. */
export type FreeInventoryDomain = { id: string; name: string; registrar: string | null; registrarAccount: string | null; apiAccess: boolean | null; expiresAt: Date | null; clientId: string | null };

export type IcemailOrderItemRow = {
  id: string; domainName: string; domainId: string | null; status: string; message: string | null;
  mailboxes: number; usernames: string[]; nsStatus: string | null; finishedAt: Date | null;
  /** Setup so far, from the last Icemail sync: inboxes Icemail has on the domain, how many are active, any other status, and how many are connected in Smartlead. */
  atIcemail: number; activeAtIcemail: number; otherStatus: string | null; inSmartlead: number;
  /** Its inboxes on their way to Smartlead (icemail_connects): waiting or being added, waiting for an app password, added, dry run, failed, and the last failure. */
  connectQueued: number; connectNoPassword: number; connectDone: number; connectDryRun: number; connectFailed: number; connectError: string | null;
};
export type IcemailOrderRow = {
  id: string; accountId: string; accountLabel: string; clientId: string | null; clientName: string | null; clientHue: number | null;
  provider: string; priceUsd: number | null; quotedMonthlyUsd: number | null; note: string | null;
  createdBy: string; createdAt: Date; cancelledAt: Date | null; clearedAt: Date | null; clearedBy: string | null; items: IcemailOrderItemRow[];
};
export type IcemailCancelRow = IcemailCancelInfo & { domainName: string; domainId: string | null; accountLabel: string; mailboxes: number | null; finishedAt: Date | null };

export type IcemailBoard = {
  accounts: IcemailAccountInfo[];
  domains: IcemailDomainRow[];
  freeInventory: FreeInventoryDomain[];
  orders: IcemailOrderRow[];
  cancels: IcemailCancelRow[];
  clients: { id: string; name: string; hue: number }[];
  syncedAt: Date | null;
};

const LIVE_CANCEL = ["queued", "scheduled", "undo_queued"];

export async function getIcemailBoard(): Promise<IcemailBoard> {
  const [accounts, rawDomains, freeInventory, orders, items, cancels, clients, [sync], replace] = await Promise.all([
    sql<IcemailAccountInfo[]>`
      select a.id, a.label, a.workspace_name, a.wallet_balance::float8 as wallet_balance, a.wallet_currency, a.auto_topup,
        a.price_google::float8 as price_google, a.price_microsoft::float8 as price_microsoft,
        a.last_synced_at, a.last_ok, a.last_error,
        (select count(*)::int from icemail_domains x where x.account_id = a.id and x.gone_at is null) as domains,
        coalesce(m.mailboxes, 0) as mailboxes, coalesce(m.monthly, 0) as monthly,
        coalesce(m.renewing, 0) as renewing, coalesce(m.renewing_cost, 0) as renewing_cost
      from icemail_accounts a
      left join lateral (
        select count(*)::int as mailboxes,
          coalesce(sum(case when x.billing_cycle = 'YEARLY' then x.cost / 12 else x.cost end), 0)::float8 as monthly,
          (count(*) filter (where x.next_billing_on between current_date and current_date + 7))::int as renewing,
          coalesce(sum(x.cost) filter (where x.next_billing_on between current_date and current_date + 7), 0)::float8 as renewing_cost
        from icemail_mailboxes x where x.account_id = a.id and x.gone_at is null) m on true
      order by a.created_at`,
    sql<(Omit<IcemailDomainRow, "verdict" | "reasons" | "cancelBy" | "cancelDaysLeft" | "cancel"> & { cancelId: string | null; cancelStatus: string | null; cancelReason: string | null; cancelDeletesOn: Date | null; cancelMessage: string | null; cancelCreatedAt: Date | null; cancelCreatedBy: string | null })[]>`
      with t as (select coalesce((select value #>> '{}' from settings where key = 'stats_timezone'), 'UTC') as z),
      today as (select (now() at time zone t.z)::date as d from t)
      select x.id, x.account_id, x.domain_name as name, x.domain_id, d.status, x.status as icemail_status, x.provider, x.imported, x.expires_on,
        d.client_id, c.name as client_name, c.hue as client_hue,
        coalesce(m.mailboxes, 0) as mailboxes, m.monthly, m.next_bill, (current_date - m.oldest)::int as age_days,
        coalesce(ib.connected, 0) as connected, coalesce(s7.sent7, 0) as sent7, coalesce(s7.replies7, 0) as replies7, coalesce(s7.bounces7, 0) as bounces7,
        ((select d from today) - (select max(s.day) from domain_daily_stats s where s.domain_id = x.domain_id and s.sent > 0))::int as days_since_sent,
        x.blacklisted,
        case when false in (x.spf, x.dkim, x.dmarc, x.mx) then 'missing ' || concat_ws(', ',
            case when x.spf is false then 'SPF' end, case when x.dkim is false then 'DKIM' end,
            case when x.dmarc is false then 'DMARC' end, case when x.mx is false then 'MX' end)
          when x.status is distinct from 'ACTIVE' then lower(coalesce(x.status, 'unknown status'))
        end as issue,
        coalesce(m.people, '[]'::jsonb) as people,
        k.id as cancel_id, k.status as cancel_status, k.reason as cancel_reason, k.deletes_on as cancel_deletes_on,
        k.message as cancel_message, k.created_at as cancel_created_at, k.created_by as cancel_created_by
      from icemail_domains x
      left join domains d on d.id = x.domain_id
      left join clients c on c.id = d.client_id
      left join lateral (
        select count(*)::int as mailboxes,
          sum(case when m.billing_cycle = 'YEARLY' then m.cost / 12 else m.cost end)::float8 as monthly,
          min(m.next_billing_on) filter (where m.next_billing_on >= current_date) as next_bill,
          min(m.created_on) as oldest,
          jsonb_agg(distinct jsonb_build_object('first', m.first_name, 'last', m.last_name)) filter (where m.first_name is not null and m.last_name is not null) as people
        from icemail_mailboxes m
        where m.icemail_domain_id = x.id and m.gone_at is null and coalesce(m.status, '') !~* 'cancel|delet') m on true
      left join lateral (
        select count(*) filter (where i.status = 'connected')::int as connected from inboxes i where i.domain_id = x.domain_id) ib on true
      left join lateral (
        select sum(s.sent)::int as sent7, sum(s.replies)::int as replies7, sum(s.bounces)::int as bounces7
        from domain_daily_stats s, today where s.domain_id = x.domain_id and s.day > today.d - 7 and s.day <= today.d) s7 on true
      left join lateral (
        select * from icemail_cancels k where k.icemail_domain_id = x.id and k.status = any(${LIVE_CANCEL}::text[])
        order by k.created_at desc limit 1) k on true
      where x.gone_at is null
      order by x.domain_name`,
    sql<FreeInventoryDomain[]>`
      select d.id, d.name, v.name as registrar, ra.label as registrar_account, d.registrar_api_access as api_access, d.expires_at, d.client_id
      from domains d
      left join vendors v on v.id = d.registrar_id
      left join registrar_accounts ra on ra.id = d.registrar_account_id
      where domain_is_free(d) and d.archived_at is null
        and not exists (select 1 from icemail_domains x where x.domain_name = d.name and x.gone_at is null)
        and not exists (select 1 from icemail_order_items i where i.domain_name = d.name and i.status in ('queued', 'nameservers', 'ordering'))
      order by coalesce(d.purchased_at, d.registered_at) nulls last, d.name
      limit 5000`,
    sql<Omit<IcemailOrderRow, "items">[]>`
      select o.id, o.account_id, a.label as account_label, o.client_id, c.name as client_name, c.hue as client_hue,
        o.provider, o.price_usd::float8 as price_usd, o.quoted_monthly_usd::float8 as quoted_monthly_usd, o.note,
        o.created_by, o.created_at, o.cancelled_at, o.cleared_at, o.cleared_by
      from icemail_orders o
      join icemail_accounts a on a.id = o.account_id
      left join clients c on c.id = o.client_id
      -- Kept until cleared; cleared ones for 60 days, to bring back.
      where o.cleared_at is null or o.created_at > now() - interval '60 days'
      order by o.created_at desc
      limit 200`,
    sql<(IcemailOrderItemRow & { orderId: string })[]>`
      select i.id, i.order_id, i.domain_name, i.domain_id, i.status, i.message, i.finished_at,
        jsonb_array_length(i.mailboxes)::int as mailboxes,
        array(select jsonb_array_elements(i.mailboxes) ->> 'username') as usernames,
        r.status as ns_status,
        coalesce(mb.at_icemail, 0) as at_icemail, coalesce(mb.active_at_icemail, 0) as active_at_icemail, mb.other_status,
        coalesce(sl.in_smartlead, 0) as in_smartlead,
        coalesce(kc.queued, 0) as connect_queued, coalesce(kc.no_password, 0) as connect_no_password, coalesce(kc.done, 0) as connect_done,
        coalesce(kc.dry_run, 0) as connect_dry_run, coalesce(kc.failed, 0) as connect_failed, kc.error as connect_error
      from icemail_order_items i
      join icemail_orders o on o.id = i.order_id
      left join nameserver_requests r on r.id = i.ns_request_id
      left join lateral (
        select count(*)::int as at_icemail,
          (count(*) filter (where m.active is true or upper(m.status) = 'ACTIVE'))::int as active_at_icemail,
          string_agg(distinct lower(m.status), ', ') filter (where not (m.active is true or upper(m.status) = 'ACTIVE')) as other_status
        from icemail_domains x join icemail_mailboxes m on m.icemail_domain_id = x.id
        where i.status = 'ordered' and x.domain_name = i.domain_name and x.gone_at is null and m.gone_at is null) mb on true
      left join lateral (
        select (count(*) filter (where b.status = 'connected'))::int as in_smartlead
        from domains d join inboxes b on b.domain_id = d.id
        where i.status = 'ordered' and d.name = i.domain_name) sl on true
      left join lateral (
        select (count(*) filter (where k.status in ('queued', 'connecting')))::int as queued,
          (count(*) filter (where k.status = 'no_password'))::int as no_password,
          (count(*) filter (where k.status = 'connected'))::int as done,
          (count(*) filter (where k.status = 'dry_run'))::int as dry_run,
          (count(*) filter (where k.status = 'failed'))::int as failed,
          (array_agg(k.message order by k.finished_at desc nulls last) filter (where k.status = 'failed'))[1] as error
        from icemail_connects k where k.order_item_id = i.id) kc on true
      where o.cleared_at is null or o.created_at > now() - interval '60 days'
      order by i.domain_name`,
    sql<IcemailCancelRow[]>`
      select k.id, k.status, k.reason, k.deletes_on, k.message, k.created_at, k.created_by, k.domain_name, k.domain_id,
        a.label as account_label, k.mailboxes, k.finished_at
      from icemail_cancels k join icemail_accounts a on a.id = k.account_id
      where k.created_at > now() - interval '60 days' or k.status = any(${LIVE_CANCEL}::text[])
      order by k.created_at desc
      limit 100`,
    listClients(),
    sql<{ at: Date | null }[]>`select last_finished_at as at from job_state where job = 'icemail'`,
    getReplaceCalls(),
  ]);

  const domains: IcemailDomainRow[] = rawDomains.map((r) => {
    const { cancelId, cancelStatus, cancelReason, cancelDeletesOn, cancelMessage, cancelCreatedAt, cancelCreatedBy, ...d } = r;
    const call = d.domainId ? replace.calls.get(d.domainId) : undefined;
    const cancel = cancelId ? { id: cancelId, status: cancelStatus!, reason: cancelReason!, deletesOn: cancelDeletesOn, message: cancelMessage, createdAt: cancelCreatedAt!, createdBy: cancelCreatedBy! } : null;
    const v = verdictOf({
      mailboxes: d.mailboxes, ageDays: d.ageDays, status: d.status, call: call?.call ?? null, reasons: call?.reasons ?? [],
      blacklisted: d.blacklisted, issue: d.issue, connected: d.connected, sent7: d.sent7, daysSinceSent: d.daysSinceSent,
      cancelling: !!cancel && cancel.status !== "undo_queued",
    });
    const by = cancelBy(d.nextBill);
    return { ...d, people: (d.people ?? []) as Person[], cancel, verdict: v.verdict, reasons: v.reasons, cancelBy: by?.by ?? null, cancelDaysLeft: by?.daysLeft ?? null };
  });

  const byOrder = new Map<string, IcemailOrderItemRow[]>();
  for (const { orderId, ...i } of items) byOrder.set(orderId, [...(byOrder.get(orderId) ?? []), i]);

  return {
    accounts: [...accounts],
    domains,
    freeInventory: [...freeInventory],
    orders: orders.map((o) => ({ ...o, items: byOrder.get(o.id) ?? [] })),
    cancels: [...cancels],
    clients: clients.map((c) => ({ id: c.id, name: c.name, hue: c.hue })),
    syncedAt: sync?.at ?? null,
  };
}
