"use client";

import { BarChart3, CalendarDays, Download, Loader, Search } from "lucide-react";
import Link from "next/link";
import { Fragment, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { loadStats } from "@/app/actions";
import { SortTh } from "@/components/SortTh";
import { ClientCell, Empty, Metric, StatusDot } from "@/components/ui";
import { int } from "@/lib/format";
import type { ClientRow, StatDomain, StatsData } from "@/lib/queries";
import { DOMAIN_STATUSES } from "@/lib/status";

// ---------------------------------------------------------------------------
// Dates (YYYY-MM-DD strings in the stats timezone; "today" comes from the server)
// ---------------------------------------------------------------------------

const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => fmt(new Date(toDate(s).getTime() + n * 86_400_000));
const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000) + 1;
const nice = (s: string) => toDate(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const weekday = (s: string) => toDate(s).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });

type PresetKey = "today" | "yesterday" | "7d" | "14d" | "30d" | "month" | "lastmonth" | "custom";
function presetRange(k: PresetKey, today: string): [string, string] | null {
  const t = toDate(today);
  switch (k) {
    case "today": return [today, today];
    case "yesterday": return [addDays(today, -1), addDays(today, -1)];
    case "7d": return [addDays(today, -6), today];
    case "14d": return [addDays(today, -13), today];
    case "30d": return [addDays(today, -29), today];
    case "month": return [fmt(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1))), today];
    case "lastmonth": return [fmt(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1))), fmt(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0)))];
    default: return null;
  }
}
const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "today", label: "Today" }, { key: "yesterday", label: "Yesterday" }, { key: "7d", label: "7 days" },
  { key: "14d", label: "14 days" }, { key: "30d", label: "30 days" }, { key: "month", label: "This month" },
  { key: "lastmonth", label: "Last month" }, { key: "custom", label: "Custom" },
];

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

type Sums = { sent: number; replies: number; human: number; ooo: number; negative: number; bounces: number };
const zero = (): Sums => ({ sent: 0, replies: 0, human: 0, ooo: 0, negative: 0, bounces: 0 });
const addInto = (a: Sums, b: Sums) => { a.sent += b.sent; a.replies += b.replies; a.human += b.human; a.ooo += b.ooo; a.negative += b.negative; a.bounces += b.bounces; };
type Row = StatDomain & Sums & { reputation: number | null };
type Totals = Sums & { inboxes: number; capacity: number; prevSent: number; prevReplies: number; prevBounces: number; reputation?: number | null };
const rate = (n: number, d: number) => (d > 0 ? (100 * n) / d : null);
const total = (rows: Row[]): Totals => {
  const t: Totals = { ...zero(), inboxes: 0, capacity: 0, prevSent: 0, prevReplies: 0, prevBounces: 0 };
  for (const r of rows) { addInto(t, r); t.inboxes += r.inboxes; t.capacity += r.capacity; t.prevSent += r.prevSent; t.prevReplies += r.prevReplies; t.prevBounces += r.prevBounces; }
  return t;
};

type SortKey = "name" | "status" | "client" | "inboxes" | "usage" | "sent" | "replies" | "human" | "ooo" | "negative" | "bounces" | "replyRate" | "humanRate" | "bounceRate" | "reputation";
const sortValue = (r: Row, k: SortKey, len: number): string | number | null => {
  switch (k) {
    case "status": return DOMAIN_STATUSES.indexOf(r.status);
    case "client": return r.clientName?.toLowerCase() ?? null;
    case "replyRate": return rate(r.replies, r.sent);
    case "humanRate": return rate(r.human, r.sent);
    case "bounceRate": return rate(r.bounces, r.sent);
    case "usage": return r.capacity ? r.sent / (r.capacity * len) : null;
    default: return r[k];
  }
};
type DayKey = "day" | "domains" | "sent" | "replies" | "human" | "ooo" | "negative" | "bounces" | "replyRate" | "humanRate" | "bounceRate";
const flip = <K extends string>(s: { key: K; dir: 1 | -1 }, key: K, ascFirst: boolean) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: (ascFirst ? 1 : -1) as 1 | -1 });
const cmp = (x: string | number | null, y: string | number | null, dir: number) => (x === y ? 0 : x === null ? 1 : y === null ? -1 : (x < y ? -1 : 1) * dir);

