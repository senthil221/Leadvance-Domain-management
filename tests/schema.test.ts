import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { loadMigrations } from "../scripts/migrations";

let db: PGlite;

async function addDomain(name: string, status = "in_storage", extra = "") {
  const r = await db.query<{ id: string }>(
    `insert into domains (name, status${extra ? ", " + extra.split("=")[0] : ""})
     values ($1, $2${extra ? ", " + extra.split("=")[1] : ""}) returning id`,
    [name, status],
  );
  return r.rows[0].id;
}

async function status(id: string) {
  return (await db.query<{ status: string }>("select status from domains where id = $1", [id])).rows[0].status;
}

beforeEach(async () => {
  db = await PGlite.create();
  // Production Postgres runs in UTC; match it so "today" is the same day the
  // rollup (which works in UTC by default) means, whatever the local clock says.
  await db.exec("set timezone = 'UTC'");
  for (const m of loadMigrations()) await db.exec(m.sql);
});

describe("transition_domain", () => {
  it("follows allowed moves and logs each one", async () => {
    const id = await addDomain("bluecrestis.com");
    for (const to of ["provisioning", "warming", "active", "draining", "burned"]) {
      await db.query("select transition_domain($1, $2::domain_status, 'test', 'tester')", [id, to]);
    }
    expect(await status(id)).toBe("burned");

    const history = await db.query<{ from_status: string | null; to_status: string }>(
      "select from_status, to_status from domain_status_history where domain_id = $1 order by id",
      [id],
    );
    expect(history.rows.map((h) => `${h.from_status}>${h.to_status}`)).toEqual([
      "null>in_storage",
      "in_storage>provisioning",
      "provisioning>warming",
      "warming>active",
      "active>draining",
      "draining>burned",
    ]);
  });

  it("stamps active_since, draining_since and burned_at", async () => {
    const id = await addDomain("fieldopsbase.com", "warming");
    await db.query("select transition_domain($1, 'active')", [id]);
    await db.query("select transition_domain($1, 'draining')", [id]);
    await db.query("select transition_domain($1, 'burned')", [id]);
    const d = (await db.query<Record<string, unknown>>("select * from domains where id = $1", [id])).rows[0];
    expect(d.active_since).not.toBeNull();
    expect(d.draining_since).not.toBeNull();
    expect(d.burned_at).not.toBeNull();
  });

  it("rejects a move that skips steps", async () => {
    const id = await addDomain("clearrelaypro.com");
    await expect(db.query("select transition_domain($1, 'active')", [id])).rejects.toThrow(/cannot move/);
    expect(await status(id)).toBe("in_storage");
  });

  it("allows a forced move only with a reason", async () => {
    const id = await addDomain("freshbaybase.com");
    await expect(db.query("select transition_domain($1, 'burned', null, 'me', null, true)", [id])).rejects.toThrow(
      /needs a reason/,
    );
    await db.query("select transition_domain($1, 'burned', 'blacklisted on Spamhaus', 'me', null, true)", [id]);
    expect(await status(id)).toBe("burned");
    const forced = await db.query<{ forced: boolean }>(
      "select forced from domain_status_history where domain_id = $1 order by id desc limit 1",
      [id],
    );
    expect(forced.rows[0].forced).toBe(true);
  });

  it("clears the client when a domain goes back to storage", async () => {
    const c = (await db.query<{ id: string }>("insert into clients (name) values ('Qualifi') returning id")).rows[0].id;
    const id = await addDomain("hillsteadon.com", "provisioning", `client_id=${`'${c}'`}`);
    await db.query("select transition_domain($1, 'in_storage', 'cancelled')", [id]);
    const d = (await db.query<{ client_id: string | null }>("select client_id from domains where id = $1", [id])).rows[0];
    expect(d.client_id).toBeNull();
  });
});

