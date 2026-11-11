import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations } from "../scripts/migrations";
import { currentStep } from "../src/jobs/replacements";
import { drainState, graceEndsOn, htOf, isDefaultNs, lifeOf, type Life } from "../src/lib/lifecycle";
import { HT_CANCELLED, INBOX_STATUSES, NS_REQUEST_STATUSES, OPEN_QUEUE_STATUSES, SETTING_CHANGE_STATUSES } from "../src/lib/states";
import {
  BATCH_STATUSES, DOMAIN_STATUSES, FORCED_MOVES, NEXT_STATUSES, REPLACEABLE_STATUSES, REPLACEMENT_REASONS, RETIRED_STATUSES, STEP_STATUSES,
  canMove, canReplace, currentStepStatus, isStepFinished, replacementsRefreshSeconds, stepWaitsOnPerson, type DomainStatus, type StepStatus,
} from "../src/lib/status";

// Every state machine in docs/state-machines.md has its states and moves in
// TypeScript and in the database. These pin the two to each other, so a new
// status or move has to be added to both (and to the doc).

let pg: PGlite;
const q = async <T>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows;
let seq = 0;
const addDomain = async (status: DomainStatus) =>
  (await q<{ id: string }>("insert into domains (name, status) values ($1, $2) returning id", [`sm${++seq}.com`, status]))[0].id;

