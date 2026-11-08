"use client";

import { DomainLink } from "@/components/domains/DomainLink";
import { ArrowDown, ArrowLeftRight, ArrowUp, BarChart3, CalendarDays, ChevronRight, Copy, Download, Loader, Search, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Fragment, memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { loadReview, loadStats } from "@/app/actions";
import { ColumnsMenu, useColumns, type ColumnDef } from "@/components/Columns";
import { SortTh } from "@/components/SortTh";
import { keepTextUnselected, useRangeSelect } from "@/components/table-tools";
import { useSticky } from "@/lib/sticky";
import { ConfigureDomains, PasteSelect, WarmingButtons } from "@/components/domains/DomainBulk";
import { ReplaceDialog, type ReplaceTarget } from "@/components/domains/ReplaceDialog";
import { AdviceCell, DomainInsight, TrendTags } from "./DomainInsight";
import { Badge, ClientCell, Empty, Metric, Rep, StatusDot, TagList } from "@/components/ui";
import { clientDays, clientDaySheet, rr, type ClientDays, type DayFigures } from "@/lib/client-days";
import { ago, int } from "@/lib/format";
import { SlBadge } from "@/components/domains/SlStatus";
import { slState } from "@/lib/smartlead-state";
import type { ClientRow, StatDomain, StatsData } from "@/lib/queries";
import { VERDICT_META, VERDICT_ORDER, advise, judge, type Judged, type ReviewData, type Verdict } from "@/lib/review";
import { DOMAIN_STATUSES, canReplace } from "@/lib/status";
import { BAD_TRENDS, TREND_META, TREND_ORDER, trendWeight, trends as trendsOf, type Trend, type TrendKey } from "@/lib/trends";
import { PRESETS, addDays, daysBetween, matchPreset, nice, presetRange, previousLabel, weekday, type PresetKey } from "@/lib/range";

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

// `replies` counts every reply, out of office included; `slReplies` is
// Smartlead's own count, which leaves out-of-office replies out.
type Sums = { sent: number; replies: number; slReplies: number; human: number; ooo: number; negative: number; bounces: number };
const zero = (): Sums => ({ sent: 0, replies: 0, slReplies: 0, human: 0, ooo: 0, negative: 0, bounces: 0 });
const addInto = (a: Sums, b: Sums) => { a.sent += b.sent; a.replies += b.replies; a.slReplies += b.slReplies; a.human += b.human; a.ooo += b.ooo; a.negative += b.negative; a.bounces += b.bounces; };
type Row = StatDomain & Sums & { reputation: number | null; call: Judged | null; trends: Trend[] };
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

type SortKey = "name" | "status" | "call" | "advice" | "trend" | "client" | "sender" | "tags" | "esp" | "inboxes" | "usage" | "sent" | "replies" | "human" | "ooo" | "negative" | "bounces" | "replyRate" | "slRate" | "humanRate" | "bounceRate" | "reputation";
const sortValue = (r: Row, k: SortKey, len: number): string | number | null => {
  switch (k) {
    case "status": return DOMAIN_STATUSES.indexOf(r.status);
    case "client": return r.clientName?.toLowerCase() ?? null;
    case "sender": return r.senders[0]?.toLowerCase() ?? null;
    case "tags": return r.allTags[0]?.toLowerCase() ?? null;
    case "call": return r.call ? VERDICT_ORDER.indexOf(r.call.verdict) : null;
    // Worst first when sorted high to low: danger, then warning, then the rest.
    case "advice": { const a = r.call ? advise(r.call)[0] : null; return a ? ({ danger: 4, warning: 3, info: 2, faint: 1, success: 0 } as const)[a.tone] : null; }
    case "esp": return r.esp;
    case "trend": return r.trends.length ? trendWeight(r.trends) : null;
    case "replyRate": return rate(r.replies, r.sent);
    case "slRate": return rate(r.slReplies, r.sent);
    case "humanRate": return rate(r.human, r.sent);
    case "bounceRate": return rate(r.bounces, r.sent);
    case "usage": return r.capacity ? r.sent / (r.capacity * len) : null;
    default: return r[k];
  }
};
/** A client's value for a sort key, taken from its domains' totals, so clicking a header orders the clients too. */
const groupValue = (g: { name: string | null; rows: Row[]; t: Totals }, k: SortKey, len: number): string | number | null => {
  const t = g.t;
  switch (k) {
    case "name":
    case "client": return g.name?.toLowerCase() ?? null;
    case "status":
    case "sender":
    case "tags":
    case "call":
    case "advice":
    case "trend":
    case "esp": return null;
    case "replyRate": return rate(t.replies, t.sent);
    case "slRate": return rate(t.slReplies, t.sent);
    case "humanRate": return rate(t.human, t.sent);
    case "bounceRate": return rate(t.bounces, t.sent);
    case "usage": return t.capacity ? t.sent / (t.capacity * len) : null;
    case "reputation": return t.reputation ?? null;
    default: return t[k];
  }
};
type DayKey = "day" | "domains" | "sent" | "replies" | "human" | "ooo" | "negative" | "bounces" | "replyRate" | "slRate" | "humanRate" | "bounceRate";
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
  rep: ["slReplies", "replies", "human", "ooo", "negative"],
  bnc: ["bounces"],
  health: ["reputation"],
};
const NO_OOO_TITLE = "Smartlead's own reply count, which leaves out out-of-office replies; sorts by rate";
const WITH_OOO_TITLE = "Every reply, out of office and auto-replies included: any reply shows the email reached an inbox. Sorts by rate";
const GROUP_OF = Object.fromEntries(Object.entries(GROUPS).flatMap(([g, keys]) => keys.map((k) => [k, g])));
/** Class for a column: its group, plus a divider on the group's first visible column. */
const gc = (key: string, on: (k: string) => boolean) => {
  const g = GROUP_OF[key];
  return `st-${g}${GROUPS[g].find(on) === key ? " st-start" : ""}`;
};

