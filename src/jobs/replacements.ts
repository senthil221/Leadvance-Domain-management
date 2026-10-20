import type postgres from "postgres";
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
};

async function loadItem(sql: Sql, id: string): Promise<Item | undefined> {
  const [row] = await sql`
    select ri.id, ri.step_nameservers as nameservers, ri.step_inboxes as inboxes, ri.step_smartlead as smartlead,
      ri.step_campaigns as campaigns, ri.completed_at as completed,
      nd.id as newid, nd.name as newname, nd.status as newstatus, v.name as registrar, nd.registrar_api_access as apiaccess,
      od.id as oldid, od.name as oldname, od.status as oldstatus
    from replacement_items ri
    join domains nd on nd.id = ri.new_domain_id
    join domains od on od.id = ri.old_domain_id
    left join vendors v on v.id = nd.registrar_id
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

export type StepContext = { porkbun: Porkbun | null };

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
      const ns = await targetNameservers(sql);
      if (!ns.length) {
        await setStep(sql, id, step, "manual", "Add the Hypertide nameservers in Settings → Lifecycle and press Retry, or set them by hand and mark this done.");
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
