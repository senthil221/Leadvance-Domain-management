import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { CalendarClock, Plus, TriangleAlert } from "lucide-react";
import { AddDomainsDialog } from "@/components/inventory/AddDomainsDialog";
import { Badge, ClientCell, Empty, PageHead, Skeleton, StatusDot, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { int, shortDate } from "@/lib/format";
import { getInventory, listVendors } from "@/lib/queries";

export const metadata: Metadata = { title: "Inventory" };

export default function InventoryPage() {
  return (
    <>
      <PageHead title="Inventory" sub="What you own, where it is registered and what renews next">
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
  const { registrars, renewals, totals } = await getInventory();
  const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

  return (
    <>
      <section className="stats">
        <div className="stat"><span className="stat-label">Owned</span><span className="stat-value">{int(totals.owned)}</span><span className="stat-foot">across {registrars.length} registrar{registrars.length === 1 ? "" : "s"}</span></div>
        <Link href="/domains?view=storage" className="stat"><span className="stat-label">In storage</span><span className="stat-value">{int(totals.storage)}</span><span className="stat-foot">free for replacements</span></Link>
        <div className="stat"><span className="stat-label">Renewing in 60 days</span><span className="stat-value">{int(renewals.length)}</span><span className="stat-foot">{money(renewals.reduce((a, r) => a + (r.costCents ?? 0), 0))} total</span></div>
        <div className="stat"><span className="stat-label">Yearly cost</span><span className="stat-value">{money(totals.annualCents)}</span><span className="stat-foot">excluding retired domains</span></div>
      </section>

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
