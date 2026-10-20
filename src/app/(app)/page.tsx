import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ArrowRight, ArrowUpRight, CircleCheck, History } from "lucide-react";
import { AttentionList } from "@/components/overview/AttentionList";
import { ClientsTable } from "@/components/overview/ClientsTable";
import { Dot, Empty, PageHead, Skeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { ago, int } from "@/lib/format";
import { getInsights, getOverview, type Issues, type TrendDay } from "@/lib/queries";
import { STATUS_META, type DomainStatus, type Tone } from "@/lib/status";

export const metadata: Metadata = { title: "Overview" };

const FLEET_STATES: DomainStatus[] = ["active", "warming", "provisioning", "draining"];

export default function OverviewPage() {
  return (
    <>
      <PageHead title="Overview" sub="What needs you today, and how the sending fleet is doing" />
      <div className="page-body">
        <Suspense fallback={<OverviewSkeleton />}>
          <OverviewContent />
        </Suspense>
      </div>
    </>
  );
}

const rate = (n: number, d: number) => (d > 0 ? (100 * n) / d : null);

function Delta({ now, before, points = false, invert = false }: { now: number | null; before: number | null; points?: boolean; invert?: boolean }) {
  if (now == null || before == null || (!points && before === 0)) return null;
  const d = points ? now - before : (100 * (now - before)) / before;
  if (Math.abs(d) < (points ? 0.05 : 1)) return null;
  const good = invert ? d < 0 : d > 0;
  return <span className={good ? "delta-up" : "delta-down"}>{d > 0 ? "+" : "−"}{Math.abs(d).toFixed(points ? 2 : 0)}{points ? " pts" : "%"}</span>;
}

// The action list: each line is something to fix, worst first, and only
// shown when it applies.
function actions(i: Issues, weeksLeft: number | null): { tone: Tone; n: number; text: string; href: string }[] {
  const out: { tone: Tone; n: number; text: string; href: string }[] = [
    { tone: "danger", n: i.noZone, text: "domains with no DNS zone: nothing on them resolves", href: "/inventory" },
    { tone: "danger", n: i.flagged, text: "sending domains breaking a health rule", href: "/domains?view=flagged" },
    { tone: "danger", n: i.disconnected, text: "inboxes disconnected in Smartlead", href: "/inboxes" },
    { tone: "warning", n: i.lowRep, text: "inboxes with warmup reputation under 90", href: "/inboxes" },
    { tone: "warning", n: i.htWaiting, text: "Hypertide orders waiting for nameservers", href: "/inventory?view=setup" },
    { tone: "warning", n: i.htUnpaid, text: "Hypertide orders not paid yet", href: "/inventory" },
    { tone: "warning", n: i.billedRetired, text: "retired domains still billed by Hypertide", href: "/inventory?view=retired" },
    { tone: "warning", n: i.stuckSetup, text: "domains stuck in setup for over 10 days", href: "/inventory?view=setup" },
    { tone: "warning", n: i.nsFailed, text: "nameserver changes failed this week", href: "/inventory" },
    { tone: "warning", n: i.settingsFailed, text: "inbox setting updates failed", href: "/inboxes" },
    { tone: "info", n: i.renew14, text: "domains renew in the next 14 days", href: "/inventory" },
  ];
  if (i.freeLow) out.push({ tone: "warning", n: i.free, text: `free domains left${weeksLeft != null ? `, about ${Math.max(0, Math.floor(weeksLeft))} weeks at the current pace` : ""}`, href: "/inventory?view=free" });
  return out.filter((a) => a.n > 0);
}

async function OverviewContent() {
  await getCurrentUser();
  const [o, ins] = await Promise.all([getOverview(), getInsights()]);
  const todo = actions(ins.issues, o.weeksLeft);
  const t7 = ins.trend.slice(7), p7 = ins.trend.slice(0, 7);
  const sum = (d: TrendDay[], k: "sent" | "replies" | "human" | "bounces") => d.reduce((a, x) => a + x[k], 0);
  const sent7 = sum(t7, "sent"), sentP = sum(p7, "sent");
  const replyRate = rate(sum(t7, "replies"), sent7), replyRateP = rate(sum(p7, "replies"), sentP);
  const humanRate = rate(sum(t7, "human"), sent7), humanRateP = rate(sum(p7, "human"), sentP);
  const bounceRate = rate(sum(t7, "bounces"), sent7), bounceRateP = rate(sum(p7, "bounces"), sentP);
  const used = ins.capacity.capacity ? (100 * ins.capacity.sentToday) / ins.capacity.capacity : null;
  const maxDay = Math.max(1, ...ins.trend.map((d) => d.sent));
  const fleetTotals = FLEET_STATES.map((s) => ({ s, n: o.fleet.reduce((a, f) => a + (f.counts[s] ?? 0), 0) }));
  const fleetMax = Math.max(1, ...o.fleet.map((f) => f.total));

  return (
    <>
      <section className="stats is-6" aria-label="Key numbers">
        <Link href="/inboxes" className="stat">
          <span className="stat-label">Sent today</span>
          <span className="stat-value">{int(ins.capacity.sentToday)}</span>
          <span className="stat-foot">{used != null ? `${used.toFixed(0)}% of ${int(ins.capacity.capacity)} a day` : "no active inboxes"}</span>
        </Link>
        <Link href="/stats" className="stat">
          <span className="stat-label">Sent · 7 days</span>
          <span className="stat-value">{int(sent7)}</span>
          <span className="stat-foot"><Delta now={sent7} before={sentP} /> vs week before</span>
        </Link>
        <Link href="/stats" className="stat">
          <span className="stat-label">Reply rate · 7d</span>
          <span className="stat-value">{replyRate == null ? "—" : `${replyRate.toFixed(2)}%`}</span>
          <span className="stat-foot"><Delta now={replyRate} before={replyRateP} points /> {int(sum(t7, "replies"))} replies</span>
        </Link>
        <Link href="/activity" className="stat">
          <span className="stat-label">Human replies · 7d</span>
          <span className="stat-value">{int(sum(t7, "human"))}</span>
          <span className="stat-foot"><Delta now={humanRate} before={humanRateP} points /> {humanRate == null ? "" : `${humanRate.toFixed(2)}% of sent`}</span>
        </Link>
        <Link href="/stats" className="stat">
          <span className="stat-label"><Dot tone={bounceRate != null && bounceRate >= 3 ? "danger" : bounceRate != null && bounceRate >= 2 ? "warning" : "success"} />Bounce rate · 7d</span>
          <span className="stat-value">{bounceRate == null ? "—" : `${bounceRate.toFixed(1)}%`}</span>
          <span className="stat-foot"><Delta now={bounceRate} before={bounceRateP} points invert /> {int(sum(t7, "bounces"))} bounces</span>
        </Link>
        <Link href="/inventory?view=free" className="stat">
          <span className="stat-label"><Dot tone={ins.issues.freeLow ? "warning" : "faint"} />Free domains</span>
          <span className="stat-value">{int(o.totals.storage)}</span>
          <span className={`stat-foot${ins.issues.freeLow ? " text-warning-ink" : ""}`}>
            {o.weeksLeft == null ? "no replacements in 4 weeks" : `≈ ${Math.floor(o.weeksLeft)} weeks at ${o.weeklyBurn.toFixed(1)}/week`}
          </span>
        </Link>
      </section>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <section className="card" aria-labelledby="todo-title">
            <div className="card-head">
              <h2 id="todo-title" className="card-title">Needs action</h2>
              <span className="card-sub">{todo.length ? `${todo.length} thing${todo.length === 1 ? "" : "s"}` : "all clear"}</span>
            </div>
            {todo.length === 0 ? (
              <Empty icon={CircleCheck} title="Nothing needs you">Domains, inboxes, DNS and orders all look healthy.</Empty>
            ) : (
              <div className="list">
                {todo.map((a) => (
                  <Link key={a.text} href={a.href} className="list-row hover:bg-surface-3" style={{ minHeight: 38 }}>
                    <Dot tone={a.tone} />
                    <span className="num w-10 text-right font-semibold text-ink">{int(a.n)}</span>
                    <span className="list-main truncate text-ink-soft">{a.text}</span>
                    <ArrowRight size={13} className="flex-none text-faint" />
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="attention-title">
            <div className="card-head">
              <h2 id="attention-title" className="card-title">Flagged domains</h2>
              {o.totals.flagged > 0 ? <span className="card-sub">{o.totals.flagged}</span> : null}
              <Link href="/health" className="card-link">Health rules <ArrowRight size={13} strokeWidth={1.5} /></Link>
            </div>
            <AttentionList rows={o.attention} />
          </section>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <section className="card" aria-labelledby="trend-title">
            <div className="card-head">
              <h2 id="trend-title" className="card-title">Last 14 days</h2>
              <span className="card-sub">sent per day · reply rate in the tooltip</span>
              <Link href="/stats" className="card-link">Stats <ArrowRight size={13} strokeWidth={1.5} /></Link>
            </div>
            <div className="card-body">
              <div className="trend" role="img" aria-label="Emails sent per day over the last 14 days">
                {ins.trend.map((d) => {
                  const r = rate(d.replies, d.sent);
                  const day = new Date(`${d.day}T00:00:00Z`);
                  return (
                    <div key={d.day} className="trend-col" title={`${day.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}: ${int(d.sent)} sent, ${int(d.replies)} replies${r != null ? ` (${r.toFixed(2)}%)` : ""}, ${int(d.bounces)} bounces`}>
                      <span className="trend-bar" style={{ height: `${Math.max(2, (100 * d.sent) / maxDay)}%` }} />
                      <span className="trend-label">{day.getUTCDate()}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="card" aria-labelledby="clients-title">
            <div className="card-head">
              <h2 id="clients-title" className="card-title">Clients · 7 days</h2>
              <div className="fleet-legend ml-auto">
                {fleetTotals.map(({ s, n }) => <span key={s}><span className={`dot tone-${STATUS_META[s].tone}`} />{STATUS_META[s].label} <b>{int(n)}</b></span>)}
              </div>
            </div>
            {ins.clients.length ? <ClientsTable clients={ins.clients} /> : <p className="card-body zero">No clients yet.</p>}
            {o.fleet.length ? (
              <div className="card-body flex flex-col border-t border-line">
                {o.fleet.map((f) => (
                  <Link key={f.clientId} href={`/domains?client=${f.clientId}&view=all`} className="fleet-row -mx-1 rounded-md px-1 hover:bg-surface-3">
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
            ) : null}
          </section>
        </div>
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
            {o.activity.slice(0, 6).map((a) => (
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
      <div className="stats is-6">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="stat"><Skeleton w={80} h={11} /><Skeleton w={60} h={22} /><Skeleton w={110} h={10} /></div>
        ))}
      </div>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        {[0, 1].map((i) => (
          <div key={i} className="card"><div className="card-head"><Skeleton w={110} h={12} /></div>
            <div className="card-body flex flex-col gap-4">{[0, 1, 2, 3, 4].map((j) => <Skeleton key={j} h={14} />)}</div>
          </div>
        ))}
      </div>
    </>
  );
}
