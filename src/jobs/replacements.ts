import type postgres from "postgres";
import { buildOrderPayload, type Hypertide, type OrderTemplate, type SmartleadCredentials } from "../integrations/hypertide";
import { sameNameservers, type Porkbun } from "../integrations/porkbun";
import type { Smartlead } from "../integrations/smartlead";
import type { SmartleadApp, SmartleadTag } from "../integrations/smartlead-app";

// Moves each replacement pair through its steps:
//   nameservers → inboxes → smartlead → campaigns (live)
// Steps the app can do itself run automatically; the rest wait as "manual"
// with a note saying exactly what to do, until someone marks them done.
// Domain statuses follow: new provisioning → warming (inboxes in Smartlead)
// → active, and the old domain → draining once the new one is live.
// Batches marked hypertide_replace use Hypertide's replace-domain queue: the
// nameserver step submits the replacement (which returns the nameservers),
// and the inbox step follows that operation instead of placing an order.
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
  manual: boolean;
  htreplace: boolean; copytw: boolean; usernames: { firstName: string; lastName: string }[] | null;
  stopold: boolean; addcampaigns: boolean;
  htop: string | null; htopstatus: string | null; htchecked: Date | null; oldstopped: Date | null;
  autowarmup: boolean; warmupqueued: Date | null;
};

