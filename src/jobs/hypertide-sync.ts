import type postgres from "postgres";
import type { Hypertide, OrderStatus } from "../integrations/hypertide";
import { advanceItem, type StepContext } from "./replacements";

type Sql = postgres.Sql;

/**
 * Mirrors every Hypertide order (paid and unpaid) and lets it move the rest:
 * - a domain with an order is a Hypertide domain; unknown ones are added;
 * - a domain in storage that has been ordered is provisioning;
 * - a hand-ordered replacement's inbox step is done once its order is Done.
 */
export async function syncHypertideOrders(sql: Sql, ctx: StepContext & { hypertide: Hypertide }) {
  const [paid, unpaid] = await Promise.all([ctx.hypertide.activeOrders(), ctx.hypertide.pendingOrders()]);
  const all = new Map<string, OrderStatus>();
  for (const o of [...unpaid, ...paid]) all.set(o.id, o);
  const rows = [...all.values()].map((o) => ({
    id: o.id,
    domain: o.domain,
    status: o.status,
    payment: o.paymentStatus ?? (paid.includes(o) ? "Paid" : "Unpaid"),
    subscription: o.subscriptionId ?? null,
    forwarding: o.forwardingDomain ?? null,
    tool: o.sendingTool ?? null,
    org: o.organizationName ?? null,
    ordered: o.createdAt && /^\d{4}-\d{2}-\d{2}/.test(o.createdAt) ? o.createdAt.slice(0, 10) : null,
  }));
  const valid = rows.filter((r) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(r.domain));

  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.actor', 'hypertide sync', true)`;
    const [ht] = await tx`select id from vendors where name = 'Hypertide'`;
    const added = valid.length
      ? await tx`
          insert into domains (name, inbox_provider_id)
          select distinct r.domain, ${ht.id}::uuid from jsonb_to_recordset(${tx.json(valid)}) as r(domain text)
          on conflict (name) do nothing returning id`
      : [];

    if (valid.length) {
      await tx`
        insert into hypertide_orders (id, domain_name, domain_id, status, payment_status, subscription_id,
          forwarding_domain, sending_tool, organization_name, ordered_on)
        select r.id, r.domain, d.id, r.status, r.payment, r.subscription, r.forwarding, r.tool, r.org, r.ordered::date
        from jsonb_to_recordset(${tx.json(valid)}) as r(id text, domain text, status text, payment text, subscription text,
          forwarding text, tool text, org text, ordered text)
        left join domains d on d.name = r.domain
        on conflict (id) do update set
          domain_name = excluded.domain_name, domain_id = excluded.domain_id, status = excluded.status,
          payment_status = excluded.payment_status, subscription_id = coalesce(excluded.subscription_id, hypertide_orders.subscription_id),
          forwarding_domain = excluded.forwarding_domain, sending_tool = excluded.sending_tool,
          organization_name = excluded.organization_name, ordered_on = coalesce(excluded.ordered_on, hypertide_orders.ordered_on),
          last_seen_at = now(), gone_at = null`;
    }
    const gone = await tx`
      update hypertide_orders set gone_at = now()
      where gone_at is null and not (id = any(${valid.map((r) => r.id)}::text[])) returning id`;

    await tx`
      update domains d set inbox_provider_id = ${ht.id}
      from hypertide_orders o where o.domain_id = d.id and o.gone_at is null and d.inbox_provider_id is distinct from ${ht.id}`;

    // Ordered domains still sitting in storage are being set up.
    const provisioning = await tx`
      select transition_domain(d.id, 'provisioning', 'ordered on Hypertide', 'hypertide sync') as id
      from domains d
      where d.status = 'in_storage'
        and exists (select 1 from hypertide_orders o where o.domain_id = d.id and o.gone_at is null)`;

    return { added: added.length, gone: gone.length, provisioning: provisioning.length };
  });

  // Hand-ordered replacements: the inbox step finishes when the order is Done.
  const ready = await sql`
    select ri.id from replacement_items ri
    join replacement_batches rb on rb.id = ri.batch_id
    where rb.status = 'running' and ri.completed_at is null and ri.step_inboxes not in ('done', 'skipped')
      and (rb.manual_inboxes or ri.hypertide_order_id is null)
      and exists (select 1 from hypertide_orders o where o.domain_id = ri.new_domain_id and o.gone_at is null and o.status = 'Done')`;
  for (const r of ready) {
    await sql`update replacement_items set step_inboxes = 'done', note = null, last_error = null where id = ${r.id}`;
    await advanceItem(sql, ctx, r.id as string, "hypertide sync");
  }

  return { orders: valid.length, paid: paid.length, unpaid: unpaid.length, ...result, replacementsReady: ready.length };
}
