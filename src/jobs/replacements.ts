import type postgres from "postgres";
import { buildOrderPayload, type Hypertide, type OrderTemplate, type SmartleadCredentials } from "../integrations/hypertide";
import { sameNameservers, type Porkbun } from "../integrations/porkbun";

// Moves each replacement pair through its steps:
//   nameservers → inboxes → smartlead → campaigns (live)
// Steps the app can do itself run automatically; the rest wait as "manual"
// with a note saying exactly what to do, until someone marks them done.
// Domain statuses follow: new provisioning → warming (inboxes in Smartlead)
// → active, and the old domain → draining once the new one is live.
// Shared by the worker and the app, so queries only read single-word columns.

type Sql = postgres.Sql | postgres.TransactionSql;
export type StepName = "nameservers" | "inboxes" | "smartlead" | "campaigns";
export const STEP_ORDER: StepName[] = ["nameservers", "inboxes", "smartlead", "campaigns"];
const COLUMN: Record<StepName, string> = {
  nameservers: "step_nameservers",
  inboxes: "step_inboxes",
  smartlead: "step_smartlead",
  campaigns: "step_campaigns",
};
const finished = (s: string) => s === "done" || s === "skipped";

type Item = {
  id: string;
  nameservers: string; inboxes: string; smartlead: string; campaigns: string;
  completed: Date | null;
  newid: string; newname: string; newstatus: string; registrar: string | null; apiaccess: boolean | null;
  oldid: string; oldname: string; oldstatus: string;
  client: string | null;
  htns: string[] | null; htorder: string | null; htstatus: string | null; htpaid: Date | null; htverified: Date | null;
};

async function loadItem(sql: Sql, id: string): Promise<Item | undefined> {
  const [row] = await sql`
    select ri.id, ri.step_nameservers as nameservers, ri.step_inboxes as inboxes, ri.step_smartlead as smartlead,
      ri.step_campaigns as campaigns, ri.completed_at as completed,
      nd.id as newid, nd.name as newname, nd.status as newstatus, v.name as registrar, nd.registrar_api_access as apiaccess,
      od.id as oldid, od.name as oldname, od.status as oldstatus, c.name as client,
      ri.hypertide_ns as htns, ri.hypertide_order_id as htorder, ri.hypertide_status as htstatus,
      ri.hypertide_paid_at as htpaid, ri.hypertide_ns_verified_at as htverified
    from replacement_items ri
    join domains nd on nd.id = ri.new_domain_id
    join domains od on od.id = ri.old_domain_id
    left join vendors v on v.id = nd.registrar_id
    left join clients c on c.id = nd.client_id
    where ri.id = ${id}`;
  return row as Item | undefined;
}

async function setStep(sql: Sql, id: string, step: StepName, status: string, note: string | null, error: string | null = null) {
  await sql.unsafe(
    `update replacement_items set ${COLUMN[step]} = $2::step_status, note = $3, last_error = $4 where id = $1`,
    [id, status, note, error],
  );
}

export function currentStep(item: Pick<Item, StepName>): StepName | null {
  return STEP_ORDER.find((s) => !finished(item[s])) ?? null;
}

async function targetNameservers(sql: Sql): Promise<string[]> {
  const [row] = await sql`select value from settings where key = 'hypertide_nameservers'`;
  const v = row?.value;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
}

// Keeps domain statuses in line with how far the pair has got.
async function syncStatuses(sql: Sql, item: Item, actor: string) {
  const live = finished(item.smartlead);
  if (live && item.newstatus === "provisioning") {
    await sql`select transition_domain(${item.newid}, 'warming', ${"inboxes connected, replacing " + item.oldname}, ${actor})`;
    item.newstatus = "warming";
  }
  if (finished(item.campaigns) && !item.completed) {
    if (item.newstatus === "provisioning") await sql`select transition_domain(${item.newid}, 'warming', 'setup finished', ${actor})`;
    if (item.newstatus !== "active") await sql`select transition_domain(${item.newid}, 'active', ${"replaced " + item.oldname}, ${actor})`;
    if (item.oldstatus === "active" || item.oldstatus === "warming") {
      await sql`select transition_domain(${item.oldid}, 'draining', ${"replaced by " + item.newname}, ${actor})`;
    }
    await sql`update replacement_items set completed_at = now(), note = null, last_error = null where id = ${item.id}`;
  }
}

export type StepContext = {
  porkbun: Porkbun | null;
  hypertide?: Hypertide | null;
  hypertideCredentials?: Partial<SmartleadCredentials>;
};

