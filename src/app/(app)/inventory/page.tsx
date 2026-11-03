import { DomainLink } from "@/components/domains/DomainLink";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { CalendarClock, Plus, TriangleAlert } from "lucide-react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { AddDomainsDialog } from "@/components/inventory/AddDomainsDialog";
import { InventoryView } from "@/components/inventory/InventoryView";
import { lifeOf } from "@/lib/lifecycle";
import { Badge, ClientCell, Dot, Empty, PageHead, Skeleton, StatusDot, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { ago, int, shortDate } from "@/lib/format";
import { getHypertideSummary, getInventory, listClients, listDomains, listVendors, type Breakdown } from "@/lib/queries";

export const metadata: Metadata = { title: "Inventory" };

export default function InventoryPage() {
  return (
    <>
      <PageHead title="Domains" sub="Every domain you own: free, setting up, active or replaced, where it's registered and what renews next">
        <Suspense fallback={<button type="button" className="btn btn-primary" disabled><Plus size={14} /> Add domains</button>}>
          <AddButton />
        </Suspense>
      </PageHead>
      <div className="page-body">
        <Suspense fallback={<><div className="stats">{[0, 1, 2, 3].map((i) => <div key={i} className="stat"><Skeleton w={90} h={12} /><Skeleton w={70} h={26} /></div>)}</div><TableSkeleton rows={6} /></>}>
          <InventoryContent />
        </Suspense>
      </div>
    </>
  );
}

async function AddButton() {
  await getCurrentUser();
  const vendors = await listVendors();
  return <AddDomainsDialog registrars={vendors.filter((v) => v.kind === "registrar")} />;
}

async function InventoryContent() {
  await getCurrentUser();
  const [{ accounts, tlds, renewals, totals }, domains, clients, ht] = await Promise.all([getInventory(), listDomains(), listClients(), getHypertideSummary()]);
  const money = (c: number) => `${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const life = { active: 0, setup: 0, free: 0, cooling: 0, replaced: 0, recovery: 0, expired: 0 };
  for (const d of domains) life[lifeOf(d)]++;
  const activeCapacity = domains.filter((d) => lifeOf(d) === "active").reduce((a, d) => a + d.capacity, 0);
  const activeInboxes = domains.filter((d) => lifeOf(d) === "active").reduce((a, d) => a + d.inboxCount, 0);
  const weekly = ht.replacedLast28 / 4;
  const weeksLeft = weekly > 0 ? life.free / weekly : null;
  const htConnected = Boolean(process.env.HYPERTIDE_API_KEY);

  return (
    <>
      <section className="stats is-5" aria-label="Inventory numbers">
        <Link href="/inventory" className="stat">
          <span className="stat-label"><Dot tone="success" />Active</span>
          <span className="stat-value">{int(life.active)}</span>
          <span className="stat-foot">{int(activeInboxes)} inboxes · {int(activeCapacity)} emails / day{life.setup ? ` · ${life.setup} more setting up` : ""}</span>
        </Link>
        <Link href="/inventory?view=free" className="stat">
          <span className="stat-label"><Dot tone="faint" />Free</span>
          <span className="stat-value">{int(life.free)}</span>
          <span className="stat-foot">
            {weeksLeft == null ? "no replacements in 4 weeks" : `≈ ${Math.floor(weeksLeft)} weeks at ${weekly.toFixed(1)} a week`}
            {life.cooling ? ` · ${int(life.cooling)} more cooling down` : ""}
          </span>
        </Link>
        <Link href="/inventory?view=replaced" className="stat">
          <span className="stat-label"><Dot tone="warning" />Replaced</span>
          <span className="stat-value">{int(life.replaced)}</span>
          <span className="stat-foot">{int(ht.replacedLast28)} in the last 4 weeks</span>
        </Link>
        <Link href="/inventory?view=recovery" className="stat">
          <span className="stat-label"><Dot tone="violet" />Recovery</span>
          <span className="stat-value">{int(life.recovery)}</span>
          <span className="stat-foot">{ht.recovery ? `${ht.recovery} in Hypertide's recovery pool` : "resting, not in use"}</span>
        </Link>
        <div className="stat">
          <span className="stat-label">Owned · yearly cost</span>
          <span className="stat-value">{int(totals.owned)}</span>
          <span className="stat-foot">
            {totals.annualCents ? `${money(totals.annualCents)} a year, excluding replaced` : `across ${accounts.length} registrar account${accounts.length === 1 ? "" : "s"}`}
            {totals.expired ? <> · <Link href="/inventory?view=expired#domains" className="hover:underline">{int(totals.expired)} expired</Link></> : null}
          </span>
        </div>
      </section>

      {htConnected ? (
        <section className="card" aria-label="Hypertide">
          <div className="card-head flex-wrap gap-y-1 py-2.5">
            <span className="card-title">Hypertide</span>
            <span className="card-sub">{ht.lastSync ? `synced ${ago(ht.lastSync)}` : "not synced yet"}</span>
            <span className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-1 text-[12.5px] text-muted">
              <span title="Only Done orders are billed"><b className="num text-ink">{int(ht.done)}</b> billed (Done)</span>
              <span><b className="num text-ink">{int(ht.inSetup)}</b> in setup</span>
              <span title="Shown as Cancelled in Hypertide (NPC in its API): not billed"><b className="num text-ink">{int(ht.cancelled)}</b> cancelled</span>
              {ht.recovery ? <span><b className="num text-ink">{int(ht.recovery)}</b> in recovery pool</span> : null}
              <span className={ht.unpaid ? "text-warning-ink" : undefined}><b className="num">{int(ht.unpaid)}</b> unpaid</span>
              {ht.sendingWithout ? <span title="Active or warming domains with no Hypertide order: other inbox providers, or orders under another account"><b className="num text-ink">{int(ht.sendingWithout)}</b> sending without an order</span> : null}
            </span>
          </div>
        </section>
      ) : null}

      {ht.retiredBilled.length > 0 ? (
        <div className="callout tone-warning">
          <TriangleAlert size={15} strokeWidth={1.75} />
          <span>
            {ht.retiredBilled.length} retired domain{ht.retiredBilled.length === 1 ? " has" : "s have"} a Done order on Hypertide, so {ht.retiredBilled.length === 1 ? "it is" : "they are"} still billed:{" "}
            {ht.retiredBilled.slice(0, 6).map((d) => d.name).join(", ")}{ht.retiredBilled.length > 6 ? ` and ${ht.retiredBilled.length - 6} more` : ""}. Cancel the subscriptions there.
          </span>
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-2">
        <BreakdownCard id="accounts" title="By registrar account" rows={accounts} cooling={totals.reuseAfterDays}
          hint="Every login in Settings → Connections. No registrar account: domains Hypertide or Smartlead know about that no connected account holds." />
        <BreakdownCard id="tlds" title="By TLD" rows={tlds} cooling={totals.reuseAfterDays} />
      </div>

      {domains.some((d) => d.nsRequestStatus === "pending" || d.nsRequestStatus === "running") ? <AutoRefresh seconds={5} /> : null}
      <div id="domains" style={{ scrollMarginTop: 12 }}>
        <InventoryView domains={domains} clients={clients} />
      </div>

      {totals.retiredRenewing > 0 ? (
        <div className="callout tone-warning">
          <TriangleAlert size={15} strokeWidth={1.75} />
          <span>{totals.retiredRenewing} retired domain{totals.retiredRenewing === 1 ? " renews" : "s renew"} in the next 60 days. Turn off auto-renew at the registrar unless you plan to rest and reuse them.</span>
        </div>
      ) : null}

      <section className="card" aria-labelledby="renewals-title">
        <div className="card-head">
          <h2 id="renewals-title" className="card-title">Upcoming renewals</h2>
          <span className="card-sub">next 60 days</span>
        </div>
        {renewals.length === 0 ? (
          <Empty icon={CalendarClock} title="Nothing renews soon" />
        ) : (
          <div className="table-scroll" style={{ maxHeight: 460 }}>
            <table className="data-table">
              <thead><tr><th>Domain</th><th>Status</th><th>Client</th><th>Registrar</th><th className="is-num">Renews</th><th className="is-num">Cost</th></tr></thead>
              <tbody>
                {renewals.map((r) => (
                  <tr key={r.id}>
                    <td><DomainLink id={r.id} className="strong hover:underline">{r.name}</DomainLink></td>
                    <td><StatusDot status={r.status} /></td>
                    <td><ClientCell name={r.clientName} hue={r.clientHue} /></td>
                    <td>{r.registrar ?? <span className="zero">—</span>}</td>
                    <td className="is-num">{shortDate(r.expiresAt)}{r.status === "burned" || r.status === "resting" ? <> <Badge tone="warning">let lapse?</Badge></> : null}</td>
                    <td className="is-num">{r.costCents != null ? `$${(r.costCents / 100).toFixed(2)}` : <span className="zero">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

// One row per registrar account or TLD: what is sending, free to use, cooling
// down after recent use, replaced, and renewing within 30 days.
function BreakdownCard({ id, title, rows, cooling, hint }: { id: string; title: string; rows: Breakdown[]; cooling: number; hint?: string }) {
  const n = (v: number) => (v ? int(v) : <span className="zero">0</span>);
  const sum = (k: keyof Breakdown) => rows.reduce((a, r) => a + (r[k] as number), 0);
  const showCost = rows.some((r) => r.annualCents > 0);
  const tld = id === "tlds";
  // The list below, filtered to this row and, for a number, its lifecycle tab.
  const href = (r: Breakdown, view = "all") => {
    const p = new URLSearchParams({ view });
    if (tld) p.set("tld", r.key);
    else p.set("registrar", r.sub ? `a:${r.label}|${r.sub}` : r.label === "No registrar account" ? "v:Unknown" : `v:${r.label}`);
    return `/inventory?${p}#domains`;
  };
  const cell = (r: Breakdown, v: number, view: string) =>
    v ? <Link href={href(r, view)} className="hover:underline">{int(v)}</Link> : <span className="zero">0</span>;
  return (
    <section className="card" aria-labelledby={`${id}-title`}>
      <div className="card-head">
        <h2 id={`${id}-title`} className="card-title">{title}</h2>
        <span className="card-sub" title={hint}>{rows.length} {tld ? "TLDs" : "accounts"} · click a row or number to list those domains</span>
      </div>
      <div className="table-scroll" style={{ maxHeight: 300 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>{tld ? "TLD" : "Account"}</th>
              <th className="is-num">Owned</th>
              <th className="is-num">Active</th>
              <th className="is-num" title="Being set up or warming up">Setup</th>
              <th className="is-num" title="In storage and rested: ready to use">Free</th>
              <th className="is-num" title={`In storage but used in the last ${cooling} days (Hypertide order, sends or replacement): not offered as a replacement yet`}>Cooling</th>
              <th className="is-num" title="Draining, burned or resting">Replaced</th>
              <th className="is-num" title="Past their expiry date. Not counted anywhere else in this table">Expired</th>
              <th className="is-num" title="Renews in the next 30 days (replaced domains not counted)">Renew 30d</th>
              {showCost ? <th className="is-num">Per year</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="strong" title={r.usedBefore ? `${int(r.usedBefore)} of the domains in storage were used before` : undefined}>
                  <Link href={href(r)} className="hover:underline">
                    {r.label}{r.sub ? <span className="text-muted" style={{ fontWeight: 400 }}> · {r.sub}</span> : null}
                  </Link>
                </td>
                <td className="is-num">{cell(r, r.total, "all")}</td>
                <td className="is-num">{cell(r, r.active, "active")}</td>
                <td className="is-num">{n(r.setup)}</td>
                <td className="is-num">{cell(r, r.free, "free")}</td>
                <td className="is-num">{cell(r, r.cooling, "cooling")}</td>
                <td className="is-num">{cell(r, r.replaced, "replaced")}</td>
                <td className="is-num">{cell(r, r.expired, "expired")}</td>
                <td className="is-num">{r.expiring30 ? <span className="text-warning-ink">{int(r.expiring30)}</span> : <span className="zero">0</span>}</td>
                {showCost ? <td className="is-num">{r.annualCents ? `$${int(Math.round(r.annualCents / 100))}` : <span className="zero">—</span>}</td> : null}
              </tr>
            ))}
          </tbody>
          {rows.length > 1 ? (
            <tfoot>
              <tr>
                <td className="strong">Total</td>
                <td className="is-num strong">{int(sum("total"))}</td>
                <td className="is-num">{int(sum("active"))}</td>
                <td className="is-num">{int(sum("setup"))}</td>
                <td className="is-num">{int(sum("free"))}</td>
                <td className="is-num">{int(sum("cooling"))}</td>
                <td className="is-num">{int(sum("replaced"))}</td>
                <td className="is-num">{int(sum("expired"))}</td>
                <td className="is-num">{int(sum("expiring30"))}</td>
                {showCost ? <td className="is-num">${int(Math.round(sum("annualCents") / 100))}</td> : null}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </section>
  );
}
