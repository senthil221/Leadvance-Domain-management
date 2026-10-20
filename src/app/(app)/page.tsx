import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ArrowRight, ArrowUpRight, History } from "lucide-react";
import { AttentionList } from "@/components/overview/AttentionList";
import { Dot, Empty, PageHead, Skeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { ago, int, pct } from "@/lib/format";
import { getOverview } from "@/lib/queries";
import { STATUS_META, type DomainStatus } from "@/lib/status";

export const metadata: Metadata = { title: "Overview" };

const FLEET_STATES: DomainStatus[] = ["active", "warming", "provisioning", "draining"];

export default function OverviewPage() {
  return (
    <>
      <PageHead title="Overview" sub="Sending fleet health across every client" />
      <div className="page-body">
        <Suspense fallback={<OverviewSkeleton />}>
          <OverviewContent />
        </Suspense>
      </div>
    </>
  );
}

async function OverviewContent() {
  await getCurrentUser();
  const o = await getOverview();
  const storageLow = o.totals.storage <= o.totals.storageLow;
  const fleetTotals = FLEET_STATES.map((s) => ({ s, n: o.fleet.reduce((a, f) => a + (f.counts[s] ?? 0), 0) }));
  const fleetMax = Math.max(1, ...o.fleet.map((f) => f.total));

  return (
    <>
      <section className="stats" aria-label="Key numbers">
        <Link href="/domains?view=active" className="stat">
          <span className="stat-label"><Dot tone="success" />Active domains</span>
          <span className="stat-value">{int(o.totals.active)}</span>
          <span className="stat-foot">{o.totals.warming ? `${int(o.totals.warming)} more warming up` : "None warming up"}</span>
        </Link>
        <Link href="/inventory" className="stat">
          <span className="stat-label"><Dot tone={storageLow ? "warning" : "faint"} />In storage</span>
          <span className="stat-value">{int(o.totals.storage)}</span>
          <span className={`stat-foot${storageLow ? " text-warning-ink" : ""}`}>
            {o.weeksLeft == null
              ? "No replacements in the last 4 weeks"
              : `≈ ${o.weeksLeft < 1 ? "under a week" : `${Math.floor(o.weeksLeft)} week${Math.floor(o.weeksLeft) === 1 ? "" : "s"}`} at ${o.weeklyBurn.toFixed(1)} a week`}
          </span>
        </Link>
        <Link href="/domains?view=flagged" className="stat">
          <span className="stat-label"><Dot tone={o.totals.flagged ? "warning" : "faint"} />Needs attention</span>
          <span className="stat-value">{int(o.totals.flagged)}</span>
          <span className="stat-foot">{o.totals.flagged ? "Breaking a health rule" : "Every domain within rules"}</span>
        </Link>
        <div className="stat">
          <span className="stat-label">Human reply rate · 7d</span>
          <span className="stat-value">{pct(o.humanRate, 2)}</span>
          <span className="stat-foot">
            {o.humanRateDelta == null ? (
              `${int(o.sent7)} sent`
            ) : (
              <>
                <span className={o.humanRateDelta >= 0 ? "delta-up" : "delta-down"}>
                  {o.humanRateDelta >= 0 ? "+" : "−"}{Math.abs(o.humanRateDelta).toFixed(2)} pts
                </span>
                vs last week
              </>
            )}
          </span>
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <section className="card" aria-labelledby="attention-title">
          <div className="card-head">
            <h2 id="attention-title" className="card-title">Needs attention</h2>
            {o.totals.flagged > 0 ? <span className="card-sub">{o.totals.flagged} domains</span> : null}
            <Link href="/health" className="card-link">All alerts <ArrowRight size={13} strokeWidth={1.5} /></Link>
          </div>
          <AttentionList rows={o.attention} />
        </section>

        <section className="card" aria-labelledby="fleet-title">
          <div className="card-head">
            <h2 id="fleet-title" className="card-title">Fleet by client</h2>
            <Link href="/domains" className="card-link">Domains <ArrowRight size={13} strokeWidth={1.5} /></Link>
          </div>
          <div className="card-body flex flex-col gap-3">
            <div className="fleet-legend">
              {fleetTotals.map(({ s, n }) => (
                <span key={s}><span className={`dot tone-${STATUS_META[s].tone}`} />{STATUS_META[s].label} <b>{int(n)}</b></span>
              ))}
            </div>
            {o.fleet.length === 0 ? (
              <p className="zero">No domains assigned to clients yet.</p>
            ) : (
              <div className="flex flex-col">
                {o.fleet.map((f) => (
                  <Link key={f.clientId} href={`/domains?client=${f.clientId}`} className="fleet-row rounded-md hover:bg-surface-3 px-1 -mx-1">
                    <span className="truncate text-ink-soft">{f.name}</span>
                    <span className="fleet-bar" style={{ width: `${Math.max(8, (f.total / fleetMax) * 100)}%` }}>
                      {FLEET_STATES.filter((s) => f.counts[s]).map((s) => (
                        <span key={s} className={`tone-${STATUS_META[s].tone}`} style={{ flex: f.counts[s] }} title={`${STATUS_META[s].label}: ${f.counts[s]}`} />
                      ))}
                    </span>
                    <span className="num text-right text-muted">{int(f.total)}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      <section className="card" aria-labelledby="activity-title">
        <div className="card-head">
          <h2 id="activity-title" className="card-title">Recent changes</h2>
          <Link href="/replacements" className="card-link">Replacements <ArrowUpRight size={13} strokeWidth={1.5} /></Link>
        </div>
        {o.activity.length === 0 ? (
          <Empty icon={History} title="Nothing yet">Status changes and replacements show up here.</Empty>
        ) : (
          <div className="list">
            {o.activity.map((a) => (
              <div key={a.id} className="list-row">
                <Dot tone={STATUS_META[a.toStatus].tone} />
                <div className="list-main">
                  <span className="truncate">
                    <Link href={`/domains?d=${a.domainId}`} className="strong text-ink hover:underline">{a.domain}</Link>
                    <span className="text-muted"> moved to </span>
                    <span className="text-ink">{STATUS_META[a.toStatus].label}</span>
                    {a.reason ? <span className="text-muted"> · {a.reason}</span> : null}
                  </span>
                </div>
                <span className="list-meta hidden sm:block">{a.actor}</span>
                <span className="list-meta w-16 text-right">{ago(a.at)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function OverviewSkeleton() {
  return (
    <>
      <div className="stats">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="stat"><Skeleton w={90} h={12} /><Skeleton w={70} h={26} /><Skeleton w={130} h={10} /></div>
        ))}
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        {[0, 1].map((i) => (
          <div key={i} className="card"><div className="card-head"><Skeleton w={110} h={12} /></div>
            <div className="card-body flex flex-col gap-4">{[0, 1, 2, 3, 4].map((j) => <Skeleton key={j} h={14} />)}</div>
          </div>
        ))}
      </div>
    </>
  );
}