async function orderTemplate(sql: Sql): Promise<OrderTemplate> {
  const [row] = await sql`select value from settings where key = 'hypertide_order_template'`;
  const v = (row?.value ?? {}) as Partial<OrderTemplate>;
  return {
    plan: v.plan === "google" ? "google" : "entra",
    inbox_quantity: v.inbox_quantity === 25 ? 25 : 50,
    forwarding_domain: typeof v.forwarding_domain === "string" ? v.forwarding_domain : "",
    client_name: typeof v.client_name === "string" ? v.client_name : "",
  };
}

/** Runs whatever the pair's current step can do on its own. */
export async function advanceItem(sql: Sql, ctx: StepContext, id: string, actor = "system") {
  for (let guard = 0; guard < 5; guard++) {
    const item = await loadItem(sql, id);
    if (!item || item.completed) return;
    await syncStatuses(sql, item, actor);
    const step = currentStep(item);
    if (!step) return;
    const state = item[step];
    if (state === "manual" || state === "failed") return; // waiting on a person

    if (step === "nameservers") {
      // Hypertide reserves a pair per domain; ask once and keep it.
      let ns = item.htns?.length ? item.htns : [];
      if (!ns.length && ctx.hypertide) {
        try {
          ns = (await ctx.hypertide.previewNameservers([item.newname])).get(item.newname) ?? [];
          if (ns.length) await sql`update replacement_items set hypertide_ns = ${ns} where id = ${id}`;
        } catch (e) {
          await setStep(sql, id, step, "failed", null, e instanceof Error ? e.message : String(e));
          return;
        }
      }
      if (!ns.length) ns = await targetNameservers(sql);
      if (!ns.length) {
        await setStep(sql, id, step, "manual", ctx.hypertide
          ? "Hypertide returned no nameservers for this domain. Press Retry, or set them by hand and mark this done."
          : "Connect Hypertide (or add its nameservers in Settings → Lifecycle) and press Retry, or set them by hand and mark this done.");
        return;
      }
      const isPorkbun = item.registrar === "Porkbun";
      if (!isPorkbun || !ctx.porkbun || item.apiaccess === false) {
        const why = !isPorkbun ? "" : !ctx.porkbun ? " (Porkbun isn't connected)" : " (API access is off for this domain at Porkbun)";
        await setStep(sql, id, step, "manual", `Point ${item.newname} to ${ns.join(", ")} at ${item.registrar ?? "its registrar"}${why}, then mark this done.`);
        return;
      }
      if (ctx.porkbun.dryRun) {
        await ctx.porkbun.updateNs(item.newname, ns);
        await setStep(sql, id, step, "manual", `Dry run: would set ${item.newname} to ${ns.join(", ")} at Porkbun. Set them by hand and mark this done, or turn dry run off and press Retry.`);
        return;
      }
      await setStep(sql, id, step, "running", `Setting nameservers at Porkbun…`);
      try {
        await ctx.porkbun.updateNs(item.newname, ns);
        const now = await ctx.porkbun.getNs(item.newname);
        if (!sameNameservers(now, ns)) {
          await setStep(sql, id, step, "failed", null, `Porkbun accepted the change but still reports ${now.join(", ") || "no nameservers"}. Press Retry in a few minutes.`);
          return;
        }
        await sql`update domains set nameservers = ${now}, nameservers_checked_at = now() where id = ${item.newid}`;
        await setStep(sql, id, step, "done", null);
      } catch (e) {
        await setStep(sql, id, step, "failed", null, e instanceof Error ? e.message : String(e));
        return;
      }
      continue;
    }

    if (step === "inboxes" && ctx.hypertide) {
      if (await hypertideInboxStep(sql, ctx.hypertide, ctx.hypertideCredentials ?? {}, item, state)) continue;
      return;
    }

    if (step === "inboxes") {
      const senders = await sql`
        select coalesce(sender_name, split_part(email, '@', 1)) as name, count(*)::int as n
        from inboxes where domain_id = ${item.oldid} and status <> 'removed'
        group by 1 order by 1`;
      const total = senders.reduce((a, s) => a + Number(s.n), 0);
      const who = senders.map((s) => (Number(s.n) > 1 ? `${s.name} ×${s.n}` : s.name)).join(", ");
      await setStep(sql, id, step, "manual", total
        ? `Order ${total} inbox${total === 1 ? "" : "es"} on Hypertide for ${item.newname} (${who}) and connect them to Smartlead, then mark this done.`
        : `Order inboxes on Hypertide for ${item.newname} and connect them to Smartlead, then mark this done.`);
      return;
    }

    if (step === "smartlead") {
      const [{ n }] = await sql`select count(*)::int as n from inboxes where domain_id = ${item.newid} and status = 'connected'`;
      if (Number(n) > 0) {
        await setStep(sql, id, step, "done", null);
        continue;
      }
      await setStep(sql, id, step, "running", "Waiting for the new inboxes to show up in the Smartlead sync (every 30 min). Mark this done to skip the check.");
      return;
    }

    if (step === "campaigns") {
      const campaigns = await sql`
        select distinct c.name from campaign_inboxes ci join inboxes i on i.id = ci.inbox_id join campaigns c on c.id = ci.campaign_id
        where i.domain_id = ${item.oldid} order by c.name`;
      const list = campaigns.map((c) => c.name as string);
      await setStep(sql, id, step, "manual", list.length
        ? `Add the new inboxes to ${list.length === 1 ? "this campaign" : `these ${list.length} campaigns`}: ${list.join("; ")}. Then mark this done; ${item.oldname} will start draining.`
        : `Add the new inboxes to ${item.oldname}'s campaigns, then mark this done; ${item.oldname} will start draining.`);
      return;
    }
  }
}

