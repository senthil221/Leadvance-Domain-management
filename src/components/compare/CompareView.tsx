"use client";

import { ArrowDown, ArrowUp, ArrowUpRight, ChevronDown, Download, Equal, Inbox, ListFilter, X } from "lucide-react";
import Link from "next/link";
import { Fragment, useMemo, useState, useTransition, type ReactNode } from "react";
import { loadCompare, loadReview } from "@/app/actions";
import { DomainLink } from "@/components/domains/DomainLink";
import { RangePicker } from "@/components/RangePicker";
import { Empty, Rep } from "@/components/ui";
import { BOUNCE_META, BOUNCE_ORDER, CAUSE_COLOR } from "@/lib/bounces";
import {
  bounceMix, DIM_META, DIMS, formatMetric, groupsBy, headline, keysOf, METRIC_KEYS, METRICS, metricValue, MIN_SENT, pct, standAgainst, summarize,
  trendBuckets, trendSeries, type Dim, type Finding, type Group, type MetricKey,
} from "@/lib/compare";
import { int } from "@/lib/format";
import type { CompareDay } from "@/lib/queries";
import { daysBetween, nice, previousLabel } from "@/lib/range";
import { isCurrent, STANDING_META, type ReviewData, type ReviewDomain } from "@/lib/review";
import { RankedBars, seriesColor, TrendChart } from "./CompareCharts";
import { Findings } from "./Findings";

const SLOTS = 8;
type Pick = { key: string; slot: number | null };
type Scope = "current" | "history";

/** One group to look at, with the biggest others beside it: a number on its own compares nothing. */
const focusOn = (key: string, list: Group[]): Pick[] => {
  const others = list.filter((g) => g.key !== key && g.sent > 0).slice(0, SLOTS - 1);
  return [{ key, slot: 0 }, ...others.map((g, i) => ({ key: g.key, slot: i + 1 }))];
};

const fmtRate = (v: number | null) => (v == null ? "—" : `${v < 1 ? v.toFixed(2) : v.toFixed(1)}%`);

/** A number and how it moved against the comparison period. */
function Moved({ now, then, better = 0, rate = false }: { now: number | null; then: number | null; better?: 1 | -1 | 0; rate?: boolean }) {
  if (now == null || then == null || then === 0) return null;
  const diff = (100 * (now - then)) / then;
  if (Math.abs(diff) < 1) return <span className="cmp-moved"><Equal size={10} strokeWidth={2} aria-hidden="true" />same</span>;
  const good = better === 0 ? null : (diff > 0) === (better > 0);
  const Icon = diff > 0 ? ArrowUp : ArrowDown;
  return <span className={`cmp-moved${good == null ? "" : good ? " is-good" : " is-bad"}`} title={rate ? `Was ${fmtRate(then)}` : `Was ${int(then)}`}><Icon size={10} strokeWidth={2} aria-hidden="true" />{Math.abs(diff).toFixed(0)}%</span>;
}

type Then = { sent: number; human: number; real: number | null; bounces: number; spam: number };
const thenFromPrev = (g: Group): Then => ({ sent: g.prevSent, human: g.prevHuman, real: null, bounces: g.prevBounces, spam: g.prevSpam });
/** Another period's numbers, scaled to this range's length so 14 days against 7 isn't a 100% rise. Rates don't change. */
const thenFromGroup = (g: Group, scale: number): Then => ({ sent: g.sent * scale, human: g.human * scale, real: g.real * scale, bounces: g.bounces * scale, spam: g.spam * scale });

type Cell = { text: ReactNode; csv: string; state?: "ahead" | "behind"; moved?: ReactNode };
type Row = { label: string; hint?: string; dot?: string; cell: (g: Group, then: Then | null) => Cell };
type Section = { title: string; rows: Row[] };

