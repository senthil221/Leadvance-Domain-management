"use server";

import { refresh } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { jobSql, sql } from "@/lib/db";
import { getDomainDetail, listStorageCandidates } from "@/lib/queries";
import { DOMAIN_STATUSES, REPLACEMENT_REASONS } from "@/lib/status";

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

// Database rules raise check_violation / no_data_found with a message written
// for people; anything else is unexpected and gets a generic message.
function fail(e: unknown): { ok: false; error: string } {
  const err = e as { code?: string; message?: string };
  if (err?.code === "23514" || err?.code === "P0002") return { ok: false, error: err.message ?? "Not allowed" };
  if (err?.code === "23505") return { ok: false, error: "That already exists" };
  if (e instanceof z.ZodError) return { ok: false, error: e.issues[0]?.message ?? "Invalid input" };
  console.error(e);
  return { ok: false, error: "Something went wrong. Nothing was changed." };
}

const ids = z.array(z.uuid()).min(1, "Select at least one domain").max(2000);

export async function loadDomainDetail(id: string) {
  await requireActor();
  return getDomainDetail(z.uuid().parse(id));
}

export async function loadSearchIndex() {
  await requireActor();
  return sql<{ id: string; name: string; status: (typeof DOMAIN_STATUSES)[number]; client: string | null }[]>`
    select d.id, d.name, d.status, c.name as client
    from domains d left join clients c on c.id = d.client_id
    order by (d.status = 'active') desc, d.name`;
}

export async function loadStorageCandidates() {
  await requireActor();
  return listStorageCandidates();
}

const changeStatusInput = z.object({
  ids,
  to: z.enum(DOMAIN_STATUSES),
  reason: z.string().trim().max(500).optional(),
  force: z.boolean().optional(),
});