/** Worker job: advance every open pair, then close finished batches. */
export async function advanceReplacements(sql: postgres.Sql, ctx: StepContext) {
  const open = await sql`
    select ri.id from replacement_items ri join replacement_batches rb on rb.id = ri.batch_id
    where rb.status = 'running' and ri.completed_at is null
    order by ri.created_at limit 200`;
  let errors = 0;
  for (const r of open) {
    try {
      await advanceItem(sql, ctx, r.id as string);
    } catch (e) {
      errors++;
      await sql`update replacement_items set last_error = ${e instanceof Error ? e.message : String(e)} where id = ${r.id}`;
    }
  }
  const closed = await sql`
    update replacement_batches b set status = 'completed', completed_at = now()
    where b.status = 'running' and not exists (select 1 from replacement_items i where i.batch_id = b.id and i.completed_at is null)
    returning id`;
  return { open: open.length, batchesCompleted: closed.length, errors };
}

/** A person acting on a pair's current step from the Replacements page. */
export async function actOnStep(sql: Sql, ctx: StepContext, id: string, step: StepName, action: "done" | "retry" | "skip", actor: string) {
  const item = await loadItem(sql, id);
  if (!item) throw new Error("Replacement not found");
  if (item.completed) throw new Error("This replacement is already finished");
  if (currentStep(item) !== step) throw new Error("Finish the earlier steps first");
  if (action === "retry") await setStep(sql, id, step, "pending", null);
  else await setStep(sql, id, step, action === "done" ? "done" : "skipped", null);
  await advanceItem(sql, ctx, id, actor);
  const after = await loadItem(sql, id);
  const s = after ? currentStep(after) : null;
  return { next: s, completed: Boolean(after?.completed) };
}

// The inbox step through Hypertide. Returns true when the step finished.
// Order → (a person approves payment) → nameserver verification and setup,
// followed by the hypertide-orders job → Done.
async function hypertideInboxStep(sql: Sql, ht: Hypertide, creds: Partial<SmartleadCredentials>, item: Item, state: string) {
  const id = item.id;
  if (item.htorder) {
    if (!item.htpaid) {
      // Waiting for someone to approve payment (restored if a Retry cleared it).
      if (state !== "manual") {
        await setStep(sql, id, "inboxes", "manual", `Order placed on Hypertide for ${item.newname}, not paid yet. Approve payment to start setup.`);
      }
      return false;
    }
    if (item.htstatus === "Done") {
      await setStep(sql, id, "inboxes", "done", null);
      return true;
    }
    const note = !item.htverified
      ? `Paid. Waiting for Hypertide to see the new nameservers on ${item.newname} (checked every 5 min).`
      : `Hypertide is setting up the inboxes (status: ${item.htstatus ?? "In progress"}).`;
    await setStep(sql, id, "inboxes", "running", note);
    return false;
  }
  if (state !== "pending") return false;

  const [template, senders, [warm]] = await Promise.all([
    orderTemplate(sql),
    sql`select distinct sender_name as name from inboxes
      where domain_id = ${item.oldid} and status <> 'removed' and sender_name is not null order by 1`,
    sql`select round(avg(warmup_per_day))::int as perday, round(avg(warmup_rampup))::int as rampup,
        round(avg(nullif(daily_limit, 0)))::int as daily
      from inboxes where domain_id = ${item.oldid} and status <> 'removed'`,
  ]);
  const built = buildOrderPayload({
    template,
    domain: item.newname,
    clientName: item.client,
    senders: senders.map((r) => r.name as string),
    warmup: { perDay: warm?.perday ?? null, rampup: warm?.rampup ?? null, dailyLimit: warm?.daily ?? null },
    credentials: creds,
  });
  if (!built.ok) {
    await setStep(sql, id, "inboxes", "manual",
      `Can't order on Hypertide yet: ${built.problems.join("; ")}. Fix this and press Retry, or order by hand and mark this done.`);
    return false;
  }
  const what = `${template.plan === "entra" ? `${template.inbox_quantity} Microsoft inboxes` : "3 Google inboxes"} for ${item.newname}`;
  try {
    const order = await ht.createOrder(built.payload);
    if (order.dryRun || !order.recordId) {
      await setStep(sql, id, "inboxes", "manual",
        `Dry run: Hypertide checked the order (${what}) and accepted it. Turn dry run off and press Retry to place it, or order by hand and mark this done.`);
      return false;
    }
    await sql`update replacement_items set hypertide_order_id = ${order.recordId}, hypertide_status = 'Unpaid' where id = ${id}`;
    await setStep(sql, id, "inboxes", "manual", `Order placed on Hypertide (${what}), not paid yet. Approve payment to start setup.`);
  } catch (e) {
    await setStep(sql, id, "inboxes", "failed", null, e instanceof Error ? e.message : String(e));
  }
  return false;
}