// Change against the period before, in percentage points for rates.
function Delta({ now, before, points = false, invert = false }: { now: number | null; before: number | null; points?: boolean; invert?: boolean }) {
  if (now == null || before == null || (!points && before === 0)) return null;
  const d = points ? now - before : (100 * (now - before)) / before;
  if (Math.abs(d) < (points ? 0.05 : 1)) return null;
  const good = invert ? d < 0 : d > 0;
  return <span className={`text-[11.5px] ${good ? "delta-up" : "delta-down"}`}> {d > 0 ? "+" : ""}{d.toFixed(points ? 1 : 0)}{points ? "pt" : "%"}</span>;
}

const Z = ({ v }: { v: number }) => (v ? <>{int(v)}</> : <span className="zero">0</span>);

function Cells({ r, len }: { r: Totals; len: number }) {
  return (
    <>
      <td className="is-num"><Z v={r.inboxes} /></td>
      <td className="is-num" title={r.capacity ? `${int(r.sent)} of ${int(r.capacity * len)} possible` : undefined}>
        {r.capacity ? <Metric value={(100 * r.sent) / (r.capacity * len)} digits={0} /> : <span className="zero">—</span>}
      </td>
      <td className="is-num"><Z v={r.sent} /><Delta now={r.sent} before={r.prevSent} /></td>
      <td className="is-num"><Z v={r.replies} /></td>
      <td className="is-num"><Z v={r.human} /></td>
      <td className="is-num"><Z v={r.ooo} /></td>
      <td className="is-num"><Z v={r.negative} /></td>
      <td className="is-num"><Z v={r.bounces} /></td>
      <td className="is-num"><Metric value={rate(r.replies, r.sent)} digits={2} /><Delta now={rate(r.replies, r.sent)} before={rate(r.prevReplies, r.prevSent)} points /></td>
      <td className="is-num"><Metric value={rate(r.human, r.sent)} digits={2} /></td>
      <td className="is-num"><Metric value={rate(r.bounces, r.sent)} warn={2} bad={3} /><Delta now={rate(r.bounces, r.sent)} before={rate(r.prevBounces, r.prevSent)} points invert /></td>
      <td className="is-num">{r.reputation !== undefined ? <Metric value={r.reputation} warn={95} bad={90} invert digits={0} suffix="" /> : null}</td>
    </>
  );
}