describe("reserve_storage_domains", () => {
  it("prefers the requested TLD, then the oldest purchase", async () => {
    await db.query("insert into domains (name, purchased_at) values ('a-new.info', '2026-09-01'), ('b-old.info', '2026-01-01'), ('c-old.com', '2025-01-01')");
    const picked = await db.query<{ name: string }>("select name from reserve_storage_domains(2, 'info')");
    expect(picked.rows.map((r) => r.name)).toEqual(["b-old.info", "a-new.info"]);
  });

  it("only returns domains that are in storage", async () => {
    await addDomain("active-one.com", "active");
    await addDomain("free-one.com");
    const picked = await db.query<{ name: string }>("select name from reserve_storage_domains(5)");
    expect(picked.rows.map((r) => r.name)).toEqual(["free-one.com"]);
  });
});

describe("evaluate_health_rules", () => {
  async function stats(domainId: string, sent: number, bounces: number, human: number) {
    await db.query(
      "insert into domain_daily_stats (domain_id, day, sent, bounces, human_replies, replies) values ($1, current_date, $2, $3, $4, $4)",
      [domainId, sent, bounces, human],
    );
  }
  const openAlerts = async () =>
    (
      await db.query<{ name: string; rule: string }>(
        `select d.name, r.name as rule from alerts a join domains d on d.id = a.domain_id
         join health_rules r on r.id = a.rule_id where a.status = 'open' order by d.name, r.name`,
      )
    ).rows.map((r) => `${r.name}: ${r.rule}`);

  it("flags high bounce and silent domains, but only once there is enough volume", async () => {
    const bouncy = await addDomain("bouncy.com", "active");
    const silent = await addDomain("silent.com", "active");
    const fine = await addDomain("fine.com", "active");
    const young = await addDomain("young.com", "active");
    await stats(bouncy, 200, 10, 2);
    await stats(silent, 600, 2, 0);
    await stats(fine, 600, 3, 4);
    await stats(young, 40, 5, 0); // 12.5% bounce but under 100 sent

    const r = await db.query<{ opened: number }>("select * from evaluate_health_rules()");
    expect(r.rows[0].opened).toBe(2);
    expect(await openAlerts()).toEqual(["bouncy.com: High bounce rate", "silent.com: No human replies"]);

    // Running again changes nothing.
    await db.query("select * from evaluate_health_rules()");
    expect(await openAlerts()).toHaveLength(2);
  });

  it("resolves alerts when a domain recovers or stops sending", async () => {
    const bouncy = await addDomain("bouncy.com", "active");
    await stats(bouncy, 200, 10, 2);
    await db.query("select * from evaluate_health_rules()");
    await db.query("update domain_daily_stats set bounces = 1 where domain_id = $1", [bouncy]);
    const r = await db.query<{ resolved: number }>("select * from evaluate_health_rules()");
    expect(r.rows[0].resolved).toBe(1);
    expect(await openAlerts()).toEqual([]);

    await db.query("update domain_daily_stats set bounces = 20 where domain_id = $1", [bouncy]);
    await db.query("select * from evaluate_health_rules()");
    await db.query("select transition_domain($1, 'draining')", [bouncy]);
    await db.query("select * from evaluate_health_rules()");
    expect(await openAlerts()).toEqual([]);
  });
});

