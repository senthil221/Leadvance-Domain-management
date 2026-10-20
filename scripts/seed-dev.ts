// Fills a development database with realistic demo data: clients, vendors,
// ~420 domains across every state, inboxes, 30 days of stats, replies and a
// few replacements. Refuses to run against a database that already has domains.
// Usage: npm run db:seed
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const sql = postgres(url, { max: 1, onnotice: () => {} });

// Small deterministic RNG so every seed looks the same.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const between = (a: number, b: number) => Math.floor(a + rand() * (b - a + 1));

const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from domains`;
if (n > 0) {
  console.log(`database already has ${n} domains; not seeding`);
  await sql.end();
  process.exit(0);
}

const PREFIX = ["blue", "river", "clear", "field", "fresh", "anchor", "hill", "aster", "bright", "silver", "noble",
  "cedar", "true", "north", "ridge", "frame", "signal", "granite", "alpine", "brook", "crest", "launch", "bridge",
  "foundation", "prime", "bold", "pro", "summit", "harbor", "maple", "stone", "oak", "pine", "lumen", "vertex"];
const MIDDLE = ["crest", "bend", "relay", "ops", "house", "bay", "flow", "stead", "signal", "point", "wave", "haven",
  "lane", "birch", "way", "path", "core", "vault", "works", "line", "gate", "field"];
const SUFFIX = ["network", "pro", "base", "lab", "hub", "systems", "co", "group", "central", "is", "on", "ly", "io", "hq"];
const TLDS = ["com", "com", "com", "com", "info", "net", "co"];

const used = new Set<string>();
function domainName() {
  for (;;) {
    const name = `${pick(PREFIX)}${pick(MIDDLE)}${pick(SUFFIX)}.${pick(TLDS)}`;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
}

const SENDERS = {
  Qualifi: ["Amelia Wren", "Sophia Lark", "Michael Reynolds", "Isabella Cove"],
  Westshore: ["Steve Kloosterman"],
  Salesdraft: ["Shawn Hooper"],
  B2bdrive: ["Daniel Price", "Nina Shah"],
  BeeBee: ["Laura Benz"],
} as const;
type ClientName = keyof typeof SENDERS;
const CLIENT_WEIGHTS: ClientName[] = ["Qualifi", "Qualifi", "Qualifi", "Qualifi", "Qualifi", "Westshore", "Westshore", "Salesdraft", "B2bdrive", "BeeBee"];
const HUES: Record<ClientName, number> = { Qualifi: 255, Westshore: 150, Salesdraft: 30, B2bdrive: 300, BeeBee: 190 };

await sql.begin(async (tx) => {
  await tx`select set_config('app.actor', 'seed', true)`;

  const vendors = await tx<{ id: string; name: string }[]>`
    insert into vendors (name, kind, api_supported) values
      ('Porkbun', 'registrar', true), ('Unstoppable Domains', 'registrar', true), ('Hypertide', 'inbox_provider', true)
    returning id, name`;
  const vendor = (name: string) => vendors.find((v) => v.name === name)!.id;

  const clients = await tx<{ id: string; name: ClientName }[]>`
    insert into clients ${tx(Object.entries(HUES).map(([name, hue]) => ({ name, hue })))} returning id, name`;
  const clientId = (name: ClientName) => clients.find((c) => c.name === name)!.id;

  const plan: [string, number][] = [
    ["active", 262], ["warming", 24], ["provisioning", 6], ["draining", 22], ["burned", 48], ["resting", 6], ["in_storage", 54],
  ];

  type D = { id: string; name: string; status: string; client: ClientName | null; health: "good" | "bouncy" | "silent" | "lowrep" };
  const domains: D[] = [];
  for (const [status, count] of plan) {
    for (let i = 0; i < count; i++) {
      const client = status === "in_storage" || status === "resting" ? null : pick(CLIENT_WEIGHTS);
      const purchased = new Date(Date.now() - between(20, 350) * 86_400_000);
      const activeDays = between(9, 160);
      const health: D["health"] =
        status !== "active" ? "good" : i % 23 === 0 ? "bouncy" : i % 31 === 0 ? "silent" : i % 41 === 0 ? "lowrep" : "good";
      const [row] = await tx<{ id: string }[]>`
        insert into domains (name, status, client_id, registrar_id, inbox_provider_id, purchased_at, expires_at, cost_cents,
          nameservers, active_since, draining_since, burned_at)
        values (${domainName()}, 'in_storage', ${client ? clientId(client) : null},
          ${vendor(rand() < 0.85 ? "Porkbun" : "Unstoppable Domains")},
          ${status === "in_storage" ? null : vendor("Hypertide")},
          ${purchased}, ${new Date(purchased.getTime() + 365 * 86_400_000)}, ${pick([1015, 1048, 1199, 899])},
          ${status === "in_storage" ? ["curitiba.ns.porkbun.com", "fortaleza.ns.porkbun.com"] : ["ns1.hypertide.io", "ns2.hypertide.io"]},
          ${["active", "draining", "burned"].includes(status) ? new Date(Date.now() - activeDays * 86_400_000) : null},
          ${status === "draining" ? new Date(Date.now() - between(1, 6) * 86_400_000) : null},
          ${status === "burned" ? new Date(Date.now() - between(8, 90) * 86_400_000) : null})
        returning id`;
      domains.push({ id: row.id, name: "", status, client, health });
    }
  }
  const names = await tx<{ id: string; name: string }[]>`select id, name from domains`;
  for (const d of domains) d.name = names.find((x) => x.id === d.id)!.name;

  // Backdated history so timelines look lived-in.
  for (const d of domains.filter((x) => x.status !== "in_storage")) {
    const path = { provisioning: ["provisioning"], warming: ["provisioning", "warming"], active: ["provisioning", "warming", "active"],
      draining: ["provisioning", "warming", "active", "draining"], burned: ["provisioning", "warming", "active", "draining", "burned"],
      resting: ["provisioning", "warming", "active", "draining", "burned", "resting"] }[d.status]!;
    let prev = "in_storage";
    let daysAgo = between(30, 200);
    for (const to of path) {
      await tx`insert into domain_status_history (domain_id, from_status, to_status, reason, actor, at)
        values (${d.id}, ${prev}::domain_status, ${to}::domain_status,
          ${to === "draining" ? pick(["high bounce rate", "no human replies", "low warmup reputation"]) : null},
          ${to === "draining" || to === "provisioning" ? "ops@b2bdrive.net" : "system"},
          now() - ${`${daysAgo} days`}::interval)`;
      prev = to;
      daysAgo = Math.max(0, daysAgo - between(2, 30));
    }
    await tx`update domains set status = ${d.status}::domain_status where id = ${d.id}`;
  }
  await tx`update domain_status_history h set at = d.purchased_at - interval '1 hour'
    from domains d where d.id = h.domain_id and h.from_status is null`;

  // Inboxes: 3 per domain that has been set up.
  const inboxRows: Record<string, unknown>[] = [];
  let accountId = 4_100_000;
  for (const d of domains.filter((x) => x.client)) {
    const people = SENDERS[d.client!];
    for (let i = 0; i < 3; i++) {
      const person = people[i % people.length];
      const [first, last] = person.toLowerCase().split(" ");
      const local = [`${first}.${last}`, `${first}`, `${first[0]}${last}`][i];
      const live = !["provisioning"].includes(d.status);
      inboxRows.push({
        domain_id: d.id,
        email: `${local}@${d.name}`,
        sender_name: person,
        smartlead_account_id: live ? accountId++ : null,
        warmup_enabled: live && d.status !== "burned",
        warmup_per_day: live ? 30 : null,
        warmup_rampup: live ? 3 : null,
        daily_limit: d.status === "active" ? 15 : d.status === "warming" ? 0 : live ? 0 : null,
        warmup_reputation: live ? (d.health === "lowrep" ? between(78, 88) : between(96, 100)) : null,
        status: d.status === "provisioning" ? "pending" : d.status === "burned" || d.status === "resting" ? "removed" : "connected",
        last_synced_at: live ? new Date(Date.now() - between(5, 90) * 60_000) : null,
      });
    }
  }
  for (let i = 0; i < inboxRows.length; i += 500) await tx`insert into inboxes ${tx(inboxRows.slice(i, i + 500))}`;

  // 30 days of stats for domains that send.
  const statRows: Record<string, unknown>[] = [];
  for (const d of domains.filter((x) => ["active", "warming", "draining"].includes(x.status))) {
    for (let day = 0; day < 30; day++) {
      const sending = d.status !== "warming" && !(d.status === "draining" && day < 3);
      const sent = sending ? between(28, 46) : 0;
      const bounceP = d.health === "bouncy" ? 0.06 : 0.012;
      const humanP = d.health === "silent" ? 0 : 0.012;
      let bounces = 0, human = 0, ooo = 0, auto = 0, negative = 0;
      for (let k = 0; k < sent; k++) {
        const x = rand();
        if (x < bounceP) bounces++;
        else if (x < bounceP + humanP) human++;
        else if (x < bounceP + humanP + 0.01) ooo++;
        else if (x < bounceP + humanP + 0.014) auto++;
        else if (x < bounceP + humanP + 0.018) negative++;
      }
      statRows.push({
        domain_id: d.id,
        day: new Date(Date.now() - day * 86_400_000).toISOString().slice(0, 10),
        sent, bounces, human_replies: human, ooo, auto_replies: auto, negative,
        replies: human + ooo + auto + negative,
        warmup_reputation: d.health === "lowrep" ? between(78, 88) : between(95, 100),
      });
    }
  }
  for (let i = 0; i < statRows.length; i += 1000) await tx`insert into domain_daily_stats ${tx(statRows.slice(i, i + 1000))}`;

  // A few replies, in the shapes you see in Smartlead.
  const samples: [string, string][] = [
    ["human", "Ms. Lark, what's your phone number so I can call to discuss. John N"],
    ["negative", "Please stop emailing me"],
    ["negative", "No Thanks - I am set."],
    ["negative", "Unsubscribe"],
    ["ooo", "Hello! I am out of the office today through Friday, returning Monday Oct 19th."],
    ["ooo", "Please note I am out of the office until Tuesday 10/20 and my responses will be delayed."],
    ["negative", "Please remove this email address, we're not a fit."],
    ["negative", "STOP ---"],
    ["human", "Let me know more about what sort of funding you offer"],
    ["human", "What do you need to qualify? TT Best regards"],
    ["auto", "The message you sent requires that you verify that you are a real live human being."],
    ["human", "Thanks Amelia - can you send over pricing and a couple of case studies?"],
  ];
  const actives = domains.filter((x) => x.status === "active");
  const eventRows: Record<string, unknown>[] = [];
  for (let i = 0; i < 140; i++) {
    const d = pick(actives);
    const [cls, text] = pick(samples);
    const sender = SENDERS[d.client!][0].toLowerCase().replace(" ", ".");
    eventRows.push({
      dedupe_key: `seed-reply-${i}`,
      kind: "reply",
      occurred_at: new Date(Date.now() - between(1, 60 * 24 * 7) * 60_000),
      domain_name: d.name,
      domain_id: d.id,
      inbox_email: `${sender}@${d.name}`,
      campaign_id: 2_400_000 + between(1, 12),
      campaign_name: `${between(1, 5)}-${d.client}-${pick(["Professional training 1-5 TM", "Staffing 1-10 TM", "Owners 1-5 (QE)", "Machinery Care Alt 4-10"])}`,
      client_id: clients.find((c) => c.name === d.client)!.id,
      lead_email: `${pick(["niles", "cindy", "dion", "trent", "michelle", "gemma", "sean", "laura", "chris", "trung"])}@${pick(["globaltelematics.com", "duperoneducation.com", "forthrightstaffing.com", "lautenaudio.com", "westaffmt.com", "hudsoncoopersearch.com"])}`,
      sequence_number: between(1, 3),
      reply_class: cls,
      preview: text,
      recipient_esp: pick(["Microsoft 365", "Google Workspace", "Other", "Unknown"]),
    });
  }
  await tx`insert into email_events ${tx(eventRows)}`;

  // Two finished replacements and one in progress, for lineage.
  const draining = domains.filter((x) => x.status === "draining");
  const recent = domains.filter((x) => x.status === "active").slice(-6);
  const batches: { reason: string; note: string; days: number; pairs: [D, D][]; running: boolean }[] = [
    { reason: "high_bounce", note: "Bounce over 4% on the Qualifi staffing campaign", days: 5, pairs: [[draining[0], recent[0]], [draining[1], recent[1]], [draining[2], recent[2]]], running: false },
    { reason: "low_replies", note: "Zero human replies in 2 weeks", days: 2, pairs: [[draining[3], recent[3]], [draining[4], recent[4]]], running: false },
  ];
  for (const b of batches) {
    const [batch] = await tx<{ id: string }[]>`
      insert into replacement_batches (reason, note, actor, status, created_at, completed_at)
      values (${b.reason}::replacement_reason, ${b.note}, 'ops@b2bdrive.net', 'completed',
        now() - ${`${b.days} days`}::interval, now() - ${`${b.days - 1} days`}::interval)
      returning id`;
    for (const [oldD, newD] of b.pairs) {
      await tx`insert into replacement_items (batch_id, client_id, old_domain_id, new_domain_id, step_nameservers, step_inboxes,
          step_smartlead, step_campaigns, created_at, completed_at)
        values (${batch.id}, (select client_id from domains where id = ${oldD.id}), ${oldD.id}, ${newD.id},
          'done', 'done', 'done', 'done', now() - ${`${b.days} days`}::interval, now() - ${`${b.days - 1} days`}::interval)`;
      await tx`update domains set client_id = (select client_id from domains where id = ${oldD.id}) where id = ${newD.id}`;
    }
  }
  const provisioning = domains.filter((x) => x.status === "provisioning").slice(0, 3);
  const victims = domains.filter((x) => x.status === "active" && x.health === "bouncy").slice(0, 3);
  const [running] = await tx<{ id: string }[]>`
    insert into replacement_batches (reason, note, actor, status, created_at)
    values ('high_bounce', null, 'ops@b2bdrive.net', 'running', now() - interval '2 hours') returning id`;
  const steps = [["done", "running", "pending", "pending"], ["done", "done", "running", "pending"], ["failed", "pending", "pending", "pending"]];
  for (let i = 0; i < Math.min(provisioning.length, victims.length); i++) {
    const [ns, ib, sl, cp] = steps[i];
    await tx`insert into replacement_items (batch_id, client_id, old_domain_id, new_domain_id, step_nameservers, step_inboxes,
        step_smartlead, step_campaigns, last_error)
      values (${running.id}, (select client_id from domains where id = ${victims[i].id}), ${victims[i].id}, ${provisioning[i].id},
        ${ns}::step_status, ${ib}::step_status, ${sl}::step_status, ${cp}::step_status,
        ${ns === "failed" ? "Porkbun: Invalid API key or domain not in this account (HTTP 400)" : null})`;
    await tx`update domains set client_id = (select client_id from domains where id = ${victims[i].id}) where id = ${provisioning[i].id}`;
  }

  await tx`select * from evaluate_health_rules()`;
});

const [summary] = await sql<{ domains: number; inboxes: number; alerts: number }[]>`
  select (select count(*)::int from domains) as domains, (select count(*)::int from inboxes) as inboxes,
    (select count(*)::int from alerts where status = 'open') as alerts`;
console.log(`seeded ${summary.domains} domains, ${summary.inboxes} inboxes, ${summary.alerts} open alerts`);
await sql.end();