const COLUMNS: ColumnDef[] = [
  { key: "client", label: "Client (when not grouped)" }, { key: "call", label: "Weekly review call", hidden: true }, { key: "trend", label: "Trend" }, { key: "sender", label: "Sender name" }, { key: "tags", label: "Tags", hidden: true }, { key: "esp", label: "ESP", hidden: true },
  { key: "inboxes", label: "Inboxes" }, { key: "usage", label: "Used" }, { key: "sent", label: "Sent" },
  { key: "slReplies", label: "Replies ex. OOO" }, { key: "replies", label: "Replies incl. OOO" },
  { key: "human", label: "Human" }, { key: "ooo", label: "Out of office", hidden: true }, { key: "negative", label: "Not interested", hidden: true },
  { key: "bounces", label: "Bounces" }, { key: "reputation", label: "Reputation" },
  { key: "advice", label: "Suggestion" },
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
function Cells({ r, len, on, agg = false }: { r: Totals; len: number; on: (k: string) => boolean; agg?: boolean }) {
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
        <td className={c("sent")} title={before}>
          {cap("Sum")}{r.sent ? <span className="strong text-ink">{int(r.sent)}</span> : <span className="zero">0</span>}
        </td>
      ) : null}
      {on("slReplies") ? <td className={c("slReplies")}>{cap("Sum")}<Pair n={r.slReplies} of={r.sent} tone="st-v-rep" /></td> : null}
      {on("replies") ? <td className={c("replies")}>{cap("Sum")}<Pair n={r.replies} of={r.sent} tone="st-v-rep" /></td> : null}
      {on("human") ? <td className={c("human")}>{cap("Sum")}<Pair n={r.human} of={r.sent} tone="st-v-hum" /></td> : null}
      {on("ooo") ? <td className={c("ooo")}>{cap("Sum")}<Z v={r.ooo} /></td> : null}
      {on("negative") ? <td className={c("negative")}>{cap("Sum")}<Z v={r.negative} /></td> : null}
      {on("bounces") ? <td className={c("bounces")}>{cap("Sum")}<Pair n={r.bounces} of={r.sent} digits={1} tone="st-v-bnc" warn={2} bad={3} /></td> : null}
      {on("reputation") ? <td className={c("reputation")}>{cap("Avg")}{r.reputation != null ? <Rep value={r.reputation} /> : <span className="zero">—</span>}</td> : null}
    </>
  );
}

/**
 * One domain's line, and its bounce panel when open. Memoised: ticking or
 * opening one row re-renders that row, not the whole table.
 */