describe("rollup_daily_stats", () => {
  async function event(domainName: string, kind: string, cls: string | null, at = "now()") {
    await db.query(
      `insert into email_events (dedupe_key, kind, occurred_at, domain_name, reply_class)
       values (gen_random_uuid()::text, $1::event_kind, ${at}, $2, $3::reply_class)`,
      [kind, domainName, cls],
    );
  }

  it("counts events by type and class, and links events that arrived before the domain existed", async () => {
    await event("late.com", "reply", "human");
    await event("late.com", "reply", "ooo");
    await event("late.com", "bounce", null);
    for (let i = 0; i < 5; i++) await event("late.com", "sent", null);
    const id = await addDomain("late.com", "active");

    await db.query("select rollup_daily_stats(current_date - 1)");
    const s = (await db.query<Record<string, number>>("select sent, replies, human_replies, ooo, bounces from domain_daily_stats where domain_id = $1", [id])).rows[0];
    expect(s).toEqual({ sent: 5, replies: 2, human_replies: 1, ooo: 1, bounces: 1 });
    const linked = await db.query("select 1 from email_events where domain_id is null");
    expect(linked.rows).toHaveLength(0);
  });

  it("takes the larger sent count of webhooks and Smartlead analytics", async () => {
    const id = await addDomain("both.com", "active");
    await event("both.com", "sent", null);
    await db.query("insert into smartlead_domain_daily (domain_name, day, sent) values ('both.com', current_date, 42)");
    await db.query("select rollup_daily_stats(current_date)");
    const s = (await db.query<{ sent: number }>("select sent from domain_daily_stats where domain_id = $1", [id])).rows[0];
    expect(s.sent).toBe(42);
  });

  it("records today's average warmup reputation and keeps older history untouched", async () => {
    const id = await addDomain("rep.com", "active");
    await db.query("insert into inboxes (domain_id, email, status, warmup_reputation) values ($1, 'a@rep.com', 'connected', 96), ($1, 'b@rep.com', 'connected', 100)", [id]);
    await db.query("insert into domain_daily_stats (domain_id, day, sent) values ($1, current_date - 10, 300)", [id]);
    await db.query("select rollup_daily_stats(current_date - 2)");
    const rows = (await db.query<{ day: string; sent: number; warmup_reputation: string | null }>(
      "select day::text, sent, warmup_reputation::text from domain_daily_stats where domain_id = $1 order by day", [id])).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].sent).toBe(300);
    expect(Number(rows[1].warmup_reputation)).toBe(98);
  });
});

describe("rollup_daily_stats keeps existing numbers", () => {
  it("does not zero a day's counts when only reputation is new, nor lower imported sent volume", async () => {
    const id = await addDomain("kept.com", "active");
    await db.query("insert into domain_daily_stats (domain_id, day, sent, replies, human_replies, bounces) values ($1, current_date, 250, 4, 2, 3)", [id]);
    await db.query("insert into inboxes (domain_id, email, status, warmup_reputation) values ($1, 'a@kept.com', 'connected', 97)", [id]);
    await db.query("select rollup_daily_stats(current_date)");
    let s = (await db.query<Record<string, unknown>>("select sent, replies, human_replies, bounces, warmup_reputation::text as rep from domain_daily_stats where domain_id = $1", [id])).rows[0];
    expect(s).toEqual({ sent: 250, replies: 4, human_replies: 2, bounces: 3, rep: "97.00" });

    // One webhook reply arrives for the same day: replies are recounted from events, sent stays.
    await db.query("insert into email_events (dedupe_key, kind, occurred_at, domain_name, reply_class) values ('k1', 'reply', now(), 'kept.com', 'human')");
    await db.query("select rollup_daily_stats(current_date)");
    s = (await db.query<Record<string, unknown>>("select sent, replies, human_replies from domain_daily_stats where domain_id = $1", [id])).rows[0];
    expect(s).toEqual({ sent: 250, replies: 1, human_replies: 1 });
  });
});