/** The side-by-side table: every group in a column, every number in a row. */
function buildSections(all: Group): Section[] {
  const rate = (key: MetricKey, thenCount: (t: Then) => number | null): Row["cell"] => (g, then) => {
    const v = metricValue(g, key);
    const s = standAgainst(g, all, key).state;
    const tc = then ? thenCount(then) : null;
    return {
      text: fmtRate(v), csv: v == null ? "" : v.toFixed(2),
      state: s === "ahead" || s === "behind" ? s : undefined,
      moved: <Moved now={v} then={then && tc != null ? pct(tc, then.sent) : null} better={METRICS[key].better} rate />,
    };
  };
  const count = (n: (g: Group) => number): Row["cell"] => (g) => ({ text: n(g) ? int(n(g)) : <span className="zero">0</span>, csv: String(n(g)) });
  const causes = BOUNCE_ORDER.filter((c) => all.causes[c]);
  return [
    {
      title: "Volume", rows: [
        { label: "Domains", cell: count((g) => g.domains) },
        { label: "Inboxes", hint: "Connected inboxes", cell: count((g) => g.inboxes) },
        {
          label: "Sent", cell: (g, then) => ({ text: g.sent ? int(g.sent) : <span className="zero">0</span>, csv: String(g.sent), moved: <Moved now={g.sent} then={then?.sent ?? null} /> }),
        },
      ],
    },
    {
      title: "Replies", rows: [
        { label: "Human replies", hint: METRICS.human.hint, cell: rate("human", (t) => t.human) },
        { label: "Replies without OOO", hint: METRICS.real.hint, cell: rate("real", (t) => t.real) },
        { label: "Human, count", cell: count((g) => g.human) },
        { label: "Out of office", cell: count((g) => g.ooo) },
        { label: "Negative", hint: "Not interested, wrong person or unsubscribe", cell: count((g) => g.negative) },
      ],
    },
    {
      title: "Deliverability", rows: [
        { label: "Bounce rate", hint: METRICS.bounce.hint, cell: rate("bounce", (t) => t.bounces) },
        { label: "Spam and blocks", hint: METRICS.spam.hint, cell: rate("spam", (t) => t.spam) },
        { label: "Bounces, count", cell: count((g) => g.bounces) },
      ],
    },
    ...(causes.length ? [{
      title: "Why they bounced", rows: causes.map((c): Row => ({
        label: BOUNCE_META[c].label, hint: BOUNCE_META[c].hint, dot: CAUSE_COLOR[c],
        cell: (g) => {
          const n = g.causes[c] ?? 0;
          const total = bounceMix(g).reduce((a, m) => a + m.n, 0);
          return { text: n ? <>{int(n)}<span className="cmp-share"> {Math.round((100 * n) / total)}%</span></> : <span className="zero">0</span>, csv: String(n) };
        },
      })),
    }] : []),
    {
      title: "Health and age", rows: [
        { label: "Reputation", hint: METRICS.rep.hint, cell: (g) => ({ text: <Rep value={g.rep} />, csv: g.rep == null ? "" : g.rep.toFixed(0) }) },
        { label: "Domain age", hint: "Average", cell: (g) => ({ text: g.ageDays == null ? <span className="zero">—</span> : `${Math.round(g.ageDays)} days`, csv: g.ageDays == null ? "" : String(Math.round(g.ageDays)) }) },
        { label: "Time in Smartlead", hint: "Average", cell: (g) => ({ text: g.connectedDays == null ? <span className="zero">—</span> : `${Math.round(g.connectedDays)} days`, csv: g.connectedDays == null ? "" : String(Math.round(g.connectedDays)) }) },
      ],
    },
  ];
}

function csvOf(sections: Section[], groups: Group[], all: Group, thenOf: (g: Group) => Then | null) {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const head = ["", ...groups.map((g) => g.label), all.label];
  const lines = [head.map(esc).join(",")];
  for (const s of sections) {
    for (const r of s.rows) lines.push([`${s.title}: ${r.label}`, ...[...groups, all].map((g) => r.cell(g, thenOf(g)).csv)].map(esc).join(","));
  }
  return lines.join("\n");
}