function download(name: string, head: string[], lines: unknown[][]) {
  const esc = (v: unknown) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const url = URL.createObjectURL(new Blob([[head.join(","), ...lines.map((l) => l.map(esc).join(","))].join("\n")], { type: "text/csv" }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------

export function StatsView({ initial, clients }: { initial: StatsData; clients: ClientRow[] }) {
  const [data, setData] = useState(initial);
  const [preset, setPreset] = useState<PresetKey>("7d");
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [view, setView] = useState<"domain" | "day">("domain");
  const [q, setQ] = useState("");
  const [clientId, setClientId] = useState("");
  const [onlySending, setOnlySending] = useState(true);
  const [byClient, setByClient] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "sent", dir: -1 });
  const [daySort, setDaySort] = useState<{ key: DayKey; dir: 1 | -1 }>({ key: "day", dir: -1 });
  const [loading, start] = useTransition();

  const load = (f: string, t: string) => start(async () => {
    const r = await loadStats({ from: f, to: t });
    if (r.ok) setData(r.data); else toast.error(r.error);
  });
  const pick = (k: PresetKey) => {
    setPreset(k);
    const range = presetRange(k, data.today);
    if (range) { setFrom(range[0]); setTo(range[1]); load(range[0], range[1]); }
  };

  const len = daysBetween(data.from, data.to);
  const needle = q.trim().toLowerCase();
  const visible = useMemo(() => data.domains.filter((d) =>
    (!clientId || d.clientId === clientId) &&
    (!needle || d.name.includes(needle) || d.clientName?.toLowerCase().includes(needle) || d.tags.some((t) => t.toLowerCase().includes(needle)))),
  [data.domains, clientId, needle]);

  const rows = useMemo(() => {
    const byId = new Map<string, Row>(visible.map((d) => [d.id, { ...d, ...zero(), reputation: null }]));
    const reps = new Map<string, number[]>();
    for (const x of data.days) {
      const r = byId.get(x.d);
      if (!r) continue;
      addInto(r, x);
      if (x.rep != null) reps.set(x.d, [...(reps.get(x.d) ?? []), x.rep]);
    }
    for (const [id, list] of reps) byId.get(id)!.reputation = list.reduce((a, b) => a + b, 0) / list.length;
    return [...byId.values()]
      .filter((r) => !onlySending || r.sent > 0 || r.status === "active")
      .sort((a, b) => cmp(sortValue(a, sort.key, len), sortValue(b, sort.key, len), sort.dir) || a.name.localeCompare(b.name));
  }, [visible, data.days, onlySending, sort, len]);

  const days = useMemo(() => {
    const ids = new Set(visible.map((d) => d.id));
    const map = new Map<string, Sums & { day: string; domains: number }>();
    for (let i = 0; i < len; i++) { const day = addDays(data.from, i); map.set(day, { day, domains: 0, ...zero() }); }
    for (const x of data.days) {
      if (!ids.has(x.d)) continue;
      const r = map.get(x.day);
      if (!r) continue;
      addInto(r, x);
      if (x.sent > 0) r.domains++;
    }
    const v = (r: Sums & { day: string; domains: number }, k: DayKey): string | number | null =>
      k === "replyRate" ? rate(r.replies, r.sent) : k === "humanRate" ? rate(r.human, r.sent) : k === "bounceRate" ? rate(r.bounces, r.sent) : r[k];
    return [...map.values()].sort((a, b) => cmp(v(a, daySort.key), v(b, daySort.key), daySort.dir) || b.day.localeCompare(a.day));
  }, [visible, data.days, data.from, len, daySort]);

  const groups = useMemo(() => {
    if (!byClient) return [{ key: "all", name: null as string | null, hue: null as number | null, rows }];
    const map = new Map<string, { key: string; name: string | null; hue: number | null; rows: Row[] }>();
    for (const r of rows) {
      const k = r.clientId ?? "none";
      const g = map.get(k) ?? { key: k, name: r.clientName, hue: r.clientHue, rows: [] };
      g.rows.push(r);
      map.set(k, g);
    }
    return [...map.values()].sort((a, b) => total(b.rows).sent - total(a.rows).sent);
  }, [rows, byClient]);

  const t = total(rows);
  const maxDay = Math.max(1, ...days.map((d) => d.sent));
  const sortBy = (key: SortKey) => setSort((s) => flip(s, key, key === "name" || key === "client" || key === "status"));
  const sortDay = (key: DayKey) => setDaySort((s) => flip(s, key, false));
  const rangeLabel = data.from === data.to ? nice(data.from) : `${nice(data.from)} – ${nice(data.to)}`;

  const exportCsv = () => {
    if (view === "day") {
      download(`stats-by-day-${data.from}-${data.to}.csv`, ["day", "domains_sending", "sent", "replies", "human", "ooo", "negative", "bounces"],
        [...days].sort((a, b) => a.day.localeCompare(b.day)).map((d) => [d.day, d.domains, d.sent, d.replies, d.human, d.ooo, d.negative, d.bounces]));
    } else {
      const fx = (v: number | null) => (v == null ? "" : v.toFixed(2));
      download(`stats-by-domain-${data.from}-${data.to}.csv`, ["domain", "status", "client", "inboxes", "capacity_per_day", "sent", "replies", "human", "ooo", "negative", "bounces", "reply_rate", "human_rate", "bounce_rate", "reputation"],
        rows.map((r) => [r.name, r.status, r.clientName, r.inboxes, r.capacity, r.sent, r.replies, r.human, r.ooo, r.negative, r.bounces, fx(rate(r.replies, r.sent)), fx(rate(r.human, r.sent)), fx(rate(r.bounces, r.sent)), fx(r.reputation)]));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <section className="stats" aria-label="Totals">
        <div className="stat"><span className="stat-label">Sent · {rangeLabel}</span><span className="stat-value">{int(t.sent)}</span><span className="stat-foot">{t.prevSent ? <>vs {int(t.prevSent)} the {len} days before<Delta now={t.sent} before={t.prevSent} /></> : `${int(Math.round(t.sent / len))} a day on average`}</span></div>
        <div className="stat"><span className="stat-label">Reply rate</span><span className="stat-value">{rate(t.replies, t.sent)?.toFixed(2) ?? "—"}%</span><span className="stat-foot">{int(t.replies)} replies · {int(t.ooo)} out of office<Delta now={rate(t.replies, t.sent)} before={rate(t.prevReplies, t.prevSent)} points /></span></div>
        <div className="stat"><span className="stat-label">Human replies</span><span className="stat-value">{int(t.human)}</span><span className="stat-foot">{rate(t.human, t.sent)?.toFixed(2) ?? "0.00"}% of sent · {int(t.negative)} not interested</span></div>
        <div className="stat"><span className="stat-label">Bounce rate</span><span className="stat-value">{rate(t.bounces, t.sent)?.toFixed(1) ?? "—"}%</span><span className="stat-foot">{int(t.bounces)} bounces<Delta now={rate(t.bounces, t.sent)} before={rate(t.prevBounces, t.prevSent)} points invert /></span></div>
      </section>

      <div className="toolbar">
        <div className="seg flex-wrap" role="group" aria-label="Date range">
          {PRESETS.map((p) => <button key={p.key} type="button" aria-pressed={preset === p.key} onClick={() => pick(p.key)}>{p.label}</button>)}
        </div>
        {preset === "custom" ? (
          <span className="flex items-center gap-1.5">
            <CalendarDays size={14} className="text-faint" />
            <input type="date" className="input" style={{ width: 150 }} value={from} max={data.today} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <span className="text-faint">to</span>
            <input type="date" className="input" style={{ width: 150 }} value={to} max={data.today} onChange={(e) => setTo(e.target.value)} aria-label="To" />
            <button type="button" className="btn btn-sm btn-primary" disabled={!from || !to || loading} onClick={() => load(from, to)}>Apply</button>
          </span>
        ) : null}
        {loading ? <Loader size={14} className="animate-spin text-faint" aria-label="Loading" /> : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="view-tabs" role="tablist" aria-label="View">
          <button type="button" role="tab" aria-selected={view === "domain"} className={view === "domain" ? "is-on" : undefined} onClick={() => setView("domain")}>By domain <span>{int(rows.length)}</span></button>
          <button type="button" role="tab" aria-selected={view === "day"} className={view === "day" ? "is-on" : undefined} onClick={() => setView("day")}>By day <span>{len}</span></button>
        </div>
      </div>
      <div className="toolbar">
        <label className="search-input">
          <Search size={14} strokeWidth={1.5} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search domains, clients or tags" aria-label="Search stats" />
        </label>
        <select className="select" style={{ width: 170 }} value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Filter by client">
          <option value="">All clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {view === "domain" ? (
          <>
            <label className="flex items-center gap-1.5 text-[12.5px] text-muted"><input type="checkbox" className="checkbox" checked={onlySending} onChange={(e) => setOnlySending(e.target.checked)} /> Sending only</label>
            <label className="flex items-center gap-1.5 text-[12.5px] text-muted"><input type="checkbox" className="checkbox" checked={byClient} onChange={(e) => setByClient(e.target.checked)} /> Group by client</label>
          </>
        ) : <span className="text-[12.5px] text-muted">{visible.length === data.domains.length ? "All domains" : `${visible.length} domains`} · {rangeLabel}</span>}
        <button type="button" className="btn btn-sm ml-auto" onClick={exportCsv}><Download size={14} /> Export</button>
      </div>

      <div className="table-wrap" style={{ opacity: loading ? 0.6 : 1, transition: "opacity 120ms" }}>
        <div className="table-scroll" style={{ maxHeight: "calc(100dvh - 380px)", minHeight: 280 }}>
          {view === "domain" ? (
            <table className="data-table is-main">
              <thead>
                <tr>
                  <SortTh k="name" sort={sort} onSort={sortBy}>Domain</SortTh>
                  <SortTh k="status" sort={sort} onSort={sortBy}>Status</SortTh>
                  <SortTh k="client" sort={sort} onSort={sortBy}>Client</SortTh>
                  <SortTh k="inboxes" sort={sort} onSort={sortBy} num>Inboxes</SortTh>
                  <SortTh k="usage" sort={sort} onSort={sortBy} num title="Sent as a share of the inboxes' daily limits over the range">Used</SortTh>
                  <SortTh k="sent" sort={sort} onSort={sortBy} num>Sent</SortTh>
                  <SortTh k="replies" sort={sort} onSort={sortBy} num>Replies</SortTh>
                  <SortTh k="human" sort={sort} onSort={sortBy} num>Human</SortTh>
                  <SortTh k="ooo" sort={sort} onSort={sortBy} num>OOO</SortTh>
                  <SortTh k="negative" sort={sort} onSort={sortBy} num>Negative</SortTh>
                  <SortTh k="bounces" sort={sort} onSort={sortBy} num>Bounces</SortTh>
                  <SortTh k="replyRate" sort={sort} onSort={sortBy} num>Reply %</SortTh>
                  <SortTh k="humanRate" sort={sort} onSort={sortBy} num>Human %</SortTh>
                  <SortTh k="bounceRate" sort={sort} onSort={sortBy} num>Bounce %</SortTh>
                  <SortTh k="reputation" sort={sort} onSort={sortBy} num>Reputation</SortTh>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <Fragment key={g.key}>
                    {byClient ? (
                      <tr style={{ background: "var(--surface-2)" }}>
                        <td className="col-first" colSpan={3}><span className="flex items-center gap-2"><ClientCell name={g.name ?? "No client"} hue={g.hue} /><span className="text-faint">{g.rows.length} domains</span></span></td>
                        <Cells r={total(g.rows)} len={len} />
                      </tr>
                    ) : null}
                    {g.rows.map((r) => (
                      <tr key={r.id}>
                        <td className="col-first" style={byClient ? { paddingLeft: 28 } : undefined}><Link href={`/domains?d=${r.id}&view=all`} className="strong hover:underline">{r.name}</Link></td>
                        <td><StatusDot status={r.status} /></td>
                        <td><ClientCell name={r.clientName} hue={r.clientHue} /></td>
                        <Cells r={r} len={len} />
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="data-table is-main">
              <thead>
                <tr>
                  <SortTh k="day" sort={daySort} onSort={sortDay}>Day</SortTh>
                  <SortTh k="domains" sort={daySort} onSort={sortDay} num>Domains sending</SortTh>
                  <SortTh k="sent" sort={daySort} onSort={sortDay} num>Sent</SortTh>
                  <th style={{ width: 160 }}></th>
                  <SortTh k="replies" sort={daySort} onSort={sortDay} num>Replies</SortTh>
                  <SortTh k="human" sort={daySort} onSort={sortDay} num>Human</SortTh>
                  <SortTh k="ooo" sort={daySort} onSort={sortDay} num>OOO</SortTh>
                  <SortTh k="negative" sort={daySort} onSort={sortDay} num>Negative</SortTh>
                  <SortTh k="bounces" sort={daySort} onSort={sortDay} num>Bounces</SortTh>
                  <SortTh k="replyRate" sort={daySort} onSort={sortDay} num>Reply %</SortTh>
                  <SortTh k="humanRate" sort={daySort} onSort={sortDay} num>Human %</SortTh>
                  <SortTh k="bounceRate" sort={daySort} onSort={sortDay} num>Bounce %</SortTh>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d.day}>
                    <td className="col-first"><span className="strong">{nice(d.day)}</span> <span className="text-faint">{weekday(d.day)}</span></td>
                    <td className="is-num"><Z v={d.domains} /></td>
                    <td className="is-num"><Z v={d.sent} /></td>
                    <td><span className="progress" style={{ width: 140 }}><span style={{ width: `${(100 * d.sent) / maxDay}%`, background: "color-mix(in srgb, var(--ink) 24%, transparent)" }} /></span></td>
                    <td className="is-num"><Z v={d.replies} /></td>
                    <td className="is-num"><Z v={d.human} /></td>
                    <td className="is-num"><Z v={d.ooo} /></td>
                    <td className="is-num"><Z v={d.negative} /></td>
                    <td className="is-num"><Z v={d.bounces} /></td>
                    <td className="is-num"><Metric value={rate(d.replies, d.sent)} digits={2} /></td>
                    <td className="is-num"><Metric value={rate(d.human, d.sent)} digits={2} /></td>
                    <td className="is-num"><Metric value={rate(d.bounces, d.sent)} warn={2} bad={3} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {view === "domain" && rows.length === 0 ? (
            <Empty icon={BarChart3} title="No numbers for this range">Stats come from the Smartlead webhooks (sent, replies, bounces) and are rolled up every 10 minutes.</Empty>
          ) : null}
        </div>
        <div className="table-footer">
          {view === "domain" ? <span><b>{int(rows.length)}</b> domains</span> : <span><b>{len}</b> days</span>}
          <span><b>{int(t.sent)}</b> sent</span>
          <span><b>{int(t.replies)}</b> replies</span>
          <span><b>{int(t.human)}</b> human</span>
          <span><b>{rate(t.bounces, t.sent)?.toFixed(1) ?? "0.0"}%</b> bounce</span>
        </div>
      </div>
    </div>
  );
}
