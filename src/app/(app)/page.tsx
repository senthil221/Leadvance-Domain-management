import { DomainLink } from "@/components/domains/DomainLink";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ArrowRight, ArrowUpRight, BarChart3, CircleCheck, Globe, History, MailX, MessageSquareText, Send, Sparkles, UserRoundCheck } from "lucide-react";
import { AttentionList } from "@/components/overview/AttentionList";
import { ClientsTable } from "@/components/overview/ClientsTable";
import { ConnectionCheck } from "@/components/overview/ConnectionCheck";
import { DeadDomains } from "@/components/overview/DeadDomains";
import { Insights, readInsights } from "@/components/overview/Insights";
import { Delta, Kpi, Sparkline } from "@/components/overview/Kpi";
import { OverviewTabs, type OverviewTab } from "@/components/overview/OverviewTabs";
import { SendTrend } from "@/components/overview/SendTrend";
import { Dot, Empty, PageHead, Skeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { ago, int } from "@/lib/format";
import { getConnectionCheck, getInsights, getOverview, listDeadDomains, type Issues, type TrendDay } from "@/lib/queries";
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

// The action list: each line is something to fix, worst first, and only
// shown when it applies.
function actions(i: Issues, weeksLeft: number | null): { tone: Tone; n: number; text: string; href: string }[] {
  const out: { tone: Tone; n: number; text: string; href: string }[] = [
    { tone: "danger", n: i.dead, text: "active domains are dead: nothing on them can send", href: "#dead" },
    { tone: "danger", n: i.noZone, text: "domains with no DNS zone: nothing on them resolves", href: "/inventory" },
    { tone: "danger", n: i.flagged, text: "sending domains breaking a health rule", href: "/inboxes?view=attention" },
    { tone: "danger", n: i.disconnected, text: "inboxes disconnected in Smartlead", href: "/inboxes?view=disconnected" },
    { tone: "warning", n: i.lowRep, text: "inboxes with warmup reputation under 90", href: "/inboxes?view=attention" },
    { tone: "warning", n: i.htCancelledLive, text: "domains in use whose Hypertide order is cancelled", href: "/inventory" },
    { tone: "warning", n: i.htUnpaid, text: "Hypertide orders not paid yet", href: "/inventory" },
    { tone: "warning", n: i.billedRetired, text: "retired domains still billed by Hypertide", href: "/inventory?view=replaced" },
    { tone: "warning", n: i.stuckSetup, text: "domains stuck in setup for over 10 days", href: "/inventory?view=all" },
    { tone: "warning", n: i.nsFailed, text: "nameserver changes failed this week", href: "/inventory" },
    { tone: "warning", n: i.settingsFailed, text: "inbox setting updates failed", href: "/inboxes" },
    { tone: "success", n: i.readyForCampaigns, text: "new domains warmed up and ready for campaigns", href: "/replacements?view=ready" },
    { tone: "info", n: i.renew14, text: "domains renew in the next 14 days", href: "/inventory" },
  ];
  if (i.freeLow) out.push({ tone: "warning", n: i.free, text: `free domains left${weeksLeft != null ? `, about ${Math.max(0, Math.floor(weeksLeft))} weeks at the current pace` : ""}`, href: "/inventory?view=free" });
  return out.filter((a) => a.n > 0);
}

async function OverviewContent() {
  await getCurrentUser();
  const [o, ins, dead, connections] = await Promise.all([getOverview(), getInsights(), listDeadDomains(), getConnectionCheck()]);
  const todo = actions(ins.issues, o.weeksLeft);
  const t7 = ins.trend.slice(-7), p7 = ins.trend.slice(0, -7);
  const sum = (d: TrendDay[], k: "sent" | "replies" | "human" | "bounces") => d.reduce((a, x) => a + x[k], 0);
  const sent7 = sum(t7, "sent"), sentP = sum(p7, "sent");
  const replyRate = rate(sum(t7, "replies"), sent7), replyRateP = rate(sum(p7, "replies"), sentP);
  const humanRate = rate(sum(t7, "human"), sent7), humanRateP = rate(sum(p7, "human"), sentP);
  const bounceRate = rate(sum(t7, "bounces"), sent7), bounceRateP = rate(sum(p7, "bounces"), sentP);
  const used = ins.capacity.capacity ? (100 * ins.capacity.sentToday) / ins.capacity.capacity : null;
  const fleetTotals = FLEET_STATES.map((s) => ({ s, n: o.fleet.reduce((a, f) => a + (f.counts[s] ?? 0), 0) }));
  const dayLabel = (d: TrendDay) => new Date(`${d.day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const spark = (value: (d: TrendDay) => number | null, show: (v: number) => string) =>
    ins.trend.map((d) => { const v = value(d); return { value: v, label: `${dayLabel(d)}: ${v == null ? "nothing sent" : show(v)}` }; });
  const pctOf = (digits: number) => (v: number) => `${v.toFixed(digits)}%`;
  const bounceTone: Tone = bounceRate != null && bounceRate >= 3 ? "danger" : bounceRate != null && bounceRate >= 2 ? "warning" : "success";
  const lines = readInsights(ins.trend, ins.clients, ins.capacity.capacity);

  const issues: OverviewTab[] = [
    ...(dead.length ? [{ key: "dead", label: "Dead domains", count: dead.length, tone: "danger" as const, content: <DeadDomains rows={dead} /> }] : []),
    { key: "flagged", label: "Flagged", count: o.totals.flagged, tone: "warning", content: <AttentionList rows={o.attention} /> },
    {
      key: "changes", label: "Recent changes",
      content: o.activity.length === 0 ? (
        <Empty icon={History} title="Nothing yet">Status changes and replacements show up here.</Empty>
      ) : (
        <div className="list">
          {o.activity.map((a) => (
            <div key={a.id} className="list-row">
              <Dot tone={STATUS_META[a.toStatus].tone} />
              <div className="list-main">
                <DomainLink id={a.domainId} className="list-title hover:underline">{a.domain}</DomainLink>
                <span className="list-meta">Moved to {STATUS_META[a.toStatus].label}{a.reason ? ` · ${a.reason}` : ""} · {a.actor}</span>
              </div>
              <span className="list-meta w-16 text-right">{ago(a.at)}</span>
            </div>
          ))}
        </div>
      ),
    },
  ];

  return (
    <div className="overview">
      <ConnectionCheck data={connections} />

      <section className="kpis" aria-label="Key numbers">
        <Kpi href="/inboxes" label="Sent today" icon={Send} accent="brand" value={int(ins.capacity.sentToday)}
          foot={used != null ? `of ${int(ins.capacity.capacity)} a day` : "no active inboxes"}>
          <span className="kpi-meter"><span style={{ width: `${Math.min(100, used ?? 0)}%` }} /></span>
        </Kpi>
        <Kpi href="/stats" label="Sent · 7 days" icon={BarChart3} accent="brand" value={int(sent7)} delta={<Delta now={sent7} before={sentP} />} foot="vs week before">
          <Sparkline points={spark((d) => d.sent, int)} />
        </Kpi>
        <Kpi href="/stats" label="Reply rate · 7d" icon={MessageSquareText} accent="violet" value={replyRate == null ? "—" : `${replyRate.toFixed(2)}%`}
          delta={<Delta now={replyRate} before={replyRateP} points />} foot={`${int(sum(t7, "replies"))} replies`}>
          <Sparkline points={spark((d) => rate(d.replies, d.sent), pctOf(2))} />
        </Kpi>
        <Kpi href="/activity" label="Human replies · 7d" icon={UserRoundCheck} accent="info" value={int(sum(t7, "human"))}
          delta={<Delta now={humanRate} before={humanRateP} points />} foot={humanRate == null ? "" : `${humanRate.toFixed(2)}% of sent`}>
          <Sparkline points={spark((d) => d.human, int)} />
        </Kpi>
        <Kpi href="/stats" label="Bounce rate · 7d" icon={MailX} accent={bounceTone} alert={bounceTone !== "success"} value={bounceRate == null ? "—" : `${bounceRate.toFixed(1)}%`}
          delta={<Delta now={bounceRate} before={bounceRateP} points invert />} foot={`${int(sum(t7, "bounces"))} bounces`}>
          <Sparkline points={spark((d) => rate(d.bounces, d.sent), pctOf(1))} />
        </Kpi>
        <Kpi href="/inventory?view=free" label="Free domains" icon={Globe} accent={ins.issues.freeLow ? "warning" : "faint"} alert={ins.issues.freeLow} value={int(o.totals.storage)}
          foot={o.weeksLeft == null ? "no replacements in 4 weeks" : `at ${o.weeklyBurn.toFixed(1)} a week`}>
          <span className="kpi-runway">{o.weeksLeft == null ? "Plenty of runway" : `About ${Math.floor(o.weeksLeft)} weeks left`}</span>
        </Kpi>
      </section>

      <div className="ov-grid">
        <section className="card ov-area-needs" aria-labelledby="todo-title">
          <div className="card-head">
            <h2 id="todo-title" className="card-title">Needs action</h2>
            <span className="card-sub">{todo.length ? `${todo.length} thing${todo.length === 1 ? "" : "s"}` : "all clear"}</span>
          </div>
          {todo.length === 0 ? (
            <Empty icon={CircleCheck} title={connections.problems.length ? "Nothing else needs you" : "Nothing needs you"}>
              {connections.problems.length ? "Apart from the connections above, domains" : "Domains"}, DNS and orders all look healthy.
            </Empty>
          ) : (
            <div className="list">
              {todo.map((a) => (
                <Link key={a.text} href={a.href} className={`action acc-${a.tone}`}>
                  <span className="action-n">{int(a.n)}</span>
                  <span className="action-text">{a.text}</span>
                  <ArrowRight size={13} className="flex-none text-faint" aria-hidden="true" />
                </Link>
              ))}
            </div>
          )}
        </section>

        <section className="card ov-area-trend" aria-labelledby="trend-title">
          <div className="card-head">
            <h2 id="trend-title" className="card-title">Sending</h2>
            <div className="st-legend">
              <span><i className="is-recent" />Last 7 days <b>{int(sent7)}</b></span>
              <span><i />7 days before <b>{int(sentP)}</b></span>
            </div>
            <Link href="/stats" className="card-link">Stats <ArrowUpRight size={13} strokeWidth={1.5} /></Link>
          </div>
          <div className="card-body"><SendTrend days={ins.trend} /></div>
        </section>

        <section className="card ov-area-insights" aria-labelledby="insights-title">
          <div className="card-head">
            <h2 id="insights-title" className="card-title inline-flex items-center gap-2"><Sparkles size={13} strokeWidth={1.75} className="text-faint" aria-hidden="true" />This week</h2>
          </div>
          <Insights lines={lines} />
        </section>

        <OverviewTabs id="dead" label="Domains to deal with" tabs={issues} />

        <section className="card ov-area-clients" aria-labelledby="clients-title">
          <div className="card-head">
            <h2 id="clients-title" className="card-title">Clients</h2>
            <div className="fleet-legend ml-auto">
              {fleetTotals.filter(({ n }) => n > 0).map(({ s, n }) => <span key={s}><span className={`dot tone-${STATUS_META[s].tone}`} />{STATUS_META[s].label} <b>{int(n)}</b></span>)}
            </div>
          </div>
          {ins.clients.length ? <ClientsTable clients={ins.clients} fleet={o.fleet} /> : <p className="card-body zero">No clients yet.</p>}
        </section>
      </div>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="overview">
      <div className="card" style={{ height: 168 }}><div className="card-body flex flex-col gap-3"><Skeleton w={90} h={11} /><Skeleton w={70} h={40} /><Skeleton w={140} h={12} /></div></div>
      <div className="kpis">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="kpi"><Skeleton w={80} h={11} /><Skeleton w={60} h={22} /><Skeleton w={110} h={10} /></div>
        ))}
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="card"><div className="card-head"><Skeleton w={110} h={12} /></div>
            <div className="card-body flex flex-col gap-4">{[0, 1, 2, 3, 4].map((j) => <Skeleton key={j} h={14} />)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