async function loadItem(sql: Sql, id: string): Promise<Item | undefined> {
  const [row] = await sql`
    select ri.id, ri.step_nameservers as nameservers, ri.step_inboxes as inboxes, ri.step_smartlead as smartlead,
      ri.step_campaigns as campaigns, ri.completed_at as completed,
      nd.id as newid, nd.name as newname, nd.status as newstatus, v.name as registrar, nd.registrar_api_access as apiaccess,
      od.id as oldid, od.name as oldname, od.status as oldstatus, c.name as client,
      ri.hypertide_ns as htns, ri.hypertide_order_id as htorder, ri.hypertide_status as htstatus,
      ri.hypertide_paid_at as htpaid, ri.hypertide_ns_verified_at as htverified, rb.manual_inboxes as manual,
      rb.hypertide_replace as htreplace, rb.copy_tags_and_warmup as copytw, rb.usernames::text as usernames,
      rb.stop_old_sending as stopold, rb.add_to_campaigns as addcampaigns,
      ri.ht_operation_id as htop, ri.ht_operation as htopstatus, ri.ht_checked_at as htchecked, ri.old_stopped_at as oldstopped,
      rb.auto_warmup as autowarmup, ri.warmup_queued_at as warmupqueued
    from replacement_items ri
    join replacement_batches rb on rb.id = ri.batch_id
    join domains nd on nd.id = ri.new_domain_id
    join domains od on od.id = ri.old_domain_id
    left join vendors v on v.id = nd.registrar_id
    left join clients c on c.id = nd.client_id
    where ri.id = ${id}`;
  if (!row) return undefined;
  // Read as text so the app's camelCase client can't rename the keys inside.
  const usernames = row.usernames ? (JSON.parse(row.usernames as string) as Item["usernames"]) : null;
  return { ...row, usernames } as Item;
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

/** Adds or removes app tags on a domain (New, Replaced). */
async function retag(sql: Sql, domainId: string, add: string[], remove: string[] = []) {
  await sql`update domains set tags = array(
      select distinct t from unnest(tags || ${add}::text[]) t where not (t = any(${remove}::text[])) order by 1)
    where id = ${domainId}`;
}

// The old domain is Replaced from the moment Hypertide swaps it: its inboxes
// live on for the grace period (the drain days), then it retires.
async function startGrace(sql: Sql, item: Item, actor: string) {
  await sql`select transition_domain(${item.oldid}, 'draining', ${"replaced by " + item.newname}, ${actor})`;
  // Count from when Hypertide finished the swap, when it said so.
  await sql`
    update domains d set draining_since = least(d.draining_since, x.at)
    from (select substring(ht_response from '"completedAt":"([0-9T:.+-]+Z?)"')::timestamptz as at
          from replacement_items where id = ${item.id}) x
    where d.id = ${item.oldid} and x.at is not null`;
  await retag(sql, item.oldid, ["Replaced"], ["New"]);
  item.oldstatus = "draining";
}

// Keeps domain statuses in line with how far the pair has got.
async function syncStatuses(sql: Sql, item: Item, actor: string) {
  // A Hypertide swap starts the old domain's clock as soon as Hypertide has it.
  const swapped = item.htreplace && (finished(item.inboxes) || item.htopstatus === "completed");
  if (swapped && (item.oldstatus === "active" || item.oldstatus === "warming")) await startGrace(sql, item, actor);
  const live = finished(item.smartlead);
  if (live && item.newstatus === "provisioning") {
    await sql`select transition_domain(${item.newid}, 'warming', ${"inboxes connected, replacing " + item.oldname}, ${actor})`;
    item.newstatus = "warming";
  }
  if (finished(item.campaigns) && !item.completed) {
    if (item.newstatus === "provisioning") await sql`select transition_domain(${item.newid}, 'warming', 'setup finished', ${actor})`;
    // Not in campaigns yet: the new domain keeps warming until someone adds it.
    if (item.campaigns === "done") {
      if (item.newstatus !== "active") await sql`select transition_domain(${item.newid}, 'active', ${"replaced " + item.oldname}, ${actor})`;
      await retag(sql, item.newid, [], ["New"]);
    }
    if (item.oldstatus === "active" || item.oldstatus === "warming") await startGrace(sql, item, actor);
    // Hypertide keeps the old inboxes up for the grace period so replies
    // still land; they just stop sending.
    if (item.stopold && !item.oldstopped) {
      await sql`
        insert into inbox_setting_changes (inbox_id, changes, source, actor)
        select id, ${sql.json({ daily_limit: 0 })}, 'replacement', ${actor}
        from inboxes where domain_id = ${item.oldid} and status <> 'removed' and smartlead_account_id is not null`;
      await sql`update replacement_items set old_stopped_at = now() where id = ${item.id}`;
    }
    await sql`update replacement_items set completed_at = now(), note = null, last_error = null where id = ${item.id}`;
  }
}

export type StepContext = {
  porkbun: Porkbun | null;
  hypertide?: Hypertide | null;
  hypertideCredentials?: Partial<SmartleadCredentials>;
  smartlead?: Smartlead | null;
  smartleadApp?: SmartleadApp | null;
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
      if (item.htreplace && !item.htop) {
        const got = await submitHypertideReplacement(sql, ctx, item);
        if (!got) return;
        ns = got;
      }
      if (item.htreplace && !ns.length) {
        await setStep(sql, id, step, "manual", `Hypertide queued the replacement but sent no nameservers for ${item.newname}. Copy them from Hypertide, set them at ${item.registrar ?? "the registrar"}, then mark this done.`);
        return;
      }
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

    if (step === "inboxes" && item.htreplace) {
      if (await hypertideReplaceStep(sql, ctx.hypertide ?? null, item, state)) continue;
      return;
    }

    if (step === "inboxes" && ctx.hypertide && !item.manual) {
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
      const then = ctx.hypertide ? " This step finishes on its own once the Hypertide order shows Done." : " Then mark this done.";
      await setStep(sql, id, step, "manual", (total
        ? `Order ${total} inbox${total === 1 ? "" : "es"} on Hypertide for ${item.newname} (${who}) and connect them to Smartlead.`
        : `Order inboxes on Hypertide for ${item.newname} and connect them to Smartlead.`) + then);
      return;
    }

    if (step === "smartlead") {
      // Inboxes arrive over a sync or two; wait until as many as the old
      // domain had are in, or an hour after the first one.
      const [c] = await sql`
        select count(*) filter (where status = 'connected')::int as n,
          (min(created_at) filter (where status = 'connected') < now() - interval '1 hour') as settled,
          (select count(*)::int from inboxes where domain_id = ${item.oldid} and status <> 'removed') as expected
        from inboxes where domain_id = ${item.newid}`;
      const n = Number(c.n), expected = Number(c.expected);
      if (n > 0 && (n >= expected || c.settled)) {
        await copySendingSettings(sql, item, actor);
        if (item.autowarmup && !item.warmupqueued) await turnOnWarmup(sql, item, actor);
        await setStep(sql, id, step, "done", null);
        continue;
      }
      await setStep(sql, id, step, "running", n
        ? `${n} of ${expected} new inboxes are in Smartlead so far. Waiting for the rest (synced every 30 min). Mark this done to go on with these.`
        : "Waiting for the new inboxes to show up in the Smartlead sync (every 30 min). Mark this done to skip the check.");
      return;
    }

    if (step === "campaigns") {
      const campaigns = await sql`
        select distinct c.id, c.name from campaign_inboxes ci join inboxes i on i.id = ci.inbox_id join campaigns c on c.id = ci.campaign_id
        where i.domain_id = ${item.oldid} order by c.name`;
      const list = campaigns.map((c) => c.name as string);
      // New inboxes warm up first; they're added later from Replacements.
      if (!item.addcampaigns) {
        await setStep(sql, id, step, "skipped", null);
        continue;
      }
      if (!list.length) {
        await setStep(sql, id, step, "done", null);
        continue;
      }
      const sl = ctx.smartlead;
      if (!sl || sl.dryRun) {
        const dry = sl?.dryRun ? " (dry run is on, so the app didn't)" : "";
        await setStep(sql, id, step, "manual", list.length
          ? `Add the new inboxes to ${list.length === 1 ? "this campaign" : `these ${list.length} campaigns`}: ${list.join("; ")}${dry}. Then mark this done; ${item.oldname} will start draining.`
          : `Add the new inboxes to ${item.oldname}'s campaigns, then mark this done; ${item.oldname} will start draining.`);
        return;
      }
      await setStep(sql, id, step, "running", `Adding the new inboxes to ${list.length} campaign${list.length === 1 ? "" : "s"}…`);
      try {
        await addInboxesToCampaigns(sql, sl, item.newid, campaigns.map((c) => Number(c.id)));
      } catch (e) {
        await setStep(sql, id, step, "failed", null, errText(e));
        return;
      }
      await sql`update replacement_items set campaigns_added_at = now() where id = ${id}`;
      await setStep(sql, id, step, "done", null);
      continue;
    }
  }
}