export async function changeStatus(input: z.input<typeof changeStatusInput>): Promise<ActionResult<{ changed: number }>> {
  try {
    const actor = await requireActor();
    const { ids, to, reason, force } = changeStatusInput.parse(input);
    await sql.begin(async (tx) => {
      for (const id of ids) {
        await tx`select transition_domain(${id}, ${to}::domain_status, ${reason ?? null}, ${actor}, null, ${force ?? false})`;
      }
    });
    refresh();
    return { ok: true, data: { changed: ids.length } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Records domains as replaced (burned) without running a replacement, for old
 * data, or moves them to recovery (resting).
 */
export async function markReplaced(input: { ids: string[]; note?: string; to?: "replaced" | "recovery" }): Promise<ActionResult<{ changed: number }>> {
  try {
    const actor = await requireActor();
    const v = z.object({ ids, note: z.string().trim().max(300).optional(), to: z.enum(["replaced", "recovery"]).default("replaced") }).parse(input);
    const reason = `${v.to === "recovery" ? "Moved to recovery" : "Marked as replaced"}${v.note ? `: ${v.note}` : ""}`;
    const target = v.to === "recovery" ? "resting" : "burned";
    const skip = v.to === "recovery" ? ["resting"] : ["draining", "burned", "resting"];
    const rows = await sql.begin((tx) => tx<{ id: string }[]>`
      select (transition_domain(id, ${target}::domain_status, ${reason}, ${actor}, null, true)).id from domains
      where id in ${sql(v.ids)} and status::text <> all(${skip}::text[])`);
    refresh();
    return { ok: true, data: { changed: rows.length } };
  } catch (e) {
    return fail(e);
  }
}

const assignClientInput = z.object({ ids, clientId: z.uuid().nullable() });

export async function assignClient(input: z.input<typeof assignClientInput>): Promise<ActionResult<{ changed: number }>> {
  try {
    await requireActor();
    const { ids, clientId } = assignClientInput.parse(input);
    const rows = await sql`update domains set client_id = ${clientId} where id in ${sql(ids)} and status <> 'in_storage' returning id`;
    refresh();
    return { ok: true, data: { changed: rows.length } };
  } catch (e) {
    return fail(e);
  }
}

const replacementInput = z
  .object({
    oldIds: ids,
    newIds: ids,
    reason: z.enum(Object.keys(REPLACEMENT_REASONS) as [keyof typeof REPLACEMENT_REASONS]),
    note: z.string().trim().max(1000).optional(),
    manualInboxes: z.boolean().optional(),
  })
  .refine((v) => v.oldIds.length === v.newIds.length, "Need one new domain for each old domain")
  .refine((v) => new Set(v.newIds).size === v.newIds.length, "Each new domain can only be used once");

export async function startReplacement(input: z.input<typeof replacementInput>): Promise<ActionResult<{ batchId: string }>> {
  try {
    const actor = await requireActor();
    const { oldIds, newIds, reason, note, manualInboxes } = replacementInput.parse(input);
    const row = await sql.begin(async (tx) => {
      const [r] = await tx<{ batchId: string }[]>`
        select start_replacement(${oldIds}::uuid[], ${newIds}::uuid[], ${reason}::replacement_reason, ${note ?? null}, ${actor}) as batch_id`;
      if (manualInboxes) await tx`update replacement_batches set manual_inboxes = true where id = ${r.batchId}`;
      return r;
    });
    refresh();
    return { ok: true, data: { batchId: row.batchId } };
  } catch (e) {
    return fail(e);
  }
}

const domainName = z
  .string()
  .trim()
  .toLowerCase()
  .transform((s) => s.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""))
  .pipe(z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, "Not a domain name"));

const addDomainsInput = z.object({
  names: z.array(z.string()).min(1, "Add at least one domain").max(5000),
  registrarId: z.uuid().nullable(),
  purchasedAt: z.iso.date().nullable(),
  expiresAt: z.iso.date().nullable(),
  costCents: z.number().int().min(0).nullable(),
});

export async function addDomains(
  input: z.input<typeof addDomainsInput>,
): Promise<ActionResult<{ added: number; duplicates: string[]; invalid: string[] }>> {
  try {
    const actor = await requireActor();
    const v = addDomainsInput.parse(input);
    const valid = new Set<string>();
    const invalid: string[] = [];
    for (const raw of v.names) {
      if (!raw.trim()) continue;
      const r = domainName.safeParse(raw);
      if (r.success) valid.add(r.data);
      else invalid.push(raw.trim());
    }
    const names = [...valid];
    let inserted: { name: string }[] = [];
    if (names.length) {
      inserted = await sql.begin(async (tx) => {
        await tx`select set_config('app.actor', ${actor}, true)`;
        return tx<{ name: string }[]>`
          insert into domains ${tx(
            names.map((name) => ({
              name,
              registrar_id: v.registrarId,
              purchased_at: v.purchasedAt,
              expires_at: v.expiresAt,
              cost_cents: v.costCents,
            })),
          )}
          on conflict (name) do nothing
          returning name`;
      });
    }
    const added = new Set(inserted.map((r) => r.name));
    refresh();
    return { ok: true, data: { added: added.size, duplicates: names.filter((n) => !added.has(n)), invalid } };
  } catch (e) {
    return fail(e);
  }
}

// Hues spaced around the wheel so neighbouring clients never look alike.
const HUES = [255, 150, 30, 300, 190, 345, 90, 220, 280, 60, 120, 10];

export async function createClient(name: string): Promise<ActionResult<{ id: string }>> {
  try {
    await requireActor();
    const clean = z.string().trim().min(1, "Name the client").max(80).parse(name);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from clients`;
    const [row] = await sql<{ id: string }[]>`insert into clients (name, hue) values (${clean}, ${HUES[n % HUES.length]}) returning id`;
    // Campaigns and domains whose names mention the new client pick it up.
    await sql`select * from assign_clients_from_campaigns()`;
    refresh();
    return { ok: true, data: { id: row.id } };
  } catch (e) {
    return fail(e);
  }
}

export async function updateAlert(id: string, status: "resolved" | "snoozed"): Promise<ActionResult> {
  try {
    await requireActor();
    await sql`
      update alerts set status = ${status}::alert_status,
        resolved_at = case when ${status} = 'resolved' then now() end,
        snoozed_until = case when ${status} = 'snoozed' then now() + interval '3 days' end
      where id = ${z.uuid().parse(id)}`;
    refresh();
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}

const ruleInput = z.object({
  id: z.uuid(),
  threshold: z.number().finite(),
  minSent: z.number().int().min(0).max(1_000_000),
  windowDays: z.number().int().min(1).max(90),
  severity: z.enum(["warning", "critical"]),
  enabled: z.boolean(),
});

export async function updateRule(input: z.input<typeof ruleInput>): Promise<ActionResult> {
  try {
    await requireActor();
    const r = ruleInput.parse(input);
    await sql`update health_rules set threshold = ${r.threshold}, min_sent = ${r.minSent}, window_days = ${r.windowDays},
      severity = ${r.severity}, enabled = ${r.enabled} where id = ${r.id}`;
    await sql`select * from evaluate_health_rules()`;
    refresh();
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}

export async function runHealthCheck(): Promise<ActionResult<{ opened: number; resolved: number }>> {
  try {
    await requireActor();
    const [r] = await sql<{ opened: number; resolved: number }[]>`select * from evaluate_health_rules()`;
    refresh();
    return { ok: true, data: r };
  } catch (e) {
    return fail(e);
  }
}

export async function reclassifyReply(id: number, cls: "human" | "ooo" | "auto" | "negative"): Promise<ActionResult> {
  try {
    await requireActor();
    const c = z.enum(["human", "ooo", "auto", "negative"]).parse(cls);
    await sql`update email_events set reply_class = ${c}::reply_class, class_overridden = true where id = ${z.number().int().parse(id)} and kind = 'reply'`;
    refresh();
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}

const hostname = z.string().trim().toLowerCase().regex(/^[a-z0-9-]+(.[a-z0-9-]+)+.?$/, "Nameservers must be hostnames like ns1.example.com");
const settingsInput = z.object({
  drainDays: z.number().int().min(1).max(60),
  storageLowThreshold: z.number().int().min(0).max(10_000),
  hypertideNameservers: z.array(hostname).max(13),
});

export async function saveSettings(input: z.input<typeof settingsInput>): Promise<ActionResult> {
  try {
    await requireActor();
    const s = settingsInput.parse(input);
    const ns = s.hypertideNameservers.map((n) => n.replace(/\.$/, ""));
    await sql`insert into settings (key, value) values
        ('drain_days', ${sql.json(s.drainDays)}),
        ('storage_low_threshold', ${sql.json(s.storageLowThreshold)}),
        ('hypertide_nameservers', ${sql.json(ns)})
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
    refresh();
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}

export async function runJobNow(name: string): Promise<ActionResult<Record<string, unknown>>> {
  try {
    await requireActor();
    const { JOBS, runJob } = await import("@/jobs");
    const job = JOBS.find((j) => j.name === name);
    if (!job) return { ok: false, error: "Unknown job" };
    const r = await runJob(jobSql, job);
    refresh();
    return r.ok ? { ok: true, data: r.detail } : { ok: false, error: r.error };
  } catch (e) {
    return fail(e);
  }
}

const stepInput = z.object({
  itemId: z.uuid(),
  step: z.enum(["nameservers", "inboxes", "smartlead", "campaigns"]),
  action: z.enum(["done", "retry", "skip"]),
});

export async function actOnReplacementStep(input: z.input<typeof stepInput>): Promise<ActionResult<{ next: string | null; completed: boolean }>> {
  try {
    const actor = await requireActor();
    const { itemId, step, action } = stepInput.parse(input);
    const { jobContext } = await import("@/jobs");
    const { actOnStep } = await import("@/jobs/replacements");
    const ctx = await jobContext(jobSql);
    const r = await actOnStep(sql, { porkbun: ctx.porkbun, hypertide: ctx.hypertide, hypertideCredentials: ctx.hypertideCredentials }, itemId, step, action, actor);
    refresh();
    return { ok: true, data: r };
  } catch (e) {
    if (e instanceof Error && /Finish the earlier|already finished|not found/.test(e.message)) return { ok: false, error: e.message };
    return fail(e);
  }
}

// Charges Hypertide for placed orders. Only ever runs on this explicit click.
export async function approveHypertidePayment(itemIds: string[]): Promise<ActionResult<{ charged: number; dryRun: boolean }>> {
  try {
    const actor = await requireActor();
    const ids = z.array(z.uuid()).min(1).max(100).parse(itemIds);
    const { jobContext } = await import("@/jobs");
    const { approveHypertidePayment: approve } = await import("@/jobs/replacements");
    const ctx = await jobContext(jobSql);
    if (!ctx.hypertide) return { ok: false, error: "Hypertide isn't connected" };
    const r = await approve(sql, { porkbun: ctx.porkbun, hypertide: ctx.hypertide, hypertideCredentials: ctx.hypertideCredentials }, ids, actor);
    refresh();
    return { ok: true, data: r };
  } catch (e) {
    if (e instanceof Error && /Nothing to pay for|Hypertide/.test(e.message)) return { ok: false, error: e.message };
    return fail(e);
  }
}

const templateInput = z.object({
  plan: z.enum(["entra", "google"]),
  inbox_quantity: z.union([z.literal(25), z.literal(50)]),
  forwarding_domain: z.string().trim().toLowerCase().max(200),
  client_name: z.string().trim().max(120),
});

export async function saveHypertideTemplate(input: z.input<typeof templateInput>): Promise<ActionResult> {
  try {
    await requireActor();
    const t = templateInput.parse(input);
    await sql`insert into settings (key, value) values ('hypertide_order_template', ${sql.json(t)})
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
    refresh();
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}

const nsName = z.string().trim().toLowerCase().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, "Not a nameserver");
const setupInput = z.object({
  ids,
  // undefined leaves the client as it is; null clears it.
  clientId: z.uuid().nullable().optional(),
  addTags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  removeTags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  nameservers: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("leave") }),
    z.object({ mode: z.literal("hypertide") }),
    z.object({ mode: z.literal("custom"), list: z.array(nsName).min(2, "Give at least two nameservers").max(13) }),
  ]),
  startSetup: z.boolean().default(false),
});

/**
 * The hand-ordering workflow in one step: client, tags, nameservers (queued,
 * applied right after this returns and by the worker) and, for domains in
 * storage, the move to Provisioning.
 */
export async function setupDomains(input: z.input<typeof setupInput>): Promise<ActionResult<{ provisioning: number; nameservers: number; updated: number }>> {
  try {
    const actor = await requireActor();
    const v = setupInput.parse(input);
    const result = await sql.begin(async (tx) => {
      await tx`select set_config('app.actor', ${actor}, true)`;
      let provisioning = 0;
      if (v.startSetup) {
        const moved = await tx`
          select transition_domain(id, 'provisioning', 'set up for Hypertide', ${actor}) from domains
          where id in ${tx(v.ids)} and status = 'in_storage'`;
        provisioning = moved.length;
      }
      if (v.clientId !== undefined) await tx`update domains set client_id = ${v.clientId} where id in ${tx(v.ids)}`;
      if (v.addTags.length || v.removeTags.length) {
        await tx`
          update domains set tags = array(
            select distinct t from unnest(tags || ${v.addTags}::text[]) t
            where not (lower(t) = any(${v.removeTags.map((t) => t.toLowerCase())}::text[])) order by t)
          where id in ${tx(v.ids)}`;
      }
      let nameservers = 0;
      if (v.nameservers.mode !== "leave") {
        // A newer request replaces any still waiting for the same domain.
        await tx`delete from nameserver_requests where domain_id in ${tx(v.ids)} and status = 'pending'`;
        const target = v.nameservers.mode === "custom" ? v.nameservers.list : null;
        const rows = await tx`
          insert into nameserver_requests (domain_id, source, target, actor)
          select id, ${v.nameservers.mode}, ${target}::text[], ${actor} from domains
          where id in ${tx(v.ids)} and status not in ('burned', 'resting')
          returning id`;
        nameservers = rows.length;
      }
      return { provisioning, nameservers, updated: v.ids.length };
    });
    if (result.nameservers) {
      after(async () => {
        const { JOBS, runJob } = await import("@/jobs");
        const job = JOBS.find((j) => j.name === "nameserver-requests");
        if (job) await runJob(jobSql, job);
      });
    }
    refresh();
    return { ok: true, data: result };
  } catch (e) {
    return fail(e);
  }
}

export async function loadNameserverStatus(domainIds: string[]) {
  await requireActor();
  const list = z.array(z.uuid()).max(2000).parse(domainIds);
  if (!list.length) return [];
  return sql<{ domainId: string; status: string; message: string | null; target: string[] | null }[]>`
    select distinct on (domain_id) domain_id, status, message, target
    from nameserver_requests where domain_id in ${sql(list)}
    order by domain_id, created_at desc`;
}

// ---------------------------------------------------------------------------
// Inbox settings and daily sending plans
// ---------------------------------------------------------------------------

const count = (max: number) => z.number().int().min(0).max(max);
const limitInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("keep") }),
  z.object({ mode: z.literal("set"), value: count(1000) }),
  z.object({ mode: z.literal("random"), min: count(1000), max: count(1000) }),
  z.object({ mode: z.literal("split"), total: count(1_000_000), min: count(1000), max: count(1000) }),
]);
const inboxSettingsInput = z.object({
  inboxIds: z.array(z.uuid()).min(1, "Select at least one inbox").max(5000),
  dailyLimit: limitInput,
  minWait: count(1440).optional(),
  warmupEnabled: z.boolean().optional(),
  warmupPerDay: count(200).optional(),
  warmupRampup: count(200).optional(),
  warmupReplyRate: count(100).optional(),
}).refine((v) => !("min" in v.dailyLimit) || v.dailyLimit.min <= v.dailyLimit.max, "The lowest daily limit can't be above the highest");

function kickJob(name: string) {
  after(async () => {
    const { JOBS, runJob } = await import("@/jobs");
    const job = JOBS.find((j) => j.name === name);
    if (job) await runJob(jobSql, job);
  });
}

/** Queues setting changes for Smartlead; the worker pushes them within a minute. */
export async function updateInboxSettings(input: z.input<typeof inboxSettingsInput>): Promise<ActionResult<{ queued: number; total: number | null }>> {
  try {
    const actor = await requireActor();
    const v = inboxSettingsInput.parse(input);
    const { distribute, randomInt } = await import("@/lib/distribute");
    const inboxes = await sql<{ id: string }[]>`
      select id from inboxes where id in ${sql(v.inboxIds)} and smartlead_account_id is not null and status <> 'removed' order by email`;
    if (!inboxes.length) return { ok: false, error: "None of these inboxes are linked to Smartlead" };

    const l = v.dailyLimit;
    const limits: (number | undefined)[] =
      l.mode === "set" ? inboxes.map(() => l.value)
      : l.mode === "random" ? inboxes.map(() => randomInt(l.min, l.max))
      : l.mode === "split" ? distribute(inboxes.length, l.total, l.min, l.max).values
      : inboxes.map(() => undefined);
    const common = {
      ...(v.minWait != null ? { min_wait_mins: v.minWait } : {}),
      ...(v.warmupEnabled != null ? { warmup_enabled: v.warmupEnabled } : {}),
      ...(v.warmupPerDay != null ? { warmup_per_day: v.warmupPerDay } : {}),
      ...(v.warmupRampup != null ? { warmup_rampup: v.warmupRampup } : {}),
      ...(v.warmupReplyRate != null ? { warmup_reply_rate: v.warmupReplyRate } : {}),
    };
    const rows = inboxes.map((ib, i) => ({ inbox_id: ib.id, changes: { ...common, ...(limits[i] != null ? { daily_limit: limits[i] } : {}) } }))
      .filter((r) => Object.keys(r.changes).length > 0);
    if (!rows.length) return { ok: false, error: "Nothing to change: pick at least one setting" };
    await sql`
      insert into inbox_setting_changes (inbox_id, changes, actor)
      select r.inbox_id, r.changes, ${actor} from jsonb_to_recordset(${sql.json(rows)}) as r(inbox_id uuid, changes jsonb)`;
    kickJob("inbox-settings");
    refresh();
    const total = limits.every((x) => x != null) ? (limits as number[]).reduce((a, b) => a + b, 0) : null;
    return { ok: true, data: { queued: rows.length, total } };
  } catch (e) {
    return fail(e);
  }
}

const planInput = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1, "Give the plan a name").max(80),
  mode: z.enum(["shuffle", "random_total"]),
  totalMin: count(1_000_000),
  totalMax: count(1_000_000),
  inboxMin: count(1000),
  inboxMax: count(1000),
  clientId: z.uuid().nullable(),
  domainIds: z.array(z.uuid()).max(5000).default([]),
  runHour: z.number().int().min(0).max(23),
  enabled: z.boolean().default(true),
}).refine((v) => v.inboxMax > 0, "The highest per-inbox limit must be above 0")
  .refine((v) => v.inboxMin <= v.inboxMax, "The lowest per-inbox limit can't be above the highest")
  .refine((v) => v.mode === "shuffle" || v.totalMin <= v.totalMax, "The lowest total can't be above the highest")
  .refine((v) => v.clientId || v.domainIds.length, "Pick a client or some domains");

export async function saveSendingPlan(input: z.input<typeof planInput>): Promise<ActionResult<{ id: string }>> {
  try {
    const actor = await requireActor();
    const v = planInput.parse(input);
    const totalMax = v.mode === "shuffle" ? v.totalMin : v.totalMax;
    const domains = v.clientId ? [] : v.domainIds;
    const [row] = v.id
      ? await sql<{ id: string }[]>`
          update sending_plans set name = ${v.name}, mode = ${v.mode}, total_min = ${v.totalMin}, total_max = ${totalMax},
            inbox_min = ${v.inboxMin}, inbox_max = ${v.inboxMax}, client_id = ${v.clientId}, domain_ids = ${domains}::uuid[],
            run_hour = ${v.runHour}, enabled = ${v.enabled}
          where id = ${v.id} returning id`
      : await sql<{ id: string }[]>`
          insert into sending_plans (name, mode, total_min, total_max, inbox_min, inbox_max, client_id, domain_ids, run_hour, enabled, created_by)
          values (${v.name}, ${v.mode}, ${v.totalMin}, ${totalMax}, ${v.inboxMin}, ${v.inboxMax}, ${v.clientId}, ${domains}::uuid[], ${v.runHour}, ${v.enabled}, ${actor})
          returning id`;
    if (!row) return { ok: false, error: "That plan no longer exists" };
    refresh();
    return { ok: true, data: { id: row.id } };
  } catch (e) {
    return fail(e);
  }
}

export async function setSendingPlanEnabled(id: string, enabled: boolean): Promise<ActionResult> {
  try {
    await requireActor();
    await sql`update sending_plans set enabled = ${enabled} where id = ${z.uuid().parse(id)}`;
    refresh();
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteSendingPlan(id: string): Promise<ActionResult> {
  try {
    await requireActor();
    await sql`delete from sending_plans where id = ${z.uuid().parse(id)}`;
    refresh();
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}

/** Runs a plan now (it still runs again tomorrow at its hour). */
export async function runSendingPlanNow(id: string): Promise<ActionResult<{ total: number; inboxes: number; clamped: boolean }>> {
  try {
    const actor = await requireActor();
    const { loadPlan, runPlan } = await import("@/jobs/inbox-settings");
    const plan = await loadPlan(jobSql, z.uuid().parse(id));
    if (!plan) return { ok: false, error: "That plan no longer exists" };
    const r = await runPlan(jobSql, plan, actor);
    kickJob("inbox-settings");
    refresh();
    return { ok: true, data: r };
  } catch (e) {
    return fail(e);
  }
}

const statsRange = z.object({ from: z.iso.date(), to: z.iso.date() })
  .refine((v) => v.from <= v.to, "The start date is after the end date")
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 < 92, "Pick a range of 92 days or less");

export async function loadStats(input: z.input<typeof statsRange>): Promise<ActionResult<import("@/lib/queries").StatsData>> {
  try {
    await requireActor();
    const { from, to } = statsRange.parse(input);
    const { getStats } = await import("@/lib/queries");
    return { ok: true, data: await getStats(from, to) };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// Domain checks: DNS validation and reconnecting inboxes
// ---------------------------------------------------------------------------

/**
 * Re-checks DNS now: the app's own SPF/DKIM/DMARC/MX lookup for the given
 * domains (or every sending domain), and, with a Smartlead token, Smartlead's
 * own re-verification of every connected domain.
 */
export async function validateDns(domainIds: string[] = []): Promise<ActionResult<{ message: string }>> {
  try {
    await requireActor();
    const list = z.array(z.uuid()).max(5000).parse(domainIds);
    const due = list.length
      ? await sql`update domains set nameservers_checked_at = null where id in ${sql(list)} returning id`
      : await sql`update domains set nameservers_checked_at = null where status in ('provisioning', 'warming', 'active') returning id`;
    kickJob("nameserver-check");
    const { jobContext } = await import("@/jobs");
    const ctx = await jobContext(jobSql);
    let smartlead = "Add a Smartlead token (SMARTLEAD_JWT) to also have Smartlead re-verify its own DNS status.";
    if (ctx.smartleadApp) {
      await ctx.smartleadApp.verifyDomains();
      smartlead = ctx.smartleadApp.dryRun ? "Dry run: Smartlead's re-verification wasn't sent." : "Smartlead is re-verifying every connected domain too.";
    }
    return { ok: true, data: { message: `Checking DNS on ${due.length} domain${due.length === 1 ? "" : "s"} now. ${smartlead}` } };
  } catch (e) {
    if (e instanceof Error && /Smartlead|token/.test(e.message)) return { ok: false, error: e.message };
    return fail(e);
  }
}

/** A refusal worded for people, shown as is. */
class UserError extends Error {}

async function smartleadAppOrError(what: string) {
  const { jobContext } = await import("@/jobs");
  const app = (await jobContext(jobSql)).smartleadApp;
  if (!app) throw new UserError(`${what} needs a Smartlead token: save SMARTLEAD_JWT on the server first.`);
  return app;
}

async function linkedAccounts(inboxIds: string[]) {
  const rows = await sql<{ id: string; account: string }[]>`
    select id, smartlead_account_id as account from inboxes
    where id in ${sql(inboxIds)} and smartlead_account_id is not null and status <> 'removed'`;
  if (!rows.length) throw new UserError("None of these inboxes are linked to Smartlead");
  return rows;
}

const appError = (e: unknown) => (e instanceof UserError || (e instanceof Error && /Smartlead|token/.test(e.message)) ? { ok: false as const, error: (e as Error).message } : fail(e));

/** The workspace's Smartlead tags, for the tag picker. */
export async function loadSmartleadTags(): Promise<ActionResult<{ tags: { id: number; name: string; color: string }[] }>> {
  try {
    await requireActor();
    const app = await smartleadAppOrError("Loading tags");
    return { ok: true, data: { tags: await app.tags() } };
  } catch (e) {
    return appError(e);
  }
}

export async function createSmartleadTag(name: string): Promise<ActionResult<{ message: string; tag: { id: number; name: string; color: string } | null }>> {
  try {
    await requireActor();
    const n = z.string().trim().min(1, "Give the tag a name").max(100).parse(name);
    const app = await smartleadAppOrError("Creating a tag");
    const tag = await app.createTag(n);
    return { ok: true, data: { tag, message: tag ? `Created the tag "${tag.name}" in Smartlead` : `Dry run: the tag "${n}" wasn't created in Smartlead` } };
  } catch (e) {
    return appError(e);
  }
}

/** Replaces the Smartlead tags of the chosen inboxes. Unknown names are refused before anything is written. */
export async function updateInboxTags(input: { inboxIds: string[]; tags: string[] }): Promise<ActionResult<{ message: string }>> {
  try {
    await requireActor();
    const v = z.object({
      inboxIds: z.array(z.uuid()).min(1, "Select at least one inbox").max(5000),
      tags: z.array(z.string().trim().min(1)).min(1, "Enter at least one tag").max(50),
    }).parse(input);
    const names = [...new Map(v.tags.map((t) => [t.toLowerCase(), t])).values()];
    const app = await smartleadAppOrError("Updating tags");
    const rows = await linkedAccounts(v.inboxIds);
    const known = new Map((await app.tags()).map((t) => [t.name.toLowerCase(), t]));
    const missing = names.filter((n) => !known.has(n.toLowerCase()));
    if (missing.length) return { ok: false, error: `No Smartlead tag named ${missing.slice(0, 3).map((n) => `"${n}"`).join(", ")}. Create it first, then apply it.` };
    const tags = names.map((n) => known.get(n.toLowerCase())!);
    await app.bulkConfig(rows.map((r) => Number(r.account)), { tags: tags.map((t) => t.id) });
    if (app.dryRun) return { ok: true, data: { message: `Dry run: ${rows.length} inbox${rows.length === 1 ? "" : "es"} weren't retagged in Smartlead` } };
    await sql`update inboxes set smartlead_tags = ${tags.map((t) => t.name)}::text[] where id in ${sql(rows.map((r) => r.id))}`;
    refresh();
    return { ok: true, data: { message: `Tagged ${rows.length} inbox${rows.length === 1 ? "" : "es"} ${tags.map((t) => t.name).join(", ")}` } };
  } catch (e) {
    return appError(e);
  }
}

const warmupConfigInput = z.object({
  inboxIds: z.array(z.uuid()).min(1, "Select at least one inbox").max(5000),
  min: count(1000),
  max: count(1000),
  rampup: count(1000),
  replyRate: count(100),
  tag: z.string().trim().max(100),
  rampupEnabled: z.boolean(),
}).refine((v) => v.min <= v.max, "Min warmup per day can't be above Max")
  .refine((v) => v.max > 0, "Max warmup per day must be above 0");

/**
 * Writes the whole warmup block and turns warmup on. With a Smartlead token it
 * goes in bulk calls, Min and the warmup tag included; a blank tag keeps each
 * inbox's own (one call per tag). Without a token it is queued through the
 * public API, which has no Min or tag.
 */
export async function updateWarmupConfig(input: z.input<typeof warmupConfigInput>): Promise<ActionResult<{ message: string }>> {
  try {
    const actor = await requireActor();
    const v = warmupConfigInput.parse(input);
    const rows = await linkedAccounts(v.inboxIds);
    const n = `${rows.length} inbox${rows.length === 1 ? "" : "es"}`;
    const { jobContext } = await import("@/jobs");
    const app = (await jobContext(jobSql)).smartleadApp;
    if (app) {
      // Smartlead replaces the whole block, tag included, so a blank tag must
      // never be sent: each inbox gets its own back instead.
      const byTag = new Map<string, number[]>();
      if (v.tag) byTag.set(v.tag, rows.map((r) => Number(r.account)));
      else {
        const tags = await sql<{ id: string; tag: string | null }[]>`select id, warmup_tag as tag from inboxes where id in ${sql(rows.map((r) => r.id))}`;
        const tagOf = new Map(tags.map((t) => [t.id, t.tag]));
        const missing = rows.filter((r) => !tagOf.get(r.id)).length;
        if (missing) return { ok: false, error: `${missing} of these inboxes have no warmup tag on record yet. Enter one, or wait for the next Smartlead sync.` };
        for (const r of rows) byTag.set(tagOf.get(r.id)!, [...(byTag.get(tagOf.get(r.id)!) ?? []), Number(r.account)]);
      }
      for (const [tag, accounts] of byTag) {
        await app.bulkConfig(accounts, {
          isRampupEnabled: v.rampupEnabled, maxEmailPerDay: v.max, warmupMinCount: v.min, warmupMaxCount: v.max,
          rampupValue: v.rampup, replyRate: v.replyRate, status: "ACTIVE", warmupTagIdentifier: tag,
        });
      }
      if (app.dryRun) return { ok: true, data: { message: `Dry run: warmup on ${n} wasn't changed in Smartlead` } };
      await sql`update inboxes set warmup_enabled = true, warmup_min = ${v.min}, warmup_per_day = ${v.max},
        warmup_rampup = ${v.rampup}, warmup_rampup_on = ${v.rampupEnabled}, warmup_reply_rate = ${v.replyRate},
        warmup_tag = coalesce(${v.tag || null}, warmup_tag)
        where id in ${sql(rows.map((r) => r.id))}`;
      refresh();
      return { ok: true, data: { message: `Warmup updated on ${n}: ${v.min}–${v.max} a day, ${v.replyRate}% reply rate` } };
    }
    const changes = { warmup_enabled: true, warmup_per_day: v.max, warmup_reply_rate: v.replyRate, ...(v.rampupEnabled ? { warmup_rampup: v.rampup } : {}) };
    await sql`
      insert into inbox_setting_changes (inbox_id, changes, actor)
      select id, ${sql.json(changes)}, ${actor} from unnest(${rows.map((r) => r.id)}::uuid[]) as id`;
    kickJob("inbox-settings");
    refresh();
    return { ok: true, data: { message: `Warmup queued for ${n}. Min and the warmup tag were skipped: they need a Smartlead token (SMARTLEAD_JWT).` } };
  } catch (e) {
    return appError(e);
  }
}

/** Asks Smartlead to retry the login of every inbox whose SMTP or IMAP failed, then re-syncs. */
export async function reconnectInboxes(): Promise<ActionResult<{ message: string }>> {
  try {
    await requireActor();
    const { jobContext } = await import("@/jobs");
    const ctx = await jobContext(jobSql);
    if (!ctx.smartleadApp) return { ok: false, error: "Reconnecting needs a Smartlead token: save SMARTLEAD_JWT on the server first." };
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from inboxes where status = 'disconnected'`;
    await ctx.smartleadApp.reconnectFailed();
    if (ctx.smartleadApp.dryRun) return { ok: true, data: { message: `Dry run: Smartlead wasn't asked to reconnect the ${n} disconnected inboxes.` } };
    // Smartlead reconnects in the background; re-read the inboxes shortly after.
    after(async () => {
      await new Promise((r) => setTimeout(r, 45_000));
      const { JOBS, runJob } = await import("@/jobs");
      const job = JOBS.find((j) => j.name === "smartlead-accounts");
      if (job) await runJob(jobSql, job);
    });
    return { ok: true, data: { message: `Smartlead is reconnecting ${n} disconnected inbox${n === 1 ? "" : "es"}. Statuses refresh in about a minute.` } };
  } catch (e) {
    if (e instanceof Error && /Smartlead|token/.test(e.message)) return { ok: false, error: e.message };
    return fail(e);
  }
}