/** The quoted values of the check constraint on table.column. */
async function checkValues(table: string, column: string) {
  const rows = await q<{ def: string }>(
    "select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = $1::regclass and contype = 'c'", [table]);
  const def = rows.map((r) => r.def).find((d) => new RegExp(`\\b${column}\\b`).test(d) && d.includes("'"));
  return [...(def ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
}
const enumValues = async (type: string) => (await q<{ v: string }>(`select unnest(enum_range(null::${type}))::text as v`)).map((r) => r.v);

beforeAll(async () => {
  pg = await PGlite.create();
  for (const m of loadMigrations()) await pg.exec(m.sql);
}, 60_000);
afterAll(async () => { await pg?.close(); });

describe("states agree with the database", () => {
  it("domain statuses, step statuses and replacement reasons match their enums", async () => {
    expect(await enumValues("domain_status")).toEqual([...DOMAIN_STATUSES]);
    expect(await enumValues("step_status")).toEqual([...STEP_STATUSES]);
    expect((await enumValues("replacement_reason")).sort()).toEqual(Object.keys(REPLACEMENT_REASONS).sort());
  });

  it("inbox, queue and batch statuses match their check constraints", async () => {
    expect(await checkValues("inboxes", "status")).toEqual([...INBOX_STATUSES]);
    expect(await checkValues("nameserver_requests", "status")).toEqual([...NS_REQUEST_STATUSES]);
    expect(await checkValues("inbox_setting_changes", "status")).toEqual([...SETTING_CHANGE_STATUSES]);
    expect(await checkValues("replacement_batches", "status")).toEqual([...BATCH_STATUSES]);
    for (const s of OPEN_QUEUE_STATUSES) {
      expect(NS_REQUEST_STATUSES).toContain(s);
      expect(SETTING_CHANGE_STATUSES).toContain(s);
    }
  });
});

describe("the domain lifecycle", () => {
  it("NEXT_STATUSES is exactly domain_transitions", async () => {
    const rows = await q<{ f: DomainStatus; t: DomainStatus }>("select from_status::text as f, to_status::text as t from domain_transitions");
    const db = rows.map((r) => `${r.f}>${r.t}`).sort();
    const ts = DOMAIN_STATUSES.flatMap((f) => NEXT_STATUSES[f].map((t) => `${f}>${t}`)).sort();
    expect(ts).toEqual(db);
  });

  it("transition_domain takes exactly the moves canMove allows, and the rest only when forced with a reason", async () => {
    for (const from of DOMAIN_STATUSES) {
      for (const to of DOMAIN_STATUSES) {
        const id = await addDomain(from);
        const plain = await pg.query("select transition_domain($1, $2::domain_status, 'test', 'tester')", [id, to]).then(() => true, () => false);
        expect([from, to, plain]).toEqual([from, to, canMove(from, to)]);
        if (plain) continue;
        const noReason = await pg.query("select transition_domain($1, $2::domain_status, null, 'tester', null, true)", [id, to]).then(() => true, () => false);
        expect([from, to, noReason]).toEqual([from, to, false]);
        await q("select transition_domain($1, $2::domain_status, 'override', 'tester', null, true)", [id, to]);
        const [h] = await q<{ forced: boolean; to_status: string }>("select forced, to_status::text from domain_status_history where domain_id = $1 order by id desc limit 1", [id]);
        expect(h).toEqual({ forced: true, to_status: to });
      }
    }
  });

  it("the moves the app forces still need force", () => {
    for (const m of FORCED_MOVES) for (const from of m.from) expect([from, m.to, canMove(from, m.to)]).toEqual([from, m.to, false]);
  });

  it("start_replacement only replaces the statuses the UI offers Replace for", async () => {
    for (const s of DOMAIN_STATUSES) {
      const old = await addDomain(s);
      const fresh = await addDomain("in_storage");
      const ok = await pg.query("select start_replacement(array[$1]::uuid[], array[$2]::uuid[], 'other', null, 'tester')", [old, fresh]).then(() => true, () => false);
      expect([s, ok]).toEqual([s, (REPLACEABLE_STATUSES as readonly string[]).includes(s)]);
    }
  });

  it("start_replacement refuses exactly the domains domain_being_replaced flags", async () => {
    const pair = async () => {
      const old = await addDomain("active");
      const fresh = await addDomain("in_storage");
      const [b] = await q<{ id: string }>("select start_replacement(array[$1]::uuid[], array[$2]::uuid[], 'other', null, 'tester') as id", [old, fresh]);
      return { old, fresh, batch: b.id };
    };
    const flagged = async (id: string) => (await q<{ b: boolean }>("select domain_being_replaced($1) as b", [id]))[0].b;
    const again = async (id: string) =>
      pg.query("select start_replacement(array[$1]::uuid[], array[$2]::uuid[], 'other', null, 'tester')", [id, await addDomain("in_storage")]).then(() => true, () => false);

    const running = await pair();
    expect(await flagged(running.old)).toBe(true);
    expect(await again(running.old)).toBe(false);
    // The new domain of a running pair isn't being replaced.
    expect(await flagged(running.fresh)).toBe(false);

    const finished = await pair();
    await q("update replacement_items set completed_at = now() where batch_id = $1", [finished.batch]);
    expect(await flagged(finished.old)).toBe(false);
    expect(await again(finished.old)).toBe(true);

    const cancelled = await pair();
    await q("update replacement_batches set status = 'cancelled' where id = $1", [cancelled.batch]);
    expect(await flagged(cancelled.old)).toBe(false);
    expect(await again(cancelled.old)).toBe(true);
  });

  it("canReplace offers Replace for the statuses start_replacement takes, unless already being replaced", () => {
    for (const s of DOMAIN_STATUSES) {
      expect([s, canReplace(s, false)]).toEqual([s, (REPLACEABLE_STATUSES as readonly string[]).includes(s)]);
      expect([s, canReplace(s, true)]).toEqual([s, false]);
    }
  });

  it("domain_standing calls exactly the retired statuses retired", async () => {
    for (const s of DOMAIN_STATUSES) {
      const id = await addDomain(s);
      const [st] = await q<{ standing: string }>("select standing from domain_standing where domain_id = $1", [id]);
      expect([s, st.standing === "retired"]).toEqual([s, (RETIRED_STATUSES as readonly string[]).includes(s)]);
    }
  });
});

describe("views over the lifecycle", () => {
  it("lifeOf maps every status to one Inventory tab", () => {
    const tab = (status: DomainStatus, extra: { coolingUntil?: Date | null; expired?: boolean; htPayment?: string | null } = {}) =>
      lifeOf({ status, htPayment: extra.htPayment ?? null, coolingUntil: extra.coolingUntil ?? null, expired: extra.expired ?? false });
    const plain: Record<DomainStatus, Life> = {
      in_storage: "free", provisioning: "setup", warming: "setup", active: "active", draining: "replaced", burned: "replaced", resting: "recovery",
    };
    for (const s of DOMAIN_STATUSES) {
      expect([s, tab(s)]).toEqual([s, plain[s]]);
      // Draining still sends through its grace period, so it stays under Replaced once expired.
      expect([s, tab(s, { expired: true })]).toEqual([s, s === "draining" ? "replaced" : "expired"]);
    }
    expect(tab("in_storage", { coolingUntil: new Date() })).toBe("cooling");
    expect(tab("draining", { htPayment: "Recovery pool" })).toBe("recovery");
    expect(tab("burned", { htPayment: "recovery" })).toBe("recovery");
    // Only the retired statuses move to recovery on a recovery-pool payment.
    expect(tab("active", { htPayment: "Recovery pool" })).toBe("active");
  });

  it("drainState says how long a replaced domain has left, from its status", () => {
    const now = Date.parse("2026-11-12T15:00:00Z");
    expect(graceEndsOn(16, now)?.toISOString().slice(0, 10)).toBe("2026-11-28");
    expect(drainState({ status: "draining", graceDaysLeft: 16 }, now)).toMatchObject({ label: "Draining · 16d left", tone: "warning" });
    expect(drainState({ status: "draining", graceDaysLeft: 16 }, now)?.title).toMatch(/ends 28 Nov/);
    expect(drainState({ status: "draining", graceDaysLeft: 0 }, now)).toMatchObject({ label: "Draining · ends today", tone: "danger" });
    expect(drainState({ status: "draining", graceDaysLeft: 16, expired: true, expiresAt: "2026-11-07" }, now)?.title).toMatch(/expired on 7 Nov/);
    expect(drainState({ status: "draining", graceDaysLeft: null })).toMatchObject({ label: "Draining" });
    expect(drainState({ status: "burned", inboxCount: 52 })).toMatchObject({ label: "Burned · 52 inboxes left", tone: "danger" });
    expect(drainState({ status: "burned", inboxCount: 0 })).toMatchObject({ label: "Burned", tone: "faint" });
    expect(drainState({ status: "active" })).toBeNull();
  });

  it("htOf reads both words for a cancelled Hypertide order the same way", () => {
    for (const s of HT_CANCELLED) expect(htOf({ htOrderStatus: s, htPayment: "Paid" })).toEqual({ label: "Cancelled", tone: "faint" });
    expect(htOf({ htOrderStatus: "Done", htPayment: "Paid" })).toEqual({ label: "Done", tone: "success" });
    expect(htOf({ htOrderStatus: "In progress", htPayment: "Unpaid" })).toEqual({ label: "Unpaid", tone: "warning" });
    expect(htOf({ htOrderStatus: null, htPayment: null })).toBeNull();
  });

  it("an empty nameserver list is default in the database but not in isDefaultNs", async () => {
    // On purpose: the database counts a domain with no nameservers as free,
    // while the nameserver cell shows None or Not checked before it asks isDefaultNs.
    const [r] = await q<{ ok: boolean }>("select ns_is_default('{}'::text[]) as ok");
    expect(r.ok).toBe(true);
    expect(isDefaultNs([])).toBe(false);
  });
});

describe("replacement steps", () => {
  it("finished and waiting cover the step statuses without overlap", () => {
    const finished = STEP_STATUSES.filter(isStepFinished);
    const waiting = STEP_STATUSES.filter(stepWaitsOnPerson);
    expect(finished).toEqual(["done", "skipped"]);
    expect(waiting).toEqual(["failed", "manual"]);
  });

  it("Replacements refreshes fast while a pair is moving, slowly while all wait on a person, and not once all are done", () => {
    const row = (steps: StepStatus[], completedAt: Date | null = null) =>
      ({ stepNameservers: steps[0], stepInboxes: steps[1], stepSmartlead: steps[2], stepCampaigns: steps[3], completedAt });
    const moving = row(["done", "running", "pending", "pending"]);
    const queued = row(["done", "done", "pending", "pending"]);
    const finishing = row(["done", "done", "done", "skipped"]);
    const manual = row(["done", "manual", "pending", "pending"]);
    const failed = row(["failed", "pending", "pending", "pending"]);
    // A later step waiting doesn't matter: only the current one does.
    const laterManual = row(["running", "manual", "pending", "pending"]);
    const done = row(["done", "done", "done", "done"], new Date());

    expect(replacementsRefreshSeconds([])).toBeNull();
    expect(replacementsRefreshSeconds([done])).toBeNull();
    for (const r of [moving, queued, finishing, laterManual]) expect(replacementsRefreshSeconds([done, manual, r])).toBe(10);
    expect(replacementsRefreshSeconds([done, manual, failed])).toBe(60);
    expect(currentStepStatus(manual)).toBe("manual");
    expect(currentStepStatus(finishing)).toBeNull();
  });

  it("the current step is the first one not finished", () => {
    const pair = (nameservers: string, inboxes: string, smartlead: string, campaigns: string) => ({ nameservers, inboxes, smartlead, campaigns });
    expect(currentStep(pair("pending", "pending", "pending", "pending"))).toBe("nameservers");
    expect(currentStep(pair("skipped", "manual", "pending", "pending"))).toBe("inboxes");
    expect(currentStep(pair("done", "done", "done", "running"))).toBe("campaigns");
    expect(currentStep(pair("done", "skipped", "done", "skipped"))).toBeNull();
  });
});