/** Adds a domain's connected inboxes to these Smartlead campaigns, and records it. */
async function addInboxesToCampaigns(sql: Sql, sl: Smartlead, domainId: string, campaignIds: number[]) {
  const accounts = await sql`
    select id, smartlead_account_id as account from inboxes
    where domain_id = ${domainId} and status = 'connected' and smartlead_account_id is not null`;
  if (!accounts.length) throw new Error("None of the new inboxes are linked to Smartlead yet");
  for (const c of campaignIds) {
    await sl.addAccountsToCampaign(c, accounts.map((a) => Number(a.account)));
    await sql`insert into campaign_inboxes (campaign_id, inbox_id)
      select ${c}::bigint, unnest(${accounts.map((a) => a.id as string)}::uuid[]) on conflict do nothing`;
  }
  return accounts.length;
}

/**
 * From Replacements, once the new inboxes have warmed up: adds them to the
 * campaigns the old domain's inboxes are in, and the new domain goes Active.
 */
export async function addReplacementToCampaigns(sql: Sql, sl: Smartlead, id: string, actor: string) {
  const item = await loadItem(sql, id);
  if (!item) throw new Error("Replacement not found");
  if (!finished(item.smartlead)) throw new Error("The new inboxes aren't in Smartlead yet");
  if (item.campaigns === "done") throw new Error("These inboxes are already in the campaigns");
  if (sl.dryRun) throw new Error("Dry run is on, so Smartlead can't be changed");
  const campaigns = await sql`
    select distinct ci.campaign_id as id from campaign_inboxes ci join inboxes i on i.id = ci.inbox_id
    where i.domain_id = ${item.oldid}`;
  if (!campaigns.length) throw new Error(`${item.oldname} isn't in any campaign`);
  const inboxes = await addInboxesToCampaigns(sql, sl, item.newid, campaigns.map((c) => Number(c.id)));
  await sql`update replacement_items set step_campaigns = 'done', campaigns_added_at = now(), note = null, last_error = null where id = ${id}`;
  if (item.newstatus === "provisioning") await sql`select transition_domain(${item.newid}, 'warming', 'setup finished', ${actor})`;
  if (item.newstatus !== "active") await sql`select transition_domain(${item.newid}, 'active', ${"added to campaigns, replaced " + item.oldname}, ${actor})`;
  await retag(sql, item.newid, [], ["New"]);
  // The Smartlead "New" tag comes off with the next tag pass.
  await sql`update replacement_items set sl_new_tagged_at = null where id = ${id} and sl_new_tagged_at is not null`;
  // Still mid-run: let the runner finish it (old domain, completion).
  if (!item.completed) await advanceItem(sql, { porkbun: null, smartlead: sl }, id, actor);
  return { inboxes, campaigns: campaigns.length };
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
  const tagged = ctx.smartleadApp && !ctx.smartleadApp.dryRun ? await syncSmartleadTags(sql, ctx.smartleadApp).catch(() => ({ tagged: 0, errors: 1 })) : null;
  if (tagged) errors += tagged.errors;
  const closed = await sql`
    update replacement_batches b set status = 'completed', completed_at = now()
    where b.status = 'running' and not exists (select 1 from replacement_items i where i.batch_id = b.id and i.completed_at is null)
    returning id`;
  return { open: open.length, batchesCompleted: closed.length, errors, tagged: tagged?.tagged ?? 0 };
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

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Submits the swap to Hypertide's replacement queue and keeps the operation
 * and the new domain's nameservers. Returns the nameservers, or null when the
 * step can't go on (the reason is left on the step).
 */
async function submitHypertideReplacement(sql: Sql, ctx: StepContext, item: Item): Promise<string[] | null> {
  const ht = ctx.hypertide;
  if (!ht) {
    await setStep(sql, item.id, "nameservers", "manual", `Hypertide isn't connected. Replace ${item.oldname} with ${item.newname} in Hypertide, set the nameservers it gives you, then mark this done.`);
    return null;
  }
  const [order] = await sql`
    select status from hypertide_orders where domain_id = ${item.oldid} and gone_at is null
    order by (status = 'Done') desc, last_seen_at desc limit 1`;
  if (order?.status !== "Done") {
    await setStep(sql, item.id, "nameservers", "manual", order
      ? `${item.oldname}'s Hypertide order is "${order.status}", not Done, so Hypertide won't replace it. Press Retry once it is, or replace it by hand and mark this done.`
      : `Hypertide has no order for ${item.oldname}, so it can't be replaced there. Replace it by hand and mark this done, or press Retry after the Hypertide sync.`);
    return null;
  }
  if (ht.dryRun) {
    await setStep(sql, item.id, "nameservers", "manual", `Dry run is on, so the replacement wasn't sent to Hypertide (it refuses test calls). Turn dry run off and press Retry.`);
    return null;
  }
  try {
    const r = await ht.submitReplacement({
      originalDomain: item.oldname,
      newDomain: item.newname,
      copyTagsAndWarmup: item.copytw,
      usernames: item.usernames ?? undefined,
    });
    if (r.error && !r.operationId) throw new Error(`Hypertide: ${r.error}`);
    await sql`update replacement_items set ht_operation_id = ${r.operationId ?? "unknown"}, ht_operation = ${r.status ?? "queued"},
        ht_response = ${r.raw}, ht_checked_at = now(), hypertide_ns = ${r.nameservers.length ? r.nameservers : null}
      where id = ${item.id}`;
    return r.nameservers;
  } catch (e) {
    await setStep(sql, item.id, "nameservers", "failed", null, errText(e));
    return null;
  }
}

/**
 * The inbox step for a Hypertide replacement: follows the operation until
 * Hypertide hands it to inbox setup, then until the new domain's order shows
 * Done in the order sync. Returns true when the step finished.
 */
async function hypertideReplaceStep(sql: Sql, ht: Hypertide | null, item: Item, state: string) {
  const id = item.id;
  const [done] = await sql`select 1 as x from hypertide_orders where domain_id = ${item.newid} and gone_at is null and status = 'Done' limit 1`;
  if (done) {
    await setStep(sql, id, "inboxes", "done", null);
    return true;
  }
  if (!ht || !item.htop || item.htop === "unknown") {
    if (state !== "running") await setStep(sql, id, "inboxes", "running", `Waiting for ${item.newname}'s Hypertide order to show Done (synced every 5 min).`);
    return false;
  }
  // Hypertide's worker runs every 15 minutes; asking every 3 is plenty.
  if (item.htchecked && Date.now() - +new Date(item.htchecked) < 3 * 60_000 && state === "running") return false;
  try {
    const r = await ht.replacementStatus(item.htop, item.newname);
    await sql`update replacement_items set ht_operation = ${r.status}, ht_response = ${r.raw}, ht_checked_at = now() where id = ${id}`;
    const s = r.status ?? "queued";
    if (["expired", "failed", "cancelled", "canceled", "rejected"].includes(s)) {
      await setStep(sql, id, "inboxes", "failed", null, `Hypertide marked the replacement ${s}${r.error ? `: ${r.error}` : ""}. Check it in Hypertide, then Retry or mark this done.`);
      return false;
    }
    const note = s === "completed"
      ? `Hypertide has the replacement and is setting up the inboxes on ${item.newname}. Waiting for its order to show Done (synced every 5 min).`
      : s === "awaiting_payment" || r.requiresPayment
        ? `Hypertide is waiting for payment on this replacement. Finish it in the Hypertide dashboard; this step carries on by itself.`
        : `Hypertide: ${s.replace(/_/g, " ")}. Its worker picks replacements up every 15 minutes.`;
    await setStep(sql, id, "inboxes", "running", note);
  } catch (e) {
    await setStep(sql, id, "inboxes", "running", `Couldn't check the replacement on Hypertide (${errText(e)}). Trying again in a few minutes.`);
  }
  return false;
}

/**
 * New inboxes need warmup before they can send: turn it on for any that are
 * off, with the old domain's usual warmup numbers when it had them.
 */
async function turnOnWarmup(sql: Sql, item: Item, actor: string) {
  const [old] = await sql`
    select mode() within group (order by warmup_per_day) filter (where warmup_per_day > 0) as perday,
      mode() within group (order by warmup_rampup) filter (where warmup_rampup is not null) as rampup,
      mode() within group (order by warmup_reply_rate) filter (where warmup_reply_rate is not null) as reply
    from inboxes where domain_id = ${item.oldid} and status <> 'removed'`;
  const changes: Record<string, number | boolean> = { warmup_enabled: true };
  if (old?.perday != null) changes.warmup_per_day = Number(old.perday);
  if (old?.rampup != null) changes.warmup_rampup = Number(old.rampup);
  if (old?.reply != null) changes.warmup_reply_rate = Number(old.reply);
  await sql`
    insert into inbox_setting_changes (inbox_id, changes, source, actor)
    select id, ${sql.json(changes)}, 'replacement', ${actor}
    from inboxes where domain_id = ${item.newid} and status = 'connected' and smartlead_account_id is not null
      and warmup_enabled is not true`;
  await sql`update replacement_items set warmup_queued_at = now() where id = ${item.id}`;
}

/** New inboxes start with the old domain's most common daily limit and gap. */
async function copySendingSettings(sql: Sql, item: Item, actor: string) {
  const [old] = await sql`
    select mode() within group (order by daily_limit) filter (where daily_limit > 0) as limit,
      mode() within group (order by min_wait_mins) filter (where min_wait_mins is not null) as wait
    from inboxes where domain_id = ${item.oldid} and status <> 'removed'`;
  const changes: Record<string, number> = {};
  if (old?.limit != null) changes.daily_limit = Number(old.limit);
  if (old?.wait != null) changes.min_wait_mins = Number(old.wait);
  if (!Object.keys(changes).length) return;
  await sql`
    insert into inbox_setting_changes (inbox_id, changes, source, actor)
    select id, ${sql.json(changes)}, 'replacement', ${actor}
    from inboxes where domain_id = ${item.newid} and status = 'connected' and smartlead_account_id is not null`;
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
  // Paid: the step is no longer waiting on a person, so the runner takes over.
  await sql`update replacement_items set hypertide_paid_at = now(), hypertide_status = 'Paid', note = null,
      step_inboxes = 'pending' where id = any(${ids}::uuid[])`;
  for (const x of rows) await advanceItem(sql, ctx, x.id as string, actor);
  return { charged: rows.length, dryRun: false };
}

/**
 * Mirrors the replacement tags on the inboxes in Smartlead: "New" on the new
 * inboxes until they join campaigns, "Replaced" on the old ones once their
 * grace period starts. Each inbox keeps its other tags (Smartlead replaces the
 * whole set, so inboxes are written in groups that share the same result).
 */
export async function syncSmartleadTags(sql: Sql, app: SmartleadApp) {
  const due = await sql`
    select ri.id, ri.new_domain_id as newid, ri.old_domain_id as oldid, ri.step_campaigns as campaigns,
      (ri.sl_new_tagged_at is null and ri.step_smartlead in ('done', 'skipped')) as fornew,
      (ri.sl_old_tagged_at is null and od.status = 'draining') as forold
    from replacement_items ri
    join replacement_batches rb on rb.id = ri.batch_id
    join domains od on od.id = ri.old_domain_id
    where rb.hypertide_replace and ri.created_at > now() - interval '60 days'
      and ((ri.sl_new_tagged_at is null and ri.step_smartlead in ('done', 'skipped'))
        or (ri.sl_old_tagged_at is null and od.status = 'draining'))`;
  if (!due.length) return { tagged: 0, errors: 0 };
  let known: SmartleadTag[] = await app.tags();
  const tagId = async (name: string) => {
    let t = known.find((k) => k.name.toLowerCase() === name.toLowerCase());
    if (!t) {
      const made = await app.createTag(name);
      if (!made) return null;
      known = [...known, made];
      t = made;
    }
    return t;
  };
  let tagged = 0, errors = 0;
  for (const r of due) {
    try {
      if (r.fornew) {
        tagged += await retagInboxes(sql, app, r.newid as string, r.campaigns === "done" ? [] : ["New"], r.campaigns === "done" ? ["New"] : [], tagId, () => known);
        await sql`update replacement_items set sl_new_tagged_at = now() where id = ${r.id}`;
      }
      if (r.forold) {
        tagged += await retagInboxes(sql, app, r.oldid as string, ["Replaced"], ["New"], tagId, () => known);
        await sql`update replacement_items set sl_old_tagged_at = now() where id = ${r.id}`;
      }
    } catch {
      errors++; // logged in api_calls; tried again on the next run
    }
  }
  return { tagged, errors };
}

async function retagInboxes(
  sql: Sql, app: SmartleadApp, domainId: string, add: string[], remove: string[],
  tagId: (name: string) => Promise<SmartleadTag | null>, known: () => SmartleadTag[],
) {
  const inboxes = await sql`
    select id, smartlead_account_id as account, smartlead_tags as tags from inboxes
    where domain_id = ${domainId} and status = 'connected' and smartlead_account_id is not null`;
  return retagRows(sql, app, inboxes, add, remove, tagId, known);
}

/** Adds and removes tags on the given inboxes (id, account, tags), keeping each one's other tags. */
export async function retagRows(
  sql: Sql, app: SmartleadApp, inboxes: readonly postgres.Row[], add: string[], remove: string[],
  tagId: (name: string) => Promise<SmartleadTag | null>, known: () => SmartleadTag[],
) {
  for (const name of add) if (!(await tagId(name))) return 0;
  const lower = (x: string) => x.toLowerCase();
  const groups = new Map<string, { names: string[]; accounts: number[]; ids: string[] }>();
  for (const ib of inboxes) {
    const current = (ib.tags as string[]) ?? [];
    const names = [...new Map([...current, ...add].filter((t) => !remove.map(lower).includes(lower(t))).map((t) => [lower(t), t])).values()];
    if (names.length === current.length && names.every((n) => current.map(lower).includes(lower(n)))) continue;
    const key = names.map(lower).sort().join("|");
    const g = groups.get(key) ?? { names, accounts: [], ids: [] };
    g.accounts.push(Number(ib.account));
    g.ids.push(ib.id as string);
    groups.set(key, g);
  }
  let n = 0;
  for (const g of groups.values()) {
    const tags = g.names.map((name) => known().find((k) => lower(k.name) === lower(name))).filter((t): t is SmartleadTag => Boolean(t));
    await app.bulkConfig(g.accounts, { tags: tags.map((t) => t.id) });
    await sql`update inboxes set smartlead_tags = ${tags.map((t) => t.name)}::text[] where id = any(${g.ids}::uuid[])`;
    n += g.accounts.length;
  }
  return n;
}
