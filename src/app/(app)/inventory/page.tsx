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
import { getHypertideSummary, getInventory, listClients, listDomains, listVendors } from "@/lib/queries";

export const metadata: Metadata = { title: "Inventory" };

export default function InventoryPage() {
  return (
    <>
      <PageHead title="Inventory" sub="Every domain you own: free, setting up, active or replaced, where it's registered and what renews next">
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
  const [{ registrars, renewals, totals }, domains, clients, ht] = await Promise.all([getInventory(), listDomains(), listClients(), getHypertideSummary()]);
  const money = (c: number) => `${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const life = { free: 0, setup: 0, active: 0, replaced: 0, retired: 0 };
  for (const d of domains) life[lifeOf(d)]++;
  const activeCapacity = domains.filter((d) => d.status === "active").reduce((a, d) => a + d.capacity, 0);
  const activeInboxes = domains.filter((d) => d.status === "active").reduce((a, d) => a + d.inboxCount, 0);
  const weekly = ht.replacedLast28 / 4;
  const weeksLeft = weekly > 0 ? life.free / weekly : null;
  const htConnected = Boolean(process.env.HYPERTIDE_API_KEY);

  return (
    <>
      <section className="stats is-5" aria-label="Inventory numbers">
        <Link href="/inventory?view=free" className="stat">
          <span className="stat-label"><Dot tone="faint" />Free</span>
          <span className="stat-value">{int(life.free)}</span>
          <span className="stat-foot">{weeksLeft == null ? "no replacements in 4 weeks" : `≈ ${Math.floor(weeksLeft)} weeks at ${weekly.toFixed(1)} a week`}</span>
        </Link>
        <Link href="/inventory?view=setup" className="stat">
          <span className="stat-label"><Dot tone="info" />Setting up</span>
          <span className="stat-value">{int(life.setup)}</span>
          <span className="stat-foot">{ht.inSetup ? `${ht.inSetup} paid on Hypertide, in setup` : "provisioning and warming"}</span>
        </Link>
        <Link href="/inventory?view=active" className="stat">
          <span className="stat-label"><Dot tone="success" />Active</span>
          <span className="stat-value">{int(life.active)}</span>
          <span className="stat-foot">{int(activeInboxes)} inboxes · {int(activeCapacity)} emails / day</span>
        </Link>
        <Link href="/inventory?view=replaced" className="stat">
          <span className="stat-label"><Dot tone="warning" />Replaced</span>
          <span className="stat-value">{int(life.replaced)}</span>
          <span className="stat-foot">{int(ht.replacedLast28)} in the last 4 weeks · {int(life.retired)} other retired</span>
        </Link>
        <div className="stat">
          <span className="stat-label">Owned · yearly cost</span>
          <span className="stat-value">{int(totals.owned)}</span>
          <span className="stat-foot">{totals.annualCents ? `${money(totals.annualCents)} a year, excluding retired` : `across ${registrars.length} registrar${registrars.length === 1 ? "" : "s"}`}</span>
        </div>
      </section>

      {htConnected ? (
        <section className="card" aria-label="Hypertide">
          <div className="card-head flex-wrap gap-y-1 py-2.5">
            <span className="card-title">Hypertide</span>
            <span className="card-sub">{ht.lastSync ? `synced ${ago(ht.lastSync)}` : "not synced yet"}</span>
            <span className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-1 text-[12.5px] text-muted">
              <span><b className="num text-ink">{int(ht.paid)}</b> paid orders</span>
              <span><b className="num text-ink">{int(ht.done)}</b> done</span>
              <span><b className="num text-ink">{int(ht.inSetup)}</b> in setup</span>
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
            {ht.retiredBilled.length} retired domain{ht.retiredBilled.length === 1 ? " is" : "s are"} still billed on Hypertide:{" "}
            {ht.retiredBilled.slice(0, 6).map((d) => d.name).join(", ")}{ht.retiredBilled.length > 6 ? ` and ${ht.retiredBilled.length - 6} more` : ""}. Cancel the subscriptions there.
          </span>
        </div>
      ) : null}

      {domains.some((d) => d.nsRequestStatus === "pending" || d.nsRequestStatus === "running") ? <AutoRefresh seconds={5} /> : null}
      <InventoryView domains={domains} clients={clients} />

      {totals.retiredRenewing > 0 ? (
        <div className="callout tone-warning">
          <TriangleAlert size={15} strokeWidth={1.75} />
          <span>{totals.retiredRenewing} retired domain{totals.retiredRenewing === 1 ? " renews" : "s renew"} in the next 60 days. Turn off auto-renew at the registrar unless you plan to rest and reuse them.</span>
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
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
                      <td><Link href={`/domains?d=${r.id}&view=all`} className="strong hover:underline">{r.name}</Link></td>
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

        <section className="card" aria-labelledby="registrars-title">
          <div className="card-head"><h2 id="registrars-title" className="card-title">By registrar</h2></div>
          <table className="data-table">
            <thead><tr><th>Registrar</th><th className="is-num">Owned</th><th className="is-num">Storage</th><th className="is-num">Per year</th></tr></thead>
            <tbody>
              {registrars.map((r) => (
                <tr key={r.registrar}>
                  <td className="strong">{r.registrar}</td>
                  <td className="is-num">{int(r.total)}</td>
                  <td className="is-num">{r.storage ? int(r.storage) : <span className="zero">0</span>}</td>
                  <td className="is-num">{money(r.annualCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
