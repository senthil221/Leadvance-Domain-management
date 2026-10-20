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