const DomainRow = memo(function DomainRow({ r, i, byClient, showClient, showCall, on, len, colCount, from, to, selected, open, onPick, onToggle, onReplace }: {
  r: Row; i: number; byClient: boolean; showClient: boolean; showCall: boolean; on: (k: string) => boolean; len: number; colCount: number;
  from: string; to: string; selected: boolean; open: boolean;
  onPick: (id: string, e?: { shiftKey?: boolean }) => void; onToggle: (id: string) => void; onReplace: (id: string) => void;
}) {
  const replaceOk = canReplace(r.status, r.beingReplaced);
  return (
    <>
      <tr className={r.sent ? undefined : "st-idle"} data-selected={selected} data-open={open || undefined}>
        <td className="col-first" style={byClient ? { paddingLeft: 14 } : undefined}>
          <span className="flex items-center gap-2">
            <input type="checkbox" className="checkbox" aria-label={`Select ${r.name}`} checked={selected} onMouseDown={keepTextUnselected} onClick={(e) => onPick(r.id, e)} onChange={() => {}} />
            <button type="button" className="st-expand" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} bounce reasons and suggestions for ${r.name}`}
              title="Bounce reasons and what to do" onClick={() => onToggle(r.id)}>
              <ChevronRight size={13} style={{ transform: open ? "rotate(90deg)" : undefined }} />
            </button>
            <span className="st-n">{i + 1}</span>
            <DomainLink id={r.id} tab="stats" className="strong hover:underline">{r.name}</DomainLink>
            {/* Status only when it isn't the usual Active. */}
            {r.status !== "active" ? <StatusDot status={r.status} /> : null}
            <SlBadge c={r} quiet />
          </span>
        </td>
        {showClient ? <td><ClientCell name={r.clientName} hue={r.clientHue} /></td> : null}
        {showCall ? (
          <td title={r.call?.why}>
            {r.call ? <Badge tone={VERDICT_META[r.call.verdict].tone === "faint" ? undefined : VERDICT_META[r.call.verdict].tone}>{VERDICT_META[r.call.verdict].label}</Badge> : <span className="zero">—</span>}
          </td>
        ) : null}
        {on("trend") ? <td className="st-trend-cell"><TrendTags list={r.trends} max={3} /></td> : null}
        {on("sender") ? (
          <td className="truncate" style={{ maxWidth: 180 }} title={r.senders.join(", ") || undefined}>
            {r.senders.length ? <>{r.senders[0]}{r.senders.length > 1 ? <span className="text-faint"> +{r.senders.length - 1}</span> : null}</> : <span className="zero">—</span>}
          </td>
        ) : null}
        {on("tags") ? (
          <td title={r.allTags.join(", ") || undefined}>
            {r.allTags.length ? <span className="inline-flex items-center gap-1"><TagList tags={r.allTags} max={3} /></span> : <span className="zero">—</span>}
          </td>
        ) : null}
        {on("esp") ? <td className="text-muted text-[12px]">{r.esp ?? <span className="zero">—</span>}</td> : null}
        <Cells r={r} len={len} on={on} />
        {on("advice") ? <td className="st-start st-advice-cell"><AdviceCell call={r.call} /></td> : null}
      </tr>
      {open ? (
        <tr className="st-insight-row">
          <td colSpan={colCount}>
            <DomainInsight id={r.id} name={r.name} call={r.call} trends={r.trends} from={from} to={to} sent={r.sent} bounces={r.bounces}
              onReplace={replaceOk ? () => onReplace(r.id) : undefined}
              replaceNote={replaceOk ? undefined : r.beingReplaced ? "Already being replaced: follow it in Replacements" : "Only active or warming domains can be replaced"} />
          </td>
        </tr>
      ) : null}
    </>
  );
});

/**
 * Clients by day: dates across the top, each with Sent, RR (without out of
 * office, Smartlead's count) and RR incl. OOO, then the range's total.
 */
function ClientDayTable({ t }: { t: ReturnType<typeof clientDays> }) {
  if (!t.clients.length) return <Empty icon={BarChart3} title="Nothing sent in this range">Pick another range, or clear the client filter.</Empty>;
  const cells = (f: DayFigures | undefined, first: boolean, strong = false) => {
    const v = f ?? { sent: 0, slReplies: 0, replies: 0 };
    const r1 = rr(v.slReplies, v.sent), r2 = rr(v.replies, v.sent);
    return (
      <>
        <td className={`is-num${first ? " st-start" : ""}`} title={`${int(v.sent)} sent`}>{v.sent ? <span className={strong ? "strong text-ink" : undefined}>{int(v.sent)}</span> : <span className="zero">0</span>}</td>
        <td className="is-num st-rep" title={`${int(v.slReplies)} replies without out of office`}>{r1 == null ? <span className="zero">—</span> : `${r1.toFixed(2)}%`}</td>
        <td className="is-num st-rep" title={`${int(v.replies)} replies, out of office included`}>{r2 == null ? <span className="zero">—</span> : `${r2.toFixed(2)}%`}</td>
      </>
    );
  };
  const row = (c: ClientDays, total = false) => (
    <tr key={c.key} className={total ? "inb-client" : undefined}>
      <td className="col-first">{total ? <span className="strong">Grand total</span> : <ClientCell name={c.name} hue={c.hue} />}</td>
      {t.days.map((d) => <Fragment key={d}>{cells(c.days[d], true, total)}</Fragment>)}
      {cells(c.total, true, true)}
    </tr>
  );
  return (
    <table className="data-table is-main st-cd">
      <thead>
        <tr>
          <th rowSpan={2} className="col-first">Client</th>
          {t.days.map((d) => <th key={d} colSpan={3} className="st-start st-cd-day">{nice(d)} <span className="text-faint">{weekday(d)}</span></th>)}
          <th colSpan={3} className="st-start st-cd-day">Total</th>
        </tr>
        <tr>
          {[...t.days, "total"].map((d) => (
            <Fragment key={d}>
              <th className="is-num st-start st-vol">Sent</th>
              <th className="is-num st-rep" title={NO_OOO_TITLE.replace("; sorts by rate", "")}>RR</th>
              <th className="is-num st-rep" title={WITH_OOO_TITLE.replace(" Sorts by rate", "")}>RR incl. OOO</th>
            </Fragment>
          ))}
        </tr>
      </thead>
      <tbody>
        {t.clients.map((c) => row(c))}
        {row(t.total, true)}
      </tbody>
    </table>
  );
}

function download(name: string, head: string[], lines: unknown[][]) {
  const esc = (v: unknown) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const url = URL.createObjectURL(new Blob([[head.join(","), ...lines.map((l) => l.map(esc).join(","))].join("\n")], { type: "text/csv" }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------

// The weekly review's calls that ask for action; Idle, too little sent and OK don't.
const ATTENTION: Verdict[] = ["fix", "rest", "drop", "dead", "watch"];
type CallFilter = "" | "attention" | Verdict;
type Facet = "call" | "tag" | "esp" | "sender" | "sl" | "trend";
/** "bad" is any tag that asks for a look: no reply for days, replies or reputation down, bounces up. */
type TrendFilter = "" | "bad" | TrendKey;
/** Smartlead now: "in" leaves out domains deleted there, the default. */
type SlFilter = "in" | "live" | "disconnected" | "deleted" | "all";
const SL_FILTERS: [SlFilter, string][] = [["in", "In Smartlead now"], ["live", "All inboxes live"], ["disconnected", "Some disconnected"], ["deleted", "Deleted in Smartlead"], ["all", "All, deleted included"]];
const slMatches = (d: StatDomain, f: SlFilter) => {
  const st = slState(d);
  return f === "all" || (f === "in" ? st !== "deleted" : f === "live" ? st === "live" : f === "disconnected" ? st === "partial" || st === "disconnected" : st === "deleted");
};

export function StatsView({ initial, initialReview, clients }: { initial: StatsData; initialReview: ReviewData; clients: ClientRow[] }) {
  const [data, setData] = useState(initial);
  const [review, setReview] = useState(initialReview);
  const [preset, setPreset] = useState<PresetKey>(() => matchPreset(initial.from, initial.to, initial.today));
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const params = useSearchParams();
  const [view, setView] = useState<"domain" | "day" | "clients">(() => (params.get("view") === "clients" ? "clients" : "domain"));
  // Filters stay while you move between tabs and pages; Clear resets them. A link's ?client=,
  // ?tag=, ?esp=, ?sender=, ?status=, ?sl= or ?call= opens the page filtered and wins.
  const [q, setQ] = useSticky("stats:q", "");
  const [clientId, setClientId] = useSticky("stats:client", "", params.get("client"));
  const [onlySending, setOnlySending] = useSticky("stats:sending", true);
  const urlCall = params.get("call");
  const [call, setCall] = useSticky<CallFilter>("stats:call", "", urlCall === "attention" || VERDICT_ORDER.includes(urlCall as Verdict) ? (urlCall as CallFilter) : null);
  const [tag, setTag] = useSticky("stats:tag", "", params.get("tag")?.toLowerCase() ?? null);
  const [esp, setEsp] = useSticky("stats:esp", "", params.get("esp"));
  const [sender, setSender] = useSticky("stats:sender", "", params.get("sender"));
  // Active today (grace period included), or finished: disconnected, replaced, cancelled, expired.
  const urlStatus = params.get("status");
  const [standing, setStanding] = useSticky<"current" | "ended" | "all">("stats:status", "current", urlStatus === "ended" || urlStatus === "all" ? urlStatus : null);
  // One line per client to start; open a client to see its domains.
  const [byClient, setByClient] = useSticky("stats:by-client", true);
  const urlSl = params.get("sl");
  const [sl, setSl] = useSticky<SlFilter>("stats:sl", "in", SL_FILTERS.some(([k]) => k === urlSl) ? urlSl as SlFilter : null);
  const urlTrend = params.get("trend");
  const [trend, setTrend] = useSticky<TrendFilter>("stats:trend", "", urlTrend === "bad" || TREND_ORDER.includes(urlTrend as TrendKey) ? (urlTrend as TrendFilter) : null);
  // The domains the Replace window is open for.
  const [replaceIds, setReplaceIds] = useState<string[] | null>(null);
  const [openClients, setOpenClients] = useState<Set<string>>(new Set());
  // Domains opened to show their bounces and what to do.
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleClient = (key: string) => setOpenClients((s0) => { const n = new Set(s0); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const [sort, setSort] = useSticky<{ key: SortKey; dir: 1 | -1 }>("stats:sort", { key: "sent", dir: -1 });
  const [daySort, setDaySort] = useState<{ key: DayKey; dir: 1 | -1 }>({ key: "day", dir: -1 });
  const [loading, start] = useTransition();
  const cols = useColumns("stats", COLUMNS);
  const on = cols.on;

  const load = (f: string, t: string) => start(async () => {
    const [r, rv] = await Promise.all([loadStats({ from: f, to: t }), loadReview({ from: f, to: t })]);
    if (r.ok) setData(r.data); else toast.error(r.error);
    if (rv.ok) setReview(rv.data); else toast.error(rv.error);
  });
  const pick = (k: PresetKey) => {
    setPreset(k);
    const range = presetRange(k, data.today);
    if (range) { setFrom(range[0]); setTo(range[1]); load(range[0], range[1]); }
  };

  const len = daysBetween(data.from, data.to);
  // Typing in search stays smooth: the table catches up a frame later.
  const needle = useDeferredValue(q).trim().toLowerCase();
  // The weekly review's call on each domain, for the same range.
  const calls = useMemo(() => new Map(review.domains.map((d) => [d.id, judge(d)])), [review]);
  // Every domain's totals, reputation, call and trends, worked out once per
  // load: filters, sorting and opening rows only pick from this.
  const base = useMemo(() => {
    const byId = new Map<string, Row>(data.domains.map((d) => [d.id, { ...d, ...zero(), reputation: null, call: calls.get(d.id) ?? null, trends: [] }]));
    const reps = new Map<string, [number, number]>();
    for (const x of data.days) {
      const r = byId.get(x.d);
      if (!r) continue;
      addInto(r, x);
      if (x.rep != null) { const a = reps.get(x.d) ?? [0, 0]; a[0] += x.rep; a[1]++; reps.set(x.d, a); }
    }
    for (const [id, [sum, n]] of reps) byId.get(id)!.reputation = sum / n;
    for (const r of byId.values()) {
      r.trends = trendsOf({
        sent: r.sent, replies: r.replies, bounces: r.bounces, prevSent: r.prevSent, prevReplies: r.prevReplies, prevBounces: r.prevBounces,
        rep: r.reputation, prevRep: r.prevRep, quietDays: r.call?.quietDays ?? null, neverReplied: r.call?.neverReplied ?? false, sentSinceReply: r.call?.sentSinceReply ?? 0,
      }, len);
    }
    return byId;
  }, [data.domains, data.days, calls, len]);
  // Sent in the range. "Sending only" hides the rest, except while picking a
  // review call, which can be about domains that sent nothing (disconnected).
  const sentIn = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of data.days) m.set(x.d, (m.get(x.d) ?? 0) + x.sent);
    return m;
  }, [data.days]);
  const { visible, options } = useMemo(() => {
    const trendMatches = (list: Trend[]) => !trend || list.some((x) => (trend === "bad" ? BAD_TRENDS.includes(x.key) : x.key === trend));
    const callMatches = (j: Judged | undefined) => !call || (!!j && (call === "attention" ? ATTENTION.includes(j.verdict) : j.verdict === call));
    // Every filter but the one skipped, so each menu counts what picking an option would leave.
    const passes = (d: StatDomain, skip?: Facet) =>
      (!clientId || d.clientId === clientId) &&
      (standing === "all" || (standing === "current") === d.current) &&
      (skip === "call" || callMatches(calls.get(d.id))) &&
      (skip === "tag" || !tag || d.allTags.some((t) => t.toLowerCase() === tag)) &&
      (skip === "esp" || !esp || (d.esp ?? "") === esp) &&
      (skip === "sender" || !sender || d.senders.includes(sender)) &&
      (skip === "sl" || slMatches(d, sl)) &&
      (skip === "trend" || trendMatches(base.get(d.id)?.trends ?? [])) &&
      (!needle || d.name.includes(needle) || !!d.clientName?.toLowerCase().includes(needle) || d.allTags.some((t) => t.toLowerCase().includes(needle)) ||
        d.senders.some((s) => s.toLowerCase().includes(needle)));
    const sendingOk = (d: StatDomain, skip?: Facet) => !onlySending || skip === "call" || !!call || (sentIn.get(d.id) ?? 0) > 0;
    const count = (skip: Facet, keys: (d: StatDomain) => string[]) => {
      const m = new Map<string, number>();
      for (const d of data.domains) if (passes(d, skip) && sendingOk(d, skip)) for (const k of new Set(keys(d))) m.set(k, (m.get(k) ?? 0) + 1);
      return m;
    };
    // Tags match whatever their case, shown as first seen.
    const tags = new Map<string, { label: string; n: number }>();
    for (const d of data.domains) {
      if (!passes(d, "tag") || !sendingOk(d)) continue;
      for (const t of new Set(d.allTags)) {
        const k = t.toLowerCase(), e = tags.get(k);
        tags.set(k, { label: e?.label ?? t, n: (e?.n ?? 0) + 1 });
      }
    }
    const verdicts = count("call", (d) => { const j = calls.get(d.id); return j ? [j.verdict] : []; });
    const trendCounts = count("trend", (d) => { const l = base.get(d.id)?.trends ?? []; return [...l.map((x) => x.key as string), ...(l.some((x) => BAD_TRENDS.includes(x.key)) ? ["bad"] : [])]; });
    return {
      visible: data.domains.filter((d) => passes(d)),
      options: {
        verdicts,
        trends: trendCounts,
        attention: ATTENTION.reduce((a, x) => a + (verdicts.get(x) ?? 0), 0),
        tags: [...tags].sort((a, b) => a[1].label.localeCompare(b[1].label)),
        esps: [...count("esp", (d) => [d.esp ?? ""])].sort((a, b) => a[0].localeCompare(b[0])),
        senders: [...count("sender", (d) => d.senders)].sort((a, b) => a[0].localeCompare(b[0])),
        sl: new Map(SL_FILTERS.map(([k]) => [k, data.domains.filter((d) => passes(d, "sl") && sendingOk(d, "sl") && slMatches(d, k)).length])),
      },
    };
  }, [data.domains, clientId, standing, needle, call, calls, tag, esp, sender, sl, trend, base, sentIn, onlySending]);
  const filtering = !!(call || tag || esp || sender || trend || sl !== "in");
  const clearFilters = () => { setCall(""); setTag(""); setEsp(""); setSender(""); setTrend(""); setSl("in"); };

  const rows = useMemo(() => {
    // Each row's sort value is worked out once, not on every comparison.
    const keyed = visible.map((d) => base.get(d.id)!).filter((r) => !onlySending || !!call || r.sent > 0).map((r) => ({ r, v: sortValue(r, sort.key, len) }));
    keyed.sort((a, b) => cmp(a.v, b.v, sort.dir) || a.r.name.localeCompare(b.r.name));
    return keyed.map((x) => x.r);
  }, [visible, base, onlySending, call, sort, len]);

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
      k === "replyRate" ? rate(r.replies, r.sent) : k === "slRate" ? rate(r.slReplies, r.sent) : k === "humanRate" ? rate(r.human, r.sent) : k === "bounceRate" ? rate(r.bounces, r.sent) : r[k];
    return [...map.values()].sort((a, b) => cmp(v(a, daySort.key), v(b, daySort.key), daySort.dir) || b.day.localeCompare(a.day));
  }, [visible, data.days, data.from, len, daySort]);

  const groups = useMemo(() => {
    if (!byClient) return [{ key: "all", name: null as string | null, hue: null as number | null, rows, t: null as Totals | null }];
    const map = new Map<string, { key: string; name: string | null; hue: number | null; rows: Row[] }>();
    for (const r of rows) {
      const k = r.clientId ?? "none";
      const g = map.get(k) ?? { key: k, name: r.clientName, hue: r.clientHue, rows: [] };
      g.rows.push(r);
      map.set(k, g);
    }
    // A client's totals once, for its summary row and for sorting.
    const list = [...map.values()].map((g) => ({ ...g, t: { ...total(g.rows), reputation: avgRep(g.rows) } as Totals }));
    const v = new Map(list.map((g) => [g.key, groupValue(g, sort.key, len)]));
    return list.sort((a, b) => cmp(v.get(a.key)!, v.get(b.key)!, sort.dir) || (a.name ?? "").localeCompare(b.name ?? ""));
  }, [rows, byClient, sort, len]);
  // Shift-click picks every domain between two, in the order they're shown.
  const shownIds = useMemo(() => groups.flatMap((g) => (!byClient || openClients.has(g.key) ? g.rows.map((r) => r.id) : [])), [groups, byClient, openClients]);
  const pickRow = useRangeSelect(shownIds, setSelected);

  const perClient = useMemo(() => clientDays(visible, data.days), [visible, data.days]);
  const copyClients = () => {
    navigator.clipboard.writeText(clientDaySheet(perClient)).then(
      () => toast.success(`Copied ${perClient.clients.length} client${perClient.clients.length === 1 ? "" : "s"} × ${perClient.days.length} day${perClient.days.length === 1 ? "" : "s"}: paste into Google Sheets`),
      () => toast.error("Couldn't copy: the browser blocked the clipboard"),
    );
  };

  const t = useMemo(() => total(rows), [rows]);
  const showClient = !byClient && on("client");
  const showCall = on("call") || !!call;
  const colCount = 1 + (showClient ? 1 : 0) + (showCall ? 1 : 0) + COLUMNS.filter((c) => c.key !== "client" && c.key !== "call" && on(c.key)).length;
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const allOpen = byClient && groups.length > 0 && groups.every((g) => openClients.has(g.key));
  const toggleAll = () => setOpenClients(allOpen ? new Set() : new Set(groups.map((g) => g.key)));
  const maxDay = Math.max(1, ...days.map((d) => d.sent));
  const sortBy = (key: SortKey) => setSort((s) => flip(s, key, key === "name" || key === "client" || key === "status"));
  const sortDay = (key: DayKey) => setDaySort((s) => flip(s, key, false));
  const rangeLabel = data.from === data.to ? nice(data.from) : `${nice(data.from)} – ${nice(data.to)}`;

  const toggleRow = useCallback((id: string) => setOpenRows((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);
  const openReplace = useCallback((id: string) => setReplaceIds([id]), []);
  // Replace takes active or warming domains that aren't already being replaced (the server's rule too).
  const replaceable = useMemo(() => selectedRows.filter((r) => canReplace(r.status, r.beingReplaced)), [selectedRows]);
  const replaceTargets = useMemo<ReplaceTarget[]>(() => (replaceIds ?? []).flatMap((id) => {
    const d = base.get(id);
    return d ? [{ id, name: d.name, tld: d.tld, clientName: d.clientName, clientHue: d.clientHue }] : [];
  }), [replaceIds, base]);
  // The reason the window starts on: bounces when that's what's wrong, otherwise "other".
  const replaceReason = useMemo(() => {
    const list = replaceIds ?? [];
    return list.some((id) => (base.get(id)?.trends ?? []).some((x) => x.key === "bouncesUp") || (base.get(id)?.bounces ?? 0) / Math.max(1, base.get(id)?.sent ?? 0) >= 0.03) ? "high_bounce" as const : "other" as const;
  }, [replaceIds, base]);
  // A started replacement changes the domains' state: fetch the range again.
  const reloadSoon = () => load(data.from, data.to);

  // The bounce panel under a row is as wide as the visible table, not the whole scrolling one.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => el.style.setProperty("--st-w", `${el.clientWidth}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const exportCsv = () => {
    if (view === "clients") {
      // The sheet's two header rows: dates, then the column names.
      const [dates, ...lines] = clientDaySheet(perClient).split("\n").map((l) => l.split("\t"));
      download(`stats-clients-by-day-${data.from}-${data.to}.csv`, dates, lines);
    } else if (view === "day") {
      download(`stats-by-day-${data.from}-${data.to}.csv`, ["day", "domains_sending", "sent", "replies_ex_ooo", "replies_incl_ooo", "human", "ooo", "negative", "bounces"],
        [...days].sort((a, b) => a.day.localeCompare(b.day)).map((d) => [d.day, d.domains, d.sent, d.slReplies, d.replies, d.human, d.ooo, d.negative, d.bounces]));
    } else {
      const fx = (v: number | null) => (v == null ? "" : v.toFixed(2));
      download(`stats-by-domain-${data.from}-${data.to}.csv`, ["domain", "status", "review_call", "client", "sender", "tags", "esp", "inboxes", "capacity_per_day", "sent", "replies_ex_ooo", "replies_incl_ooo", "human", "ooo", "negative", "bounces", "reply_rate_ex_ooo", "reply_rate_incl_ooo", "human_rate", "bounce_rate", "reputation"],
        rows.map((r) => [r.name, r.status, r.call ? VERDICT_META[r.call.verdict].label : "", r.clientName, r.senders.join(", "), r.allTags.join("; "), r.esp, r.inboxes, r.capacity, r.sent, r.slReplies, r.replies, r.human, r.ooo, r.negative, r.bounces,
          fx(rate(r.slReplies, r.sent)), fx(rate(r.replies, r.sent)), fx(rate(r.human, r.sent)), fx(rate(r.bounces, r.sent)), fx(r.reputation)]));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <section className="stats" aria-label="Totals">
        <div className="stat"><span className="stat-label">Sent · {rangeLabel}</span><span className="stat-value">{int(t.sent)}</span><span className="stat-foot">{t.prevSent ? <>vs {int(t.prevSent)} {previousLabel(data.from, data.to)}<Delta now={t.sent} before={t.prevSent} /></> : `${int(Math.round(t.sent / len))} a day on average`}</span></div>
        <div className="stat"><span className="stat-label">Reply rate incl. OOO</span><span className="stat-value">{rate(t.replies, t.sent)?.toFixed(2) ?? "—"}%</span><span className="stat-foot" title={NO_OOO_TITLE.replace("; sorts by rate", "")}>{int(t.replies)} replies · {rate(t.slReplies, t.sent)?.toFixed(2) ?? "0.00"}% ex. OOO<Delta now={rate(t.replies, t.sent)} before={rate(t.prevReplies, t.prevSent)} points /></span></div>
        <div className="stat"><span className="stat-label">Human replies</span><span className="stat-value">{int(t.human)}</span><span className="stat-foot">{rate(t.human, t.sent)?.toFixed(2) ?? "0.00"}% of sent · {int(t.negative)} not interested</span></div>
        <div className="stat"><span className="stat-label">Bounce rate</span><span className="stat-value">{rate(t.bounces, t.sent)?.toFixed(1) ?? "—"}%</span><span className="stat-foot">{int(t.bounces)} bounces<Delta now={rate(t.bounces, t.sent)} before={rate(t.prevBounces, t.prevSent)} points invert /></span></div>
      </section>

      <div className="table-bar">
        <div className="view-tabs" role="tablist" aria-label="View">
          <button type="button" role="tab" aria-selected={view === "domain"} className={view === "domain" ? "is-on" : undefined} onClick={() => setView("domain")}>By domain <span>{int(rows.length)}</span></button>
          <button type="button" role="tab" aria-selected={view === "day"} className={view === "day" ? "is-on" : undefined} onClick={() => setView("day")}>By day <span>{len}</span></button>
          <button type="button" role="tab" aria-selected={view === "clients"} className={view === "clients" ? "is-on" : undefined} onClick={() => setView("clients")}>Clients by day <span>{perClient.clients.length}</span></button>
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
        <select className="select rv-filter" data-on={clientId ? true : undefined} value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Filter by client">
          <option value="">All clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="select rv-filter" data-on={standing !== "current" ? true : undefined} value={standing} onChange={(e) => setStanding(e.target.value as "current" | "ended" | "all")} aria-label="Which domains"
          title="Active includes domains in their grace period">
          <option value="current">Active domains</option>
          <option value="ended">Disconnected or replaced</option>
          <option value="all">All domains</option>
        </select>
        <select className="select rv-filter" data-on={call ? true : undefined} value={call} onChange={(e) => setCall(e.target.value as CallFilter)} aria-label="Filter by weekly review call"
          title="The weekly review's call for this range. Picking one also shows domains that sent nothing">
          <option value="">All review calls</option>
          <option value="attention">Needs attention ({options.attention})</option>
          {VERDICT_ORDER.map((x) => <option key={x} value={x}>{VERDICT_META[x].label} ({options.verdicts.get(x) ?? 0})</option>)}
        </select>
        <select className="select rv-filter" data-on={trend ? true : undefined} value={trend} onChange={(e) => setTrend(e.target.value as TrendFilter)} aria-label="Filter by trend"
          title="Against the same number of days before: replies, bounces and warmup reputation going up or down, and days without a reply">
          <option value="">All trends</option>
          <option value="bad">Getting worse ({options.trends.get("bad") ?? 0})</option>
          {TREND_ORDER.map((k) => <option key={k} value={k}>{TREND_META[k].label} ({options.trends.get(k) ?? 0})</option>)}
        </select>
        <select className="select rv-filter" data-on={tag ? true : undefined} value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Filter by tag">
          <option value="">All tags</option>
          {options.tags.map(([k, x]) => <option key={k} value={k}>{x.label} ({x.n})</option>)}
        </select>
        <select className="select rv-filter" data-on={esp ? true : undefined} value={esp} onChange={(e) => setEsp(e.target.value)} aria-label="Filter by ESP">
          <option value="">All ESPs</option>
          {options.esps.map(([k, n]) => <option key={k} value={k}>{k || "No ESP"} ({n})</option>)}
        </select>
        <select className="select rv-filter" data-on={sender ? true : undefined} value={sender} onChange={(e) => setSender(e.target.value)} aria-label="Filter by sender name">
          <option value="">All senders</option>
          {options.senders.map(([k, n]) => <option key={k} value={k}>{k} ({n})</option>)}
        </select>
        <select className="select rv-filter" data-on={sl !== "in" ? true : undefined} value={sl} onChange={(e) => setSl(e.target.value as SlFilter)} aria-label="Filter by Smartlead status"
          title={`Connected, disconnected or deleted in Smartlead now${data.slSyncedAt ? `, as of the sync ${ago(data.slSyncedAt)}` : ""}. Deleted domains are left out unless you pick them`}>
          {SL_FILTERS.map(([k, label]) => <option key={k} value={k}>{label} ({options.sl.get(k) ?? 0})</option>)}
        </select>
        {filtering ? <button type="button" className="btn btn-sm" onClick={clearFilters}>Clear filters</button> : null}
        {view === "domain" ? (
          <>
            <label className="flex items-center gap-1.5 text-[12.5px] text-muted" title="Only domains that sent at least one email in this range"><input type="checkbox" className="checkbox" checked={onlySending} onChange={(e) => setOnlySending(e.target.checked)} /> Sending only</label>
            <label className="flex items-center gap-1.5 text-[12.5px] text-muted"><input type="checkbox" className="checkbox" checked={byClient} onChange={(e) => setByClient(e.target.checked)} /> By client</label>
            {byClient ? <button type="button" className="btn btn-sm" onClick={toggleAll}>{allOpen ? "Collapse all" : "Expand all"}</button> : null}
          </>
        ) : null}
        <span className="spacer-auto" />
        <label className="search-input">
          <Search size={14} strokeWidth={1.5} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search stats" />
        </label>
        {view === "clients" ? <button type="button" className="btn btn-sm" onClick={copyClients} disabled={!perClient.clients.length}><Copy size={14} /> Copy for Sheets</button> : null}
        <button type="button" className="btn btn-sm" onClick={exportCsv}><Download size={14} /> Export</button>
        {view === "domain" ? (
          <>
            <PasteSelect rows={data.domains} selected={selected} where="in this range"
              onSelect={(s) => { setSelected(s); clearFilters(); setQ(""); setOnlySending(false); setByClient(false); }} />
            <ColumnsMenu cols={cols} />
          </>
        ) : null}
      </div>

      <div className="table-wrap" style={{ opacity: loading ? 0.6 : 1, transition: "opacity 120ms" }}>
        <div className="table-scroll" ref={scrollRef} style={{ maxHeight: "calc(100dvh - 250px)", minHeight: 280 }}>
          {view === "domain" ? (
            <table className="data-table is-main">
              <thead>
                <tr>
                  <th aria-sort={sort.key === "name" ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
                    <span className="flex items-center gap-2">
                      <input type="checkbox" className="checkbox" aria-label="Select all" checked={allSelected}
                        onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} />
                      <button type="button" className="sort-head" onClick={() => sortBy("name")}>
                        {byClient ? "Client / domain" : "Domain"}
                        {sort.key === "name" ? (sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : null}
                      </button>
                    </span>
                  </th>
                  {showClient ? <SortTh k="client" sort={sort} onSort={sortBy}>Client</SortTh> : null}
                  {showCall ? <SortTh k="call" sort={sort} onSort={sortBy} title="The weekly review's call for this range; hover a call for why">Call</SortTh> : null}
                  {on("trend") ? <SortTh k="trend" sort={sort} onSort={sortBy} title="Days without a reply, and replies, bounces and warmup reputation against the same number of days before. Hover a tag for the numbers">Trend</SortTh> : null}
                  {on("sender") ? <SortTh k="sender" sort={sort} onSort={sortBy} title="Sender names on the domain's connected inboxes">Sender</SortTh> : null}
                  {on("tags") ? <SortTh k="tags" sort={sort} onSort={sortBy} title="The domain's tags and the Smartlead tags on its inboxes">Tags</SortTh> : null}
                  {on("esp") ? <SortTh k="esp" sort={sort} onSort={sortBy}>ESP</SortTh> : null}
                  {on("inboxes") ? <SortTh k="inboxes" sort={sort} onSort={sortBy} num className={gc("inboxes", on)}>Inboxes</SortTh> : null}
                  {on("usage") ? <SortTh k="usage" sort={sort} onSort={sortBy} num className={gc("usage", on)} title="Sent as a share of the inboxes' daily limits over the range">Used</SortTh> : null}
                  {on("sent") ? <SortTh k="sent" sort={sort} onSort={sortBy} num className={gc("sent", on)} title="Hover a number for the period before">Sent</SortTh> : null}
                  {on("slReplies") ? <SortTh k="slRate" sort={sort} onSort={sortBy} num className={gc("slReplies", on)} title={NO_OOO_TITLE}>Replies ex. OOO</SortTh> : null}
                  {on("replies") ? <SortTh k="replyRate" sort={sort} onSort={sortBy} num className={gc("replies", on)} title={WITH_OOO_TITLE}>Replies incl. OOO</SortTh> : null}
                  {on("human") ? <SortTh k="humanRate" sort={sort} onSort={sortBy} num className={gc("human", on)} title="Human replies and their rate; sorts by rate">Human</SortTh> : null}
                  {on("ooo") ? <SortTh k="ooo" sort={sort} onSort={sortBy} num className={gc("ooo", on)}>OOO</SortTh> : null}
                  {on("negative") ? <SortTh k="negative" sort={sort} onSort={sortBy} num className={gc("negative", on)}>Negative</SortTh> : null}
                  {on("bounces") ? <SortTh k="bounceRate" sort={sort} onSort={sortBy} num className={gc("bounces", on)} title="Bounces and bounce rate; sorts by rate">Bounces</SortTh> : null}
                  {on("reputation") ? <SortTh k="reputation" sort={sort} onSort={sortBy} num className={gc("reputation", on)}>Reputation</SortTh> : null}
                  {on("advice") ? <SortTh k="advice" sort={sort} onSort={sortBy} className="st-start" title="What to do, from the weekly review's call and the bounces. Click a domain's arrow for its bounce reasons">Suggestion</SortTh> : null}
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
                        {showCall ? <td /> : null}
                        {on("trend") ? <td /> : null}
                        {on("sender") ? <td /> : null}
                        {on("tags") ? <td /> : null}
                        {on("esp") ? <td /> : null}
                        <Cells r={g.t ?? total(g.rows)} len={len} on={on} agg />
                        {on("advice") ? <td className="st-start" /> : null}
                      </tr>
                    ) : null}
                    {(!byClient || openClients.has(g.key)) && g.rows.map((r, i) => (
                      <DomainRow key={r.id} r={r} i={i} byClient={byClient} showClient={showClient} showCall={showCall} on={on} len={len} colCount={colCount}
                        from={data.from} to={data.to} selected={selected.has(r.id)} open={openRows.has(r.id)} onPick={pickRow} onToggle={toggleRow} onReplace={openReplace} />
                    ))}
                    {byClient && openClients.has(g.key) ? <tr className="st-gap" aria-hidden><td colSpan={colCount} /></tr> : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          ) : view === "clients" ? (
            <ClientDayTable t={perClient} />
          ) : (
            <table className="data-table is-main">
              <thead>
                <tr>
                  <SortTh k="day" sort={daySort} onSort={sortDay}>Day</SortTh>
                  <SortTh k="domains" sort={daySort} onSort={sortDay} num>Domains sending</SortTh>
                  <SortTh k="sent" sort={daySort} onSort={sortDay} num className="st-vol st-start">Sent</SortTh>
                  <th className="st-vol" style={{ width: 160 }}></th>
                  <SortTh k="slRate" sort={daySort} onSort={sortDay} num className="st-rep st-start" title={NO_OOO_TITLE}>Replies ex. OOO</SortTh>
                  <SortTh k="replyRate" sort={daySort} onSort={sortDay} num className="st-rep" title={WITH_OOO_TITLE}>Replies incl. OOO</SortTh>
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
                    <td className="is-num st-rep st-start"><Pair n={d.slReplies} of={d.sent} tone="st-v-rep" /></td>
                    <td className="is-num st-rep"><Pair n={d.replies} of={d.sent} tone="st-v-rep" /></td>
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
          {view === "domain" ? <span><b>{int(rows.length)}</b> domains</span>
            : view === "clients" ? <span><b>{perClient.clients.length}</b> clients · <b>{perClient.days.length}</b> days with sends</span>
            : <span><b>{len}</b> days</span>}
          <span><b>{int(t.sent)}</b> sent</span>
          <span><b>{int(t.replies)}</b> replies</span>
          <span><b>{int(t.human)}</b> human</span>
          <span><b>{rate(t.bounces, t.sent)?.toFixed(1) ?? "0.0"}%</b> bounce</span>
        </div>
      </div>

      {view === "domain" && selected.size > 0 ? (
        <div className="bulk-bar" role="toolbar" aria-label="Selected domains">
          <span className="bulk-count">{selected.size} selected</span>
          <button type="button" className="btn btn-sm btn-primary" disabled={!replaceable.length}
            title={replaceable.length ? "Swap the selected domains for free ones from storage" : "Only active or warming domains that aren't already being replaced"}
            onClick={() => setReplaceIds(replaceable.map((d) => d.id))}>
            <ArrowLeftRight size={14} /> Replace{replaceable.length && replaceable.length !== selected.size ? ` (${int(replaceable.length)})` : ""}
          </button>
          <ConfigureDomains domainIds={[...selected]} />
          <WarmingButtons rows={data.domains.filter((d) => selected.has(d.id))} onDone={() => setSelected(new Set())} />
          <span className="sep" />
          <button type="button" className="btn btn-sm" onClick={() => setOpenRows(new Set(selectedRows.map((r) => r.id)))}><ChevronRight size={14} /> Show reasons</button>
          <button type="button" className="btn btn-sm" onClick={() => {
            const names = data.domains.filter((d) => selected.has(d.id)).map((d) => d.name).join("\n");
            navigator.clipboard.writeText(names).then(() => toast.success(`Copied ${selected.size} domain${selected.size === 1 ? "" : "s"}`), () => toast.error("Couldn't copy"));
          }}><Copy size={14} /> Copy</button>
          <span className="sep" />
          <button type="button" className="btn btn-sm" aria-label="Clear selection" onClick={() => setSelected(new Set())}><X size={14} /></button>
        </div>
      ) : null}

      <ReplaceDialog open={replaceIds !== null} onOpenChange={(o) => { if (!o) setReplaceIds(null); }} targets={replaceTargets} defaultReason={replaceReason}
        onDone={() => { setSelected(new Set()); reloadSoon(); }} />
    </div>
  );
}
