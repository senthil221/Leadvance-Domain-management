"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { sql } from "@/lib/db";
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
  })
  .refine((v) => v.oldIds.length === v.newIds.length, "Need one new domain for each old domain")
  .refine((v) => new Set(v.newIds).size === v.newIds.length, "Each new domain can only be used once");

export async function startReplacement(input: z.input<typeof replacementInput>): Promise<ActionResult<{ batchId: string }>> {
  try {
    const actor = await requireActor();
    const { oldIds, newIds, reason, note } = replacementInput.parse(input);
    const [row] = await sql<{ batchId: string }[]>`
      select start_replacement(${oldIds}::uuid[], ${newIds}::uuid[], ${reason}::replacement_reason, ${note ?? null}, ${actor}) as batch_id`;
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
    const r = await runJob(sql, job);
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
    const ctx = await jobContext(sql);
    const r = await actOnStep(sql, { porkbun: ctx.porkbun }, itemId, step, action, actor);
    refresh();
    return { ok: true, data: r };
  } catch (e) {
    if (e instanceof Error && /Finish the earlier|already finished|not found/.test(e.message)) return { ok: false, error: e.message };
    return fail(e);
  }
}