/**
 * Worker job: for paid orders, ask Hypertide to verify the nameservers once
 * ours are set, then follow each order's status until it is Done.
 */
export async function trackHypertideOrders(sql: postgres.Sql, ctx: StepContext & { hypertide: Hypertide }) {
  const open = await sql`
    select ri.id, ri.hypertide_order_id as order, ri.hypertide_ns_verified_at as verified,
      ri.step_nameservers as ns, nd.name as domain
    from replacement_items ri
    join replacement_batches rb on rb.id = ri.batch_id
    join domains nd on nd.id = ri.new_domain_id
    where rb.status = 'running' and ri.completed_at is null and ri.hypertide_order_id is not null
      and ri.hypertide_paid_at is not null and ri.step_inboxes not in ('done', 'skipped')`;
  if (!open.length) return { open: 0 };

  let verified = 0;
  const toVerify = open.filter((o) => !o.verified && (o.ns === "done" || o.ns === "skipped"));
  if (toVerify.length && !ctx.hypertide.dryRun) {
    const r = await ctx.hypertide.verifyNameservers(toVerify.map((o) => o.order as string));
    for (const res of r.results) {
      const match = toVerify.find((o) => o.domain === res.domain);
      if (!match) continue;
      if (res.verified) {
        await sql`update replacement_items set hypertide_ns_verified_at = now() where id = ${match.id}`;
        verified++;
      } else if (res.message) {
        const note = `Waiting for Hypertide to see the new nameservers: ${res.message}`;
        await sql`update replacement_items set note = ${note} where id = ${match.id}`;
      }
    }
  }

  const statuses = new Map((await ctx.hypertide.activeOrders()).map((o) => [o.id, o.status]));
  let done = 0;
  for (const o of open) {
    const status = statuses.get(o.order as string);
    if (!status) continue;
    await sql`update replacement_items set hypertide_status = ${status} where id = ${o.id}`;
    if (status === "Done") {
      done++;
      await advanceItem(sql, ctx, o.id as string);
    }
  }
  return { open: open.length, verified, done };
}

/** A person approved paying for these orders: charge once, then move on. */
export async function approveHypertidePayment(sql: Sql, ctx: StepContext & { hypertide: Hypertide }, itemIds: string[], actor: string) {
  const rows = await sql`
    select ri.id, ri.hypertide_order_id as order from replacement_items ri
    join replacement_batches rb on rb.id = ri.batch_id
    where ri.id = any(${itemIds}::uuid[]) and rb.status = 'running' and ri.completed_at is null
      and ri.hypertide_order_id is not null and ri.hypertide_paid_at is null`;
  if (!rows.length) throw new Error("Nothing to pay for: these orders are already paid or not placed yet");
  const r = await ctx.hypertide.charge(rows.map((x) => x.order as string), `Domain Engine replacement, approved by ${actor}`);
  if (r.dryRun) return { charged: 0, dryRun: true };
  const ids = rows.map((x) => x.id as string);
  await sql`update replacement_items set hypertide_paid_at = now(), hypertide_status = 'Paid', note = null where id = any(${ids}::uuid[])`;
  for (const x of rows) await advanceItem(sql, ctx, x.id as string, actor);
  return { charged: rows.length, dryRun: false };
}