function download(name: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

/** The domains behind one group, worst first. */
function GroupDomains({ group, onClose }: { group: Group; onClose: () => void }) {
  const rows = useMemo(() => [...group.rows].sort((a, b) => b.bounces - a.bounces || b.sent - a.sent), [group]);
  return (
    <section className="card" aria-labelledby="cmp-domains">
      <div className="card-head">
        <h2 id="cmp-domains" className="card-title">{group.label}: the {int(group.domains)} domains behind it</h2>
        <span className="card-sub">Most bounces first</span>
        <button type="button" className="btn btn-sm cmp-close" onClick={onClose}><X size={13} strokeWidth={1.75} aria-hidden="true" />Close</button>
      </div>
      <div className="table-scroll cmp-domain-table">
        <table className="data-table">
          <thead><tr><th>Domain</th><th>Client</th><th>State</th><th className="is-num">Inboxes</th><th className="is-num">Sent</th><th className="is-num">Human</th><th className="is-num">Bounce</th><th>Top reason</th><th className="is-num">Reputation</th></tr></thead>
          <tbody>
            {rows.map((d) => {
              const top = bounceMix({ causes: d.causes })[0];
              return (
                <tr key={d.id}>
                  <td><DomainLink id={d.id} className="hover:underline">{d.name}</DomainLink></td>
                  <td>{d.clientId ? <Link href={`/clients/${d.clientId}`} className="hover:underline">{d.clientName}</Link> : <span className="zero">—</span>}</td>
                  <td className="cl-state">{d.standing ? STANDING_META[d.standing].label : "—"}</td>
                  <td className="is-num">{int(d.inboxes)}</td>
                  <td className="is-num">{d.sent ? int(d.sent) : <span className="zero">0</span>}</td>
                  <td className="is-num">{d.sent ? fmtRate(pct(d.human, d.sent)) : <span className="zero">—</span>}</td>
                  <td className="is-num">{d.sent ? fmtRate(pct(d.bounces, d.sent)) : <span className="zero">—</span>}</td>
                  <td>{top ? BOUNCE_META[top.cause].label : <span className="zero">—</span>}</td>
                  <td className="is-num"><Rep value={d.rep} low={d.lowRepInboxes} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Compare any number of groups: what stands out and why, who's ahead on the
 * number that matters, how it moved day by day, and every number side by side.
 */
export function CompareView({ initial, initialDaily, startClient = "", startDim = "tld", startGroup = null }: {
  initial: ReviewData; initialDaily: CompareDay[]; startClient?: string; startDim?: Dim; startGroup?: string | null;
}) {
  const [data, setData] = useState(initial);
  const [daily, setDaily] = useState(initialDaily);
  const [scope, setScope] = useState<Scope>("current");
  const [client, setClient] = useState(startClient);
  const [dim, setDim] = useState<Dim>(startDim);
  const [metric, setMetric] = useState<MetricKey>("human");
  const [picks, setPicks] = useState<Pick[] | null>(() => (startGroup != null
    ? focusOn(startGroup, groupsBy(initial.domains.filter((d) => isCurrent(d.standing) && (!startClient || d.clientId === startClient)), startDim))
    : null));
  const [only, setOnly] = useState<Partial<Record<Dim, string>>>({});
  const [showFilters, setShowFilters] = useState(false);
  const [onlyIds, setOnlyIds] = useState<{ ids: Set<string>; label: string } | null>(null);
  const [opened, setOpened] = useState<string | null>(startGroup);
  const [trendView, setTrendView] = useState<"chart" | "table">("chart");
  const [against, setAgainst] = useState<ReviewData | null>(null);
  const [pickDates, setPickDates] = useState(false);
  const [aFrom, setAFrom] = useState("");
  const [aTo, setATo] = useState("");
  const [loading, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const inScope = (d: ReviewDomain) => (scope === "current" ? isCurrent(d.standing) : !isCurrent(d.standing));
  const passes = (d: ReviewDomain) => inScope(d) && (!client || d.clientId === client)
    && (Object.entries(only) as [Dim, string][]).every(([k, v]) => !v || keysOf(d, k).some((x) => x.key === v));

  const clients = useMemo(() => {
    const m = new Map<string, { name: string; sent: number }>();
    for (const d of data.domains) if (d.clientId) m.set(d.clientId, { name: d.clientName ?? "", sent: (m.get(d.clientId)?.sent ?? 0) + d.sent });
    return [...m].map(([id, c]) => ({ id, ...c })).sort((a, b) => a.name.localeCompare(b.name));
  }, [data.domains]);
  const clientName = clients.find((c) => c.id === client)?.name ?? null;

  const rows = useMemo(() => data.domains.filter((d) => passes(d) && (!onlyIds || onlyIds.ids.has(d.id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.domains, scope, client, only, onlyIds]);
  const all = useMemo(() => summarize("all", "Everything in view", rows), [rows]);

  // A client's own name is usually one of its tags: every domain has it, so it compares nothing.
  const dimensions = useMemo(() => DIMS.filter((d) => !(d === "client" && client)), [client]);
  const available = useMemo(() => {
    const own = clientName?.trim().toLowerCase();
    return groupsBy(rows, dim).filter((g) => !(dim === "tag" && own && g.key === own));
  }, [rows, dim, clientName]);

  const defaults = useMemo<Pick[]>(() => available.filter((g) => g.sent > 0).slice(0, SLOTS).map((g, i) => ({ key: g.key, slot: i })), [available]);
  const effective = useMemo(() => {
    const known = new Set(available.map((g) => g.key));
    return (picks ?? defaults).filter((p) => known.has(p.key));
  }, [picks, defaults, available]);
  const groups = useMemo(() => {
    const by = new Map(available.map((g) => [g.key, g]));
    return effective.map((p) => by.get(p.key)!);
  }, [effective, available]);
  const slotOf = (key: string) => effective.find((p) => p.key === key)?.slot ?? null;

  const toggle = (key: string) => {
    const has = effective.some((p) => p.key === key);
    if (has) { setPicks(effective.filter((p) => p.key !== key)); if (opened === key) setOpened(null); return; }
    const used = new Set(effective.map((p) => p.slot));
    let slot: number | null = null;
    for (let i = 0; i < SLOTS; i++) if (!used.has(i)) { slot = i; break; }
    setPicks([...effective, { key, slot }]);
  };
  const pickAll = () => {
    const used = new Set(effective.map((p) => p.slot));
    const free = Array.from({ length: SLOTS }, (_, i) => i).filter((i) => !used.has(i));
    const have = new Set(effective.map((p) => p.key));
    setPicks([...effective, ...available.filter((g) => !have.has(g.key)).map((g) => ({ key: g.key, slot: free.shift() ?? null }))]);
  };
  const changeDim = (d: Dim) => { setDim(d); setPicks(null); setOpened(null); };

  const thenGroups = useMemo(() => {
    if (!against) return null;
    const domains = against.domains.filter(passes);
    return new Map(groupsBy(domains, dim).map((g) => [g.key, g]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [against, scope, client, only, dim]);
  const thenAll = useMemo(() => (against ? summarize("all", "", against.domains.filter(passes)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [against, scope, client, only]);
  const thenOf = (g: Group): Then | null => {
    if (!against) return thenFromPrev(g);
    const t = g.key === "all" ? thenAll : thenGroups?.get(g.key);
    return t ? thenFromGroup(t, (daysBetween(data.from, data.to) + 1) / (daysBetween(against.from, against.to) + 1)) : null;
  };

  const load = (from: string, to: string) => start(async () => {
    const r = await loadCompare({ from, to });
    if (r.ok) { setData(r.data.review); setDaily(r.data.daily); setError(null); } else setError(r.error);
  });
  const loadAgainst = () => {
    if (!aFrom || !aTo || aFrom > aTo) { setError("Pick both dates to compare with, the earlier one first"); return; }
    start(async () => {
      const r = await loadReview({ from: aFrom, to: aTo });
      if (r.ok) { setAgainst(r.data); setError(null); } else setError(r.error);
    });
  };

  // 8 in colour; anything past that is grey as "Other" on the charts and keeps its own column in the table.
  const coloured = useMemo(() => groups.filter((g) => slotOf(g.key) != null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, effective]);
  const rest = useMemo(() => groups.filter((g) => slotOf(g.key) == null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, effective]);
  const buckets = useMemo(() => trendBuckets(data.from, data.to), [data.from, data.to]);
  const series = useMemo(() => {
    const sets = coloured.map((g) => ({ key: g.key, ids: new Set(g.rows.map((d) => d.id)) }));
    if (rest.length) sets.push({ key: "__other", ids: new Set(rest.flatMap((g) => g.rows.map((d) => d.id))) });
    return trendSeries(daily, sets, metric, buckets);
  }, [daily, coloured, rest, metric, buckets]);
  const labelOf = (key: string) => (key === "__other" ? `Other (${rest.length})` : groups.find((g) => g.key === key)?.label ?? key);

  const sections = useMemo(() => buildSections(all), [all]);
  const openedGroup = opened != null ? groups.find((g) => g.key === opened) ?? null : null;
  const def = METRICS[metric];
  const rangeDays = daysBetween(data.from, data.to) + 1;
  const volumeDrop = data.to < data.today ? 0.3 : rangeDays >= 3 ? 0.4 : null;
  const findingDims = useMemo<Dim[]>(() => (client ? ["tag", "tld", "provider", "age", "connected"] : ["tld", "provider", "client", "age", "connected", "tag"]), [client]);
  const showFinding = (f: Finding) => {
    if (f.dim) {
      setOnlyIds(null);
      setDim(f.dim);
      setOpened(f.groupKey ?? null);
      setPicks(f.groupKey != null ? focusOn(f.groupKey, groupsBy(data.domains.filter(passes), f.dim)) : null);
      requestAnimationFrame(() => document.getElementById("cmp-domains")?.scrollIntoView({ behavior: "smooth", block: "center" }));
    } else {
      setOnlyIds({ ids: new Set(f.domainIds), label: f.title });
      setPicks(null);
    }
  };
  const sameLength = !against || daysBetween(against.from, against.to) + 1 === rangeDays;
  const compareLabel = against ? `${nice(against.from)} to ${nice(against.to)}${sameLength ? "" : ", scaled to the same number of days"}` : previousLabel(data.from, data.to);
  const headlineText = useHeadline(groups, all, metric);

  return (
    <>
      <div className="cmp-controls" style={{ opacity: loading ? 0.7 : 1 }}>
        <div className="cmp-bar">
          <label className="cmp-client">
            <span className="sr-only">Client</span>
            <select className="select" value={client} onChange={(e) => { setClient(e.target.value); setPicks(null); setOpened(null); setOnlyIds(null); if (e.target.value && dim === "client") setDim("tag"); }}>
              <option value="">All clients</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <div className="seg" role="group" aria-label="Which domains">
            <button type="button" aria-pressed={scope === "current"} onClick={() => { setScope("current"); setPicks(null); }}>Active</button>
            <button type="button" aria-pressed={scope === "history"} onClick={() => { setScope("history"); setPicks(null); }}>Disconnected or replaced</button>
          </div>
          <RangePicker from={data.from} to={data.to} today={data.today} loading={loading} onChange={load} />
          <label className="cmp-against">
            <span>against</span>
            <select className="select" value={pickDates ? "pick" : "prev"} onChange={(e) => { const p = e.target.value === "pick"; setPickDates(p); if (!p) setAgainst(null); }}>
              <option value="prev">The same days before</option>
              <option value="pick">Dates I pick…</option>
            </select>
          </label>
          {pickDates ? (
            <span className="cmp-against-dates">
              <input type="date" className="input" aria-label="Compare with, from" value={aFrom} max={data.today} onChange={(e) => setAFrom(e.target.value)} />
              <span>to</span>
              <input type="date" className="input" aria-label="Compare with, to" value={aTo} max={data.today} onChange={(e) => setATo(e.target.value)} />
              <button type="button" className="btn btn-sm" onClick={loadAgainst} disabled={loading}>Apply</button>
            </span>
          ) : null}
          <button type="button" className={`btn btn-sm cmp-filter-btn${Object.values(only).some(Boolean) ? " is-on" : ""}`} aria-expanded={showFilters} onClick={() => setShowFilters(!showFilters)}>
            <ListFilter size={13} strokeWidth={1.75} aria-hidden="true" />Narrow{Object.values(only).filter(Boolean).length ? ` (${Object.values(only).filter(Boolean).length})` : ""}
            <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" style={{ transform: showFilters ? "rotate(180deg)" : undefined }} />
          </button>
        </div>
        {showFilters ? (
          <div className="cmp-bar cmp-filters">
            {DIMS.filter((d) => d !== "client" && d !== dim).map((d) => (
              <label key={d} className="cmp-filter">
                <span>{DIM_META[d].label}</span>
                <select className="select" value={only[d] ?? ""} onChange={(e) => { setOnly({ ...only, [d]: e.target.value }); setPicks(null); }}>
                  <option value="">{DIM_META[d].all}</option>
                  {groupsBy(data.domains.filter(inScope).filter((x) => !client || x.clientId === client), d).map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
                </select>
              </label>
            ))}
            {Object.values(only).some(Boolean) ? <button type="button" className="btn btn-sm" onClick={() => { setOnly({}); setPicks(null); }}>Clear</button> : null}
          </div>
        ) : null}
        <div className="cmp-by">
          <span className="cmp-by-label">Compare by</span>
          <div className="seg cmp-dims" role="group" aria-label="Compare by">
            {dimensions.map((d) => <button key={d} type="button" aria-pressed={dim === d} onClick={() => changeDim(d)}>{DIM_META[d].label}</button>)}
          </div>
        </div>
        <div className="cmp-chips" role="group" aria-label={`${DIM_META[dim].label} groups to compare`}>
          {available.map((g) => {
            const on = effective.some((p) => p.key === g.key);
            return (
              <button key={g.key} type="button" role="checkbox" aria-checked={on} className={`cmp-chip${on ? " is-on" : ""}`} onClick={() => toggle(g.key)} title={`${int(g.domains)} domains, ${int(g.sent)} sent`}>
                <span className="cmp-chip-mark" style={on ? { background: seriesColor(slotOf(g.key)), borderColor: "transparent" } : undefined} aria-hidden="true" />
                {g.label}
                <span className="cmp-chip-n num">{int(g.sent)}</span>
              </button>
            );
          })}
          {available.length > 1 ? (
            <span className="cmp-chip-actions">
              {effective.length < available.length ? <button type="button" onClick={pickAll}>Select all {available.length}</button> : null}
              {effective.length ? <button type="button" onClick={() => { setPicks([]); setOpened(null); }}>Clear</button> : null}
            </span>
          ) : null}
        </div>
        {onlyIds ? (
          <p className="cmp-only-note">Only the {int(onlyIds.ids.size)} domains behind: {onlyIds.label} <button type="button" onClick={() => setOnlyIds(null)} aria-label="Show every domain again"><X size={12} strokeWidth={2} /></button></p>
        ) : null}
      </div>

      {error ? <p className="cmp-error" role="alert">{error}</p> : null}

      {!rows.length ? (
        <section className="card"><Empty icon={Inbox} title="No domains here">{client ? "This client has nothing in this view. Try the other tab or another range." : "Nothing in this view. Try the other tab or another range."}</Empty></section>
      ) : (
        <>
          <Findings domains={onlyIds ? data.domains.filter(passes) : rows} dims={findingDims} volumeDrop={volumeDrop} onShow={showFinding} />

          <div className="cmp-metrics" role="tablist" aria-label="Number to compare on">
            {METRIC_KEYS.map((k) => {
              const v = metricValue(all, k);
              const then = thenOf(all);
              const prior = k === "sent" ? then?.sent ?? null : k === "human" && then ? pct(then.human, then.sent) : k === "real" && then?.real != null ? pct(then.real, then.sent) : k === "bounce" && then ? pct(then.bounces, then.sent) : k === "spam" && then ? pct(then.spam, then.sent) : null;
              return (
                <button key={k} type="button" role="tab" aria-selected={metric === k} className={`cmp-metric${metric === k ? " is-on" : ""}`} title={METRICS[k].hint} onClick={() => setMetric(k)}>
                  <span className="cmp-metric-label">{METRICS[k].label}</span>
                  <span className="cmp-metric-value num">{formatMetric(v, k)}</span>
                  <span className="cmp-metric-foot"><Moved now={v} then={prior} better={METRICS[k].better} rate={METRICS[k].kind === "rate"} /></span>
                </button>
              );
            })}
          </div>

          {groups.length ? (
            <>
              <div className="cmp-charts">
                <section className="card" aria-labelledby="cmp-rank-title">
                  <div className="card-head">
                    <h2 id="cmp-rank-title" className="card-title">Who&apos;s ahead</h2>
                    <span className="card-sub">{def.label}{def.kind === "rate" ? ", with the likely range" : ""}</span>
                  </div>
                  <p className="cmp-headline">{headlineText}</p>
                  <div className="card-body cmp-rank-body"><RankedBars groups={groups} all={all} metric={metric} slotOf={slotOf} picked={opened} onPick={(k) => setOpened(opened === k ? null : k)} /></div>
                </section>
                <section className="card" aria-labelledby="cmp-trend-title">
                  <div className="card-head">
                    <h2 id="cmp-trend-title" className="card-title">Over time</h2>
                    <span className="card-sub">{def.label}{buckets.length && buckets[0].from !== buckets[0].to ? ", by week" : ", by day"}</span>
                    <div className="seg cmp-right" role="group" aria-label="View">
                      <button type="button" aria-pressed={trendView === "chart"} onClick={() => setTrendView("chart")}>Chart</button>
                      <button type="button" aria-pressed={trendView === "table"} onClick={() => setTrendView("table")}>Table</button>
                    </div>
                  </div>
                  {trendView === "chart" ? (
                    <div className="card-body">
                      <TrendChart series={series} buckets={buckets} metric={metric} labelOf={labelOf} slotOf={(k) => (k === "__other" ? null : slotOf(k))} today={data.today} />
                      <ul className="cmp-legend">
                        {series.map((s) => <li key={s.key}><span className="cmp-dot" style={{ background: seriesColor(s.key === "__other" ? null : slotOf(s.key)) }} />{labelOf(s.key)}</li>)}
                        {def.kind === "rate" ? <li className="cmp-legend-note">Days with under 20 sent are left out</li> : null}
                      </ul>
                    </div>
                  ) : (
                    <div className="table-scroll cmp-trend-table">
                      <table className="data-table">
                        <thead><tr><th>{buckets[0]?.from !== buckets[0]?.to ? "Week from" : "Day"}</th>{series.map((s) => <th key={s.key} className="is-num">{labelOf(s.key)}</th>)}</tr></thead>
                        <tbody>
                          {buckets.map((b, i) => (
                            <tr key={b.from}><td>{nice(b.from)}</td>{series.map((s) => <td key={s.key} className="is-num">{s.values[i] == null ? <span className="zero">—</span> : formatMetric(s.values[i], metric)}</td>)}</tr>
                          )).reverse()}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </div>

              {openedGroup ? <GroupDomains group={openedGroup} onClose={() => setOpened(null)} /> : null}

              <section className="card" aria-labelledby="cmp-matrix-title">
                <div className="card-head">
                  <h2 id="cmp-matrix-title" className="card-title">Side by side</h2>
                  <span className="card-sub">Arrows are against {compareLabel}. Coloured rates are too far from the rest to be chance, on {int(MIN_SENT)}+ sent.</span>
                  <button type="button" className="btn btn-sm cmp-right" onClick={() => download(`compare-${dim}-${data.from}-${data.to}.csv`, csvOf(sections, groups, all, thenOf))}>
                    <Download size={13} strokeWidth={1.75} aria-hidden="true" />CSV
                  </button>
                </div>
                <div className="table-scroll cmp-matrix-wrap">
                  <table className="cmp-matrix">
                    <thead>
                      <tr>
                        <th scope="col" className="cmp-matrix-first"><span className="sr-only">Number</span></th>
                        {groups.map((g) => (
                          <th key={g.key} scope="col">
                            <button type="button" className={`cmp-matrix-head${opened === g.key ? " is-on" : ""}`} aria-expanded={opened === g.key} onClick={() => setOpened(opened === g.key ? null : g.key)} title="Show the domains">
                              <span className="cmp-dot" style={{ background: seriesColor(slotOf(g.key)) }} />{g.label}
                            </button>
                            {dim === "client" && g.key ? <Link href={`/clients/${g.key}`} className="cmp-matrix-link" aria-label={`Open ${g.label}'s sending`}><ArrowUpRight size={12} strokeWidth={1.5} /></Link> : null}
                          </th>
                        ))}
                        <th scope="col" className="cmp-matrix-all">{all.label}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sections.map((s) => (
                        <Fragment key={s.title}>
                          <tr className="cmp-matrix-section"><th scope="rowgroup" colSpan={groups.length + 2}>{s.title}</th></tr>
                          {s.rows.map((r) => (
                            <tr key={r.label}>
                              <th scope="row" className="cmp-matrix-first" title={r.hint}>{r.dot ? <span className="cmp-dot" style={{ background: r.dot }} /> : null}{r.label}</th>
                              {[...groups, all].map((g) => {
                                const c = r.cell(g, thenOf(g));
                                const low = g !== all && g.sent < MIN_SENT;
                                return (
                                  <td key={g.key} className={`${g === all ? "cmp-matrix-all" : ""}${low ? " is-low" : ""}`}>
                                    <span className={`cmp-cell${g !== all && c.state ? ` is-${c.state}` : ""}`}>
                                      {g !== all && c.state ? (c.state === "ahead" ? <ArrowUp size={11} strokeWidth={2.25} aria-label="Ahead" /> : <ArrowDown size={11} strokeWidth={2.25} aria-label="Behind" />) : null}
                                      {c.text}
                                    </span>
                                    {c.moved}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="cmp-note">{dim === "tag" ? "A domain with several tags counts under each. " : ""}Faded columns have under {int(MIN_SENT)} sent, so their rates can swing on a few emails.</p>
              </section>
            </>
          ) : (
            <section className="card"><Empty icon={ListFilter} title="Pick what to compare">Tick two or more {DIM_META[dim].label.toLowerCase()} groups above.</Empty></section>
          )}
        </>
      )}
    </>
  );
}

function useHeadline(groups: Group[], all: Group, metric: MetricKey) {
  return useMemo(() => headline(groups, all, metric), [groups, all, metric]);
}
