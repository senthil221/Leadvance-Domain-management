"use client";

import { DomainLink } from "@/components/domains/DomainLink";
import { BarChart3, CalendarDays, ChevronRight, Download, Loader, Search } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { type CSSProperties, Fragment, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { loadStats } from "@/app/actions";
import { ColumnsMenu, useColumns, type ColumnDef } from "@/components/Columns";
import { SortTh } from "@/components/SortTh";
import { ClientCell, Empty, Metric, Rep, StatusDot } from "@/components/ui";
import { int } from "@/lib/format";
import type { ClientRow, StatDomain, StatsData } from "@/lib/queries";
import { DOMAIN_STATUSES } from "@/lib/status";
import { PRESETS, addDays, daysBetween, matchPreset, nice, presetRange, previousLabel, weekday, type PresetKey } from "@/lib/range";

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

type Sums = { sent: number; replies: number; human: number; ooo: number; negative: number; bounces: number };
const zero = (): Sums => ({ sent: 0, replies: 0, human: 0, ooo: 0, negative: 0, bounces: 0 });
const addInto = (a: Sums, b: Sums) => { a.sent += b.sent; a.replies += b.replies; a.human += b.human; a.ooo += b.ooo; a.negative += b.negative; a.bounces += b.bounces; };
type Row = StatDomain & Sums & { reputation: number | null };
type Totals = Sums & { inboxes: number; capacity: number; prevSent: number; prevReplies: number; prevBounces: number; reputation?: number | null };
const rate = (n: number, d: number) => (d > 0 ? (100 * n) / d : null);
const avgRep = (rows: { reputation: number | null }[]) => {
  const v = rows.map((r) => r.reputation).filter((x): x is number => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
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
/** A client's value for a sort key, taken from its domains' totals, so clicking a header orders the clients too. */
const groupValue = (g: { name: string | null; rows: Row[] }, k: SortKey, len: number): string | number | null => {
  const t = total(g.rows);
  switch (k) {
    case "name":
    case "client": return g.name?.toLowerCase() ?? null;
    case "status": return null;
    case "replyRate": return rate(t.replies, t.sent);
    case "humanRate": return rate(t.human, t.sent);
    case "bounceRate": return rate(t.bounces, t.sent);
    case "usage": return t.capacity ? t.sent / (t.capacity * len) : null;
    case "reputation": return avgRep(g.rows);
    default: return t[k];
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

// Columns come in groups, each with a coloured top edge, so a row reads as
// volume | replies | bounces | health. Replies, human replies and bounces
// each show the count and the rate in one cell.
const GROUPS: Record<string, string[]> = {
  vol: ["inboxes", "usage", "sent"],
  rep: ["replies", "human", "ooo", "negative"],
  bnc: ["bounces"],
  health: ["reputation"],
};
const GROUP_OF = Object.fromEntries(Object.entries(GROUPS).flatMap(([g, keys]) => keys.map((k) => [k, g])));
/** Class for a column: its group, plus a divider on the group's first visible column. */
const gc = (key: string, on: (k: string) => boolean) => {
  const g = GROUP_OF[key];
  return `st-${g}${GROUPS[g].find(on) === key ? " st-start" : ""}`;
};

const COLUMNS: ColumnDef[] = [
  { key: "client", label: "Client (when not grouped)" }, { key: "inboxes", label: "Inboxes" },
  { key: "usage", label: "Used" }, { key: "sent", label: "Sent" }, { key: "replies", label: "Replies" },
  { key: "human", label: "Human" }, { key: "ooo", label: "Out of office", hidden: true }, { key: "negative", label: "Not interested", hidden: true },
  { key: "bounces", label: "Bounces" }, { key: "reputation", label: "Reputation" },
];

const pct = (v: number | null, digits: number) => (v == null ? null : `${v.toFixed(digits)}%`);
/** "6  1.60%": the count, then its rate in a fixed-width slot so columns line up. */
function Pair({ n, of, digits = 2, tone, warn, bad }: { n: number; of: number; digits?: number; tone: string; warn?: number; bad?: number }) {
  const r = rate(n, of);
  const level = r != null && bad != null && r >= bad ? "is-bad" : r != null && warn != null && r >= warn ? "is-warn" : "";
  if (!n) return <span className="st-pair is-zero"><span>0</span><span>{of ? pct(0, digits) : "—"}</span></span>;
  return (
    <span className="st-pair">
      <span className={tone}>{int(n)}</span>
      <span className={`st-rate ${level}`}>{pct(r, digits) ?? "—"}</span>
    </span>
  );
}

/** `agg` marks a client's summary row: each figure gets a small Sum or Avg caption. */
function Cells({ r, len, on, maxSent = 0, agg = false }: { r: Totals; len: number; on: (k: string) => boolean; maxSent?: number; agg?: boolean }) {
  const c = (k: string) => `is-num ${gc(k, on)}`;
  const cap = (t: "Sum" | "Avg") => (agg ? <span className="st-agg">{t}</span> : null);
  const before = r.prevSent ? `${int(r.prevSent)} sent, ${int(r.prevReplies)} replies, ${int(r.prevBounces)} bounces the ${len} day${len === 1 ? "" : "s"} before` : undefined;
  return (
    <>
      {on("inboxes") ? <td className={c("inboxes")}>{cap("Sum")}<Z v={r.inboxes} /></td> : null}
      {on("usage") ? (
        <td className={c("usage")} title={r.capacity ? `${int(r.sent)} of ${int(r.capacity * len)} possible` : undefined}>
          {cap("Avg")}{r.capacity ? <Metric value={(100 * r.sent) / (r.capacity * len)} digits={0} /> : <span className="zero">—</span>}
        </td>
      ) : null}
      {on("sent") ? (
        <td className={`${c("sent")} st-bar`} title={before} style={maxSent ? ({ "--w": `${Math.round((100 * r.sent) / maxSent)}%` } as CSSProperties) : undefined}>
          {cap("Sum")}{r.sent ? <span className="strong text-ink">{int(r.sent)}</span> : <span className="zero">0</span>}
        </td>
      ) : null}
      {on("replies") ? <td className={c("replies")}>{cap("Sum")}<Pair n={r.replies} of={r.sent} tone="st-v-rep" /></td> : null}
      {on("human") ? <td className={c("human")}>{cap("Sum")}<Pair n={r.human} of={r.sent} tone="st-v-hum" /></td> : null}
      {on("ooo") ? <td className={c("ooo")}>{cap("Sum")}<Z v={r.ooo} /></td> : null}
      {on("negative") ? <td className={c("negative")}>{cap("Sum")}<Z v={r.negative} /></td> : null}
      {on("bounces") ? <td className={c("bounces")}>{cap("Sum")}<Pair n={r.bounces} of={r.sent} digits={1} tone="st-v-bnc" warn={2} bad={3} /></td> : null}
      {on("reputation") ? <td className={c("reputation")}>{cap("Avg")}{r.reputation != null ? <Rep value={r.reputation} /> : <span className="zero">—</span>}</td> : null}
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
  const [preset, setPreset] = useState<PresetKey>(() => matchPreset(initial.from, initial.to, initial.today));
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [view, setView] = useState<"domain" | "day">("domain");
  const [q, setQ] = useState("");
  const params = useSearchParams();
  const [clientId, setClientId] = useState(() => params.get("client") ?? "");
  const [onlySending, setOnlySending] = useState(true);
  // Active domains (in campaigns) apart from the rest (warming, draining, retired).
  const [statusSet, setStatusSet] = useState<"" | "active" | "other">(() => (params.get("status") === "active" || params.get("status") === "other" ? params.get("status") as "active" | "other" : ""));
  // One line per client to start; open a client to see its domains.
  const [byClient, setByClient] = useState(true);
  const [openClients, setOpenClients] = useState<Set<string>>(new Set());
  const toggleClient = (key: string) => setOpenClients((s0) => { const n = new Set(s0); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "sent", dir: -1 });
  const [daySort, setDaySort] = useState<{ key: DayKey; dir: 1 | -1 }>({ key: "day", dir: -1 });
  const [loading, start] = useTransition();
  const cols = useColumns("stats", COLUMNS);
  const on = cols.on;

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
    (!statusSet || (statusSet === "active") === (d.status === "active")) &&
    (!needle || d.name.includes(needle) || d.clientName?.toLowerCase().includes(needle) || d.tags.some((t) => t.toLowerCase().includes(needle)))),
  [data.domains, clientId, statusSet, needle]);

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
    return [...map.values()].sort((a, b) => cmp(groupValue(a, sort.key, len), groupValue(b, sort.key, len), sort.dir) || (a.name ?? "").localeCompare(b.name ?? ""));
  }, [rows, byClient, sort, len]);

  const t = total(rows);
  const maxSent = Math.max(0, ...rows.map((r) => r.sent));
  const showClient = !byClient && on("client");
  const colCount = 1 + (showClient ? 1 : 0) + COLUMNS.filter((c) => c.key !== "client" && on(c.key)).length;
  const allOpen = byClient && groups.length > 0 && groups.every((g) => openClients.has(g.key));
  const toggleAll = () => setOpenClients(allOpen ? new Set() : new Set(groups.map((g) => g.key)));
  const maxClientSent = Math.max(0, ...groups.map((g) => total(g.rows).sent));
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
        <div className="stat"><span className="stat-label">Sent · {rangeLabel}</span><span className="stat-value">{int(t.sent)}</span><span className="stat-foot">{t.prevSent ? <>vs {int(t.prevSent)} {previousLabel(data.from, data.to)}<Delta now={t.sent} before={t.prevSent} /></> : `${int(Math.round(t.sent / len))} a day on average`}</span></div>
        <div className="stat"><span className="stat-label">Reply rate</span><span className="stat-value">{rate(t.replies, t.sent)?.toFixed(2) ?? "—"}%</span><span className="stat-foot">{int(t.replies)} replies · {int(t.ooo)} out of office<Delta now={rate(t.replies, t.sent)} before={rate(t.prevReplies, t.prevSent)} points /></span></div>
        <div className="stat"><span className="stat-label">Human replies</span><span className="stat-value">{int(t.human)}</span><span className="stat-foot">{rate(t.human, t.sent)?.toFixed(2) ?? "0.00"}% of sent · {int(t.negative)} not interested</span></div>
        <div className="stat"><span className="stat-label">Bounce rate</span><span className="stat-value">{rate(t.bounces, t.sent)?.toFixed(1) ?? "—"}%</span><span className="stat-foot">{int(t.bounces)} bounces<Delta now={rate(t.bounces, t.sent)} before={rate(t.prevBounces, t.prevSent)} points invert /></span></div>
      </section>

      <div className="table-bar">
        <div className="view-tabs" role="tablist" aria-label="View">
          <button type="button" role="tab" aria-selected={view === "domain"} className={view === "domain" ? "is-on" : undefined} onClick={() => setView("domain")}>By domain <span>{int(rows.length)}</span></button>
          <button type="button" role="tab" aria-selected={view === "day"} className={view === "day" ? "is-on" : undefined} onClick={() => setView("day")}>By day <span>{len}</span></button>
        </div>
        <label className="flex items-center gap-1.5">
          <CalendarDays size={14} className="text-faint" />
          <select className="select" style={{ width: 130 }} value={preset} onChange={(e) => pick(e.target.value as PresetKey)} aria-label="Date range">
            {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </label>
        {preset === "custom" ? (
          <span className="flex items-center gap-1.5">
            <input type="date" className="input" style={{ width: 138 }} value={from} max={data.today} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <span className="text-faint">–</span>
            <input type="date" className="input" style={{ width: 138 }} value={to} max={data.today} onChange={(e) => setTo(e.target.value)} aria-label="To" />
            <button type="button" className="btn btn-sm btn-primary" disabled={!from || !to || loading} onClick={() => load(from, to)}>Apply</button>
          </span>
        ) : <span className="text-[12.5px] text-muted">{rangeLabel}</span>}
        {loading ? <Loader size={14} className="animate-spin text-faint" aria-label="Loading" /> : null}
        <select className="select" style={{ width: 150 }} value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Filter by client">
          <option value="">All clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="select" style={{ width: 130 }} value={statusSet} onChange={(e) => setStatusSet(e.target.value as "" | "active" | "other")} aria-label="Filter by status">
          <option value="">All domains</option>
          <option value="active">Active</option>
          <option value="other">Not active</option>
        </select>
        {view === "domain" ? (
          <>
            <label className="flex items-center gap-1.5 text-[12.5px] text-muted"><input type="checkbox" className="checkbox" checked={onlySending} onChange={(e) => setOnlySending(e.target.checked)} /> Sending only</label>
            <label className="flex items-center gap-1.5 text-[12.5px] text-muted"><input type="checkbox" className="checkbox" checked={byClient} onChange={(e) => setByClient(e.target.checked)} /> By client</label>
            {byClient ? <button type="button" className="btn btn-sm" onClick={toggleAll}>{allOpen ? "Collapse all" : "Expand all"}</button> : null}
          </>
        ) : null}
        <span className="spacer-auto" />
        <label className="search-input">
          <Search size={14} strokeWidth={1.5} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search stats" />
        </label>
        <button type="button" className="btn btn-sm" onClick={exportCsv}><Download size={14} /> Export</button>
        {view === "domain" ? <ColumnsMenu cols={cols} /> : null}
      </div>

      <div className="table-wrap" style={{ opacity: loading ? 0.6 : 1, transition: "opacity 120ms" }}>
        <div className="table-scroll" style={{ maxHeight: "calc(100dvh - 250px)", minHeight: 280 }}>
          {view === "domain" ? (
            <table className="data-table is-main">
              <thead>
                <tr>
                  <SortTh k="name" sort={sort} onSort={sortBy}>{byClient ? "Client / domain" : "Domain"}</SortTh>
                  {showClient ? <SortTh k="client" sort={sort} onSort={sortBy}>Client</SortTh> : null}
                  {on("inboxes") ? <SortTh k="inboxes" sort={sort} onSort={sortBy} num className={gc("inboxes", on)}>Inboxes</SortTh> : null}
                  {on("usage") ? <SortTh k="usage" sort={sort} onSort={sortBy} num className={gc("usage", on)} title="Sent as a share of the inboxes' daily limits over the range">Used</SortTh> : null}
                  {on("sent") ? <SortTh k="sent" sort={sort} onSort={sortBy} num className={gc("sent", on)} title="Hover a number for the period before">Sent</SortTh> : null}
                  {on("replies") ? <SortTh k="replyRate" sort={sort} onSort={sortBy} num className={gc("replies", on)} title="Replies and reply rate; sorts by rate">Replies</SortTh> : null}
                  {on("human") ? <SortTh k="humanRate" sort={sort} onSort={sortBy} num className={gc("human", on)} title="Human replies and their rate; sorts by rate">Human</SortTh> : null}
                  {on("ooo") ? <SortTh k="ooo" sort={sort} onSort={sortBy} num className={gc("ooo", on)}>OOO</SortTh> : null}
                  {on("negative") ? <SortTh k="negative" sort={sort} onSort={sortBy} num className={gc("negative", on)}>Negative</SortTh> : null}
                  {on("bounces") ? <SortTh k="bounceRate" sort={sort} onSort={sortBy} num className={gc("bounces", on)} title="Bounces and bounce rate; sorts by rate">Bounces</SortTh> : null}
                  {on("reputation") ? <SortTh k="reputation" sort={sort} onSort={sortBy} num className={gc("reputation", on)}>Reputation</SortTh> : null}
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <Fragment key={g.key}>
                    {byClient ? (
                      <tr className="is-clickable inb-client st-client" aria-expanded={openClients.has(g.key)} onClick={() => toggleClient(g.key)}>
                        <td className="col-first" colSpan={showClient ? 2 : 1}>
                          <span className="flex items-center gap-2">
                            <ChevronRight size={14} className="flex-none text-faint transition-transform" style={{ transform: openClients.has(g.key) ? "rotate(90deg)" : undefined }} />
                            <span className="st-client-name">
                              <span className="st-cap">Client</span>
                              <ClientCell name={g.name ?? "No client"} hue={g.hue} />
                            </span>
                            <span className="st-count" title={`${g.rows.length} domain${g.rows.length === 1 ? "" : "s"}`}>{g.rows.length}</span>
                          </span>
                        </td>
                        <Cells r={{ ...total(g.rows), reputation: avgRep(g.rows) }} len={len} on={on} maxSent={maxClientSent} agg />
                      </tr>
                    ) : null}
                    {(!byClient || openClients.has(g.key)) && g.rows.map((r, i) => (
                      <tr key={r.id} className={r.sent ? undefined : "st-idle"}>
                        <td className="col-first" style={byClient ? { paddingLeft: 14 } : undefined}>
                          <span className="flex items-center gap-2">
                            <span className="st-n">{i + 1}</span>
                            <DomainLink id={r.id} tab="stats" className="strong hover:underline">{r.name}</DomainLink>
                            {/* Status only when it isn't the usual Active. */}
                            {r.status !== "active" ? <StatusDot status={r.status} /> : null}
                          </span>
                        </td>
                        {showClient ? <td><ClientCell name={r.clientName} hue={r.clientHue} /></td> : null}
                        <Cells r={r} len={len} on={on} maxSent={maxSent} />
                      </tr>
                    ))}
                    {byClient && openClients.has(g.key) ? <tr className="st-gap" aria-hidden><td colSpan={colCount} /></tr> : null}
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
                  <SortTh k="sent" sort={daySort} onSort={sortDay} num className="st-vol st-start">Sent</SortTh>
                  <th className="st-vol" style={{ width: 160 }}></th>
                  <SortTh k="replyRate" sort={daySort} onSort={sortDay} num className="st-rep st-start">Replies</SortTh>
                  <SortTh k="humanRate" sort={daySort} onSort={sortDay} num className="st-rep">Human</SortTh>
                  <SortTh k="ooo" sort={daySort} onSort={sortDay} num className="st-rep">OOO</SortTh>
                  <SortTh k="negative" sort={daySort} onSort={sortDay} num className="st-rep">Negative</SortTh>
                  <SortTh k="bounceRate" sort={daySort} onSort={sortDay} num className="st-bnc st-start">Bounces</SortTh>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d.day}>
                    <td className="col-first"><span className="strong">{nice(d.day)}</span> <span className="text-faint">{weekday(d.day)}</span></td>
                    <td className="is-num"><Z v={d.domains} /></td>
                    <td className="is-num st-vol st-start"><span className="strong text-ink"><Z v={d.sent} /></span></td>
                    <td className="st-vol"><span className="progress" style={{ width: 140 }}><span style={{ width: `${(100 * d.sent) / maxDay}%`, background: "color-mix(in srgb, var(--ink) 24%, transparent)" }} /></span></td>
                    <td className="is-num st-rep st-start"><Pair n={d.replies} of={d.sent} tone="st-v-rep" /></td>
                    <td className="is-num st-rep"><Pair n={d.human} of={d.sent} tone="st-v-hum" /></td>
                    <td className="is-num st-rep"><Z v={d.ooo} /></td>
                    <td className="is-num st-rep"><Z v={d.negative} /></td>
                    <td className="is-num st-bnc st-start"><Pair n={d.bounces} of={d.sent} digits={1} tone="st-v-bnc" warn={2} bad={3} /></td>
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