describe("assign_clients_from_campaigns", () => {
  it("matches clients named in campaign names (longest wins) and passes them to sending domains", async () => {
    const [kap, lead, leadRec] = (
      await db.query<{ id: string }>("insert into clients (name) values ('Kapable'), ('Lead'), ('Leadvance') returning id")
    ).rows.map((r) => r.id);
    await db.query(`insert into campaigns (id, name) values
      (1, 'Kapable TM 19-10-26'), (2, 'Leadvance Recruitment 13-10-26'), (3, 'Manufapp Info Request')`);
    const dom = await addDomain("farnholt.com", "active");
    const stored = await addDomain("spare.com");
    const inbox = (await db.query<{ id: string }>("insert into inboxes (domain_id, email) values ($1, 'a@farnholt.com') returning id", [dom])).rows[0].id;
    await db.query("insert into campaign_inboxes (campaign_id, inbox_id) values (2, $1)", [inbox]);

    const r = (await db.query<{ campaigns: number; domains: number }>("select * from assign_clients_from_campaigns()")).rows[0];
    expect(r).toEqual({ campaigns: 2, domains: 1 });
    const camps = (await db.query<{ id: number; client_id: string | null }>("select id, client_id from campaigns order by id")).rows;
    expect(camps.map((c) => c.client_id)).toEqual([kap, leadRec, null]);
    expect((await db.query<{ client_id: string }>("select client_id from domains where id = $1", [dom])).rows[0].client_id).toBe(leadRec);
    expect((await db.query<{ client_id: string | null }>("select client_id from domains where id = $1", [stored])).rows[0].client_id).toBeNull();
    expect(lead).toBeTruthy();
  });
});

describe("retire_drained_domains", () => {
  it("retires domains once the drain period (18 days, Hypertide's grace) is over, and only those", async () => {
    const old = await addDomain("old.com", "active");
    const fresh = await addDomain("fresh.com", "active");
    await db.query("select transition_domain($1, 'draining')", [old]);
    await db.query("select transition_domain($1, 'draining')", [fresh]);
    await db.query("update domains set draining_since = now() - interval '19 days' where id = $1", [old]);
    const r = await db.query<{ n: number }>("select retire_drained_domains() as n");
    expect(r.rows[0].n).toBe(1);
    expect(await status(old)).toBe("burned");
    expect(await status(fresh)).toBe("draining");
  });
});

describe("start_replacement", () => {
  it("pairs domains, moves the new one under the old client and records lineage", async () => {
    const c = (await db.query<{ id: string }>("insert into clients (name) values ('Westshore') returning id")).rows[0].id;
    const oldId = await addDomain("foundationopslab.com", "active", `client_id=${`'${c}'`}`);
    const newId = await addDomain("foundationopshub.com");

    const batch = (
      await db.query<{ id: string }>(
        "select start_replacement(array[$1]::uuid[], array[$2]::uuid[], 'high_bounce', 'bounce 4%', 'me') as id",
        [oldId, newId],
      )
    ).rows[0].id;

    expect(await status(newId)).toBe("provisioning");
    const item = (
      await db.query<{ client_id: string; old_domain_id: string; new_domain_id: string }>(
        "select client_id, old_domain_id, new_domain_id from replacement_items where batch_id = $1",
        [batch],
      )
    ).rows[0];
    expect(item).toEqual({ client_id: c, old_domain_id: oldId, new_domain_id: newId });
    const newClient = (await db.query<{ client_id: string }>("select client_id from domains where id = $1", [newId])).rows[0];
    expect(newClient.client_id).toBe(c);
  });

  it("refuses a domain that is not in storage, and changes nothing", async () => {
    const oldId = await addDomain("signalwaylab.com", "active");
    const busy = await addDomain("taken.com", "active");
    await expect(
      db.query("select start_replacement(array[$1]::uuid[], array[$2]::uuid[], 'other', null, 'me')", [oldId, busy]),
    ).rejects.toThrow(/no longer in storage/);
    expect((await db.query("select * from replacement_batches")).rows).toHaveLength(0);
  });

  it("refuses to replace the same domain twice at once", async () => {
    const oldId = await addDomain("northhavenly.com", "active");
    const n1 = await addDomain("n1.com");
    const n2 = await addDomain("n2.com");
    await db.query("select start_replacement(array[$1]::uuid[], array[$2]::uuid[], 'other', null, 'me')", [oldId, n1]);
    await expect(
      db.query("select start_replacement(array[$1]::uuid[], array[$2]::uuid[], 'other', null, 'me')", [oldId, n2]),
    ).rejects.toThrow(/already being replaced/);
  });
});
