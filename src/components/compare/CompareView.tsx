"use client";

import { DomainLink } from "@/components/domains/DomainLink";
import { Check, ChevronRight, Columns2, X } from "lucide-react";
import { Fragment, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { loadReview } from "@/app/actions";
import { RangePicker } from "@/components/RangePicker";
import { SortTh } from "@/components/SortTh";
import { Empty, Rep } from "@/components/ui";
import { BOUNCE_META, BOUNCE_ORDER, CAUSE_COLOR } from "@/lib/bounces";
import { DIMS, DIM_META, MIN_SENT, bounceMix, groupsBy, keysOf, pct, summarize, type Dim, type Group } from "@/lib/compare";
import { int } from "@/lib/format";
import { nice, previousLabel } from "@/lib/range";
import { espName, isCurrent, type ReviewData, type ReviewDomain } from "@/lib/review";
import { Findings } from "./Findings";

// Compare domains by TLD, provider, ESP, tag, client or age: every number that
// matters in one table, what stands out above it, and any two groups (each with
// its own dates) head to head below it.

type Scope = "current" | "ended";
type SortKey = "label" | "domains" | "age" | "rep" | "sent" | "replies" | "real" | "human" | "ooo" | "negative" | "bounces" | "spam";
const rateOf = (g: Group, k: "replies" | "real" | "human" | "bounces" | "spam") => pct(g[k], g.sent);
const P = (v: number | null, digits = 2) => (v == null ? "—" : `${v.toFixed(digits)}%`);
const days = (v: number | null) => (v == null ? "—" : v >= 365 ? `${(v / 365).toFixed(1)}y` : `${Math.round(v)}d`);

const sortValue = (g: Group, k: SortKey): string | number | null => {
  switch (k) {
    case "label": return g.label.toLowerCase();
    case "age": return g.ageDays;
    case "rep": return g.rep;
    case "domains": return g.domains;
    case "sent": return g.sent;
    case "ooo": return g.ooo;
    case "negative": return g.negative;
    default: return rateOf(g, k);
  }
};
const cmp = (a: string | number | null, b: string | number | null, dir: 1 | -1) =>
  a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : (a < b ? -1 : a > b ? 1 : 0) * dir;

/** A count and its rate. `mark` shows it's the best or worst of the groups with enough sent. */
function Pair({ n, of, digits = 2, tone, mark }: { n: number; of: number; digits?: number; tone: string; mark?: "best" | "worst" | null }) {
  const r = pct(n, of);
  if (!n) return <span className="st-pair is-zero"><span>0</span><span>{of ? P(0, digits) : "—"}</span></span>;
  return (
    <span className="st-pair">
      <span className={tone}>{int(n)}</span>
      <span className={`st-rate cmp-rate${mark ? ` is-${mark}` : ""}`}>{P(r, digits)}</span>
    </span>
  );
}

/** The change since the same days before, in points. */
function Change({ now, before, invert = false }: { now: number | null; before: number | null; invert?: boolean }) {
  if (now == null || before == null) return <span className="zero">—</span>;
  const d = now - before;
  if (Math.abs(d) < 0.01) return <span className="zero">same</span>;
  return <span className={(invert ? d < 0 : d > 0) ? "delta-up" : "delta-down"}>{d > 0 ? "+" : ""}{d.toFixed(2)}</span>;
}

function Reasons({ g }: { g: Pick<Group, "causes"> }) {
  const mix = bounceMix(g);
  if (!mix.length) return <span className="zero">—</span>;
  return (
    <span className="cmp-reasons" title={mix.map((m) => `${BOUNCE_META[m.cause].label}: ${int(m.n)} (${Math.round(m.share)}%)`).join("\n")}>
      <span className="rv-bar cmp-reason-bar" aria-hidden="true">
        {mix.map((m) => <span key={m.cause} style={{ width: `${m.share}%`, background: CAUSE_COLOR[m.cause] }} />)}
      </span>
      <span className="cmp-reason-top">{BOUNCE_META[mix[0].cause].label} {Math.round(mix[0].share)}%</span>
    </span>
  );
}

type Side = { dim: Dim; key: string; data: ReviewData | null };

/** One group of one range, picked from what that range has. */
function pickGroup(data: ReviewData, scope: Scope, side: Side): Group | null {
  const rows = data.domains.filter((d) => isCurrent(d.standing) === (scope === "current") && keysOf(d, side.dim).some((k) => k.key === side.key));
  if (!rows.length) return null;
  return summarize(side.key, keysOf(rows[0], side.dim).find((k) => k.key === side.key)?.label ?? side.key, rows);
}

function SidePicker({ name, side, options, today, loading, range, onDim, onKey, onRange }: {
  name: string; side: Side; options: { key: string; label: string }[]; today: string; loading: boolean; range: { from: string; to: string };
  onDim: (d: Dim) => void; onKey: (k: string) => void; onRange: (from: string, to: string) => void;
}) {
  return (
    <div className="cmp-side-pick">
      <span className={`cmp-side-mark is-${name.toLowerCase()}`}>{name}</span>
      <select className="select" value={side.dim} onChange={(e) => onDim(e.target.value as Dim)} aria-label={`Side ${name}: compare by`}>
        {DIMS.map((d) => <option key={d} value={d}>{DIM_META[d].label}</option>)}
      </select>
      <select className="select" value={side.key} onChange={(e) => onKey(e.target.value)} aria-label={`Side ${name}: which one`}>
        {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        {!options.some((o) => o.key === side.key) ? <option value={side.key}>{side.key || "None"}</option> : null}
      </select>
      <span className="cmp-side-range"><RangePicker from={range.from} to={range.to} today={today} loading={loading} onChange={onRange} /></span>
    </div>
  );
}

/** Two groups side by side. `better` says which way wins, for a tick on the winner. */
function HeadToHead({ a, b }: { a: Group | null; b: Group | null }) {
  const enough = !!a && !!b && a.sent >= MIN_SENT && b.sent >= MIN_SENT;
  const row = (label: string, value: (g: Group) => number | null, show: (g: Group) => string, better?: "high" | "low", hint?: string) => {
    const x = a ? value(a) : null, y = b ? value(b) : null;
    const win = better && enough && x != null && y != null && x !== y ? ((better === "high") === (x > y) ? "a" : "b") : null;
    return (
      <tr key={label}>
        <td className={`is-num${win === "a" ? " cmp-win" : ""}`}>{a ? show(a) : "—"}{win === "a" ? <Check size={12} strokeWidth={2.25} aria-label="better" /> : null}</td>
        <th scope="row" title={hint}>{label}</th>
        <td className={`is-num cmp-right${win === "b" ? " cmp-win" : ""}`}>{win === "b" ? <Check size={12} strokeWidth={2.25} aria-label="better" /> : null}{b ? show(b) : "—"}</td>
      </tr>
    );
  };
  const both = (n: (g: Group) => number, rate: (g: Group) => number | null) => (g: Group) => `${int(n(g))} · ${P(rate(g))}`;
  const causes = BOUNCE_ORDER.filter((c) => a?.causes[c] || b?.causes[c]);
  const share = (g: Group | null, c: (typeof BOUNCE_ORDER)[number]) => {
    const total = g ? Object.values(g.causes).reduce((s, v) => s + (v ?? 0), 0) : 0;
    return total && g ? (100 * (g.causes[c] ?? 0)) / total : 0;
  };
  return (
    <>
      <table className="cmp-h2h">
        <tbody>
          {row("Domains", (g) => g.domains, (g) => int(g.domains))}
          {row("Inboxes", (g) => g.inboxes, (g) => int(g.inboxes))}
          {row("Average domain age", (g) => g.ageDays, (g) => days(g.ageDays))}
          {row("Average time in Smartlead", (g) => g.connectedDays, (g) => days(g.connectedDays))}
          {row("Warm-up reputation", (g) => g.rep, (g) => (g.rep == null ? "—" : g.rep.toFixed(1)), "high")}
          {row("Sent", (g) => g.sent, (g) => int(g.sent))}
          {row("All replies", (g) => rateOf(g, "replies"), both((g) => g.replies, (g) => rateOf(g, "replies")), "high")}
          {row("Excl. out of office", (g) => rateOf(g, "real"), both((g) => g.real, (g) => rateOf(g, "real")), "high", "Replies without out of office and auto-replies")}
          {row("Human replies", (g) => rateOf(g, "human"), both((g) => g.human, (g) => rateOf(g, "human")), "high")}
          {row("Out of office", (g) => g.ooo, (g) => int(g.ooo))}
          {row("Not interested", (g) => pct(g.negative, g.sent), both((g) => g.negative, (g) => pct(g.negative, g.sent)), "low", "With wrong person and unsubscribe")}
          {row("Bounces", (g) => rateOf(g, "bounces"), both((g) => g.bounces, (g) => rateOf(g, "bounces")), "low")}
          {row("Spam rejections", (g) => rateOf(g, "spam"), both((g) => g.spam, (g) => rateOf(g, "spam")), "low")}
        </tbody>
      </table>
      {causes.length ? (
        <div className="cmp-h2h-causes">
          <h3 className="cmp-h3">Why they bounced</h3>
          {causes.map((c) => (
            <div key={c} className="cmp-cause" title={BOUNCE_META[c].hint}>
              <span className="cmp-cause-a"><span className="cmp-cause-n">{Math.round(share(a, c))}%</span><i><b style={{ width: `${share(a, c)}%`, background: CAUSE_COLOR[c] }} /></i></span>
              <span className="cmp-cause-label">{BOUNCE_META[c].label}</span>
              <span className="cmp-cause-b"><i><b style={{ width: `${share(b, c)}%`, background: CAUSE_COLOR[c] }} /></i><span className="cmp-cause-n">{Math.round(share(b, c))}%</span></span>
            </div>
          ))}
        </div>
      ) : null}
      {a && b && !enough ? <p className="cmp-note">One side has under {int(MIN_SENT)} sent, so no winner is marked: too little to call.</p> : null}
    </>
  );
}

export function CompareView({ initial }: { initial: ReviewData }) {
  const [data, setData] = useState(initial);
  const [loading, start] = useTransition();
  const [scope, setScope] = useState<Scope>("current");
  const [dim, setDim] = useState<Dim>("tld");
  // Narrow everything down first: only Outlook, only one client…
  const [only, setOnly] = useState<Partial<Record<Dim, string>>>({});
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "sent", dir: -1 });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [a, setA] = useState<Side | null>(null);
  const [b, setB] = useState<Side | null>(null);
  const [sideLoading, startSide] = useTransition();

  const load = (from: string, to: string) => start(async () => {
    const r = await loadReview({ from, to });
    if (!r.ok) return void toast.error(r.error);
    setData(r.data);
    setA((s) => s && { ...s, data: null });
    setB((s) => s && { ...s, data: null });
  });

  const counts = useMemo(() => {
    const current = data.domains.filter((d) => isCurrent(d.standing)).length;
    return { current, ended: data.domains.length - current };
  }, [data.domains]);
  const scoped = useMemo(() => data.domains.filter((d) => isCurrent(d.standing) === (scope === "current")), [data.domains, scope]);
  const matchesOnly = (d: ReviewDomain, skip?: Dim) => (Object.entries(only) as [Dim, string][]).every(([k, v]) => k === skip || keysOf(d, k).some((x) => x.key === v));
  const rows = useMemo(() => scoped.filter((d) => matchesOnly(d)), [scoped, only]); // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => groupsBy(rows, dim), [rows, dim]);
  const sorted = useMemo(() => {
    if (sort.key === "sent" && sort.dir === -1 && (dim === "age" || dim === "connected")) return groups; // bands stay in age order until sorted
    return [...groups].sort((x, y) => cmp(sortValue(x, sort.key), sortValue(y, sort.key), sort.dir) || x.label.localeCompare(y.label));
  }, [groups, sort, dim]);
  const all = useMemo(() => summarize("all", "All", rows), [rows]);
  const judged = groups.filter((g) => g.sent >= MIN_SENT);
  const markOf = (g: Group, k: "human" | "real" | "bounces" | "spam", best: "high" | "low"): "best" | "worst" | null => {
    if (judged.length < 2 || g.sent < MIN_SENT) return null;
    const vals = judged.map((x) => rateOf(x, k) ?? 0);
    const hi = Math.max(...vals), lo = Math.min(...vals), v = rateOf(g, k) ?? 0;
    if (hi === lo) return null;
    if (v === hi) return best === "high" ? "best" : "worst";
    if (v === lo) return best === "low" ? "best" : "worst";
    return null;
  };

  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "label" ? 1 : -1 }));
  const toggleOpen = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const optionsFor = (domains: ReviewDomain[], d: Dim) => groupsBy(domains, d).map((g) => ({ key: g.key, label: g.label }));

  // The two sides start on the two biggest groups, and follow what gets picked.
  const sideA: Side = a ?? { dim, key: groups[0]?.key ?? "", data: null };
  const sideB: Side = b ?? { dim, key: groups[1]?.key ?? groups[0]?.key ?? "", data: null };
  const aData = sideA.data ?? data, bData = sideB.data ?? data;
  const groupA = useMemo(() => pickGroup(aData, scope, sideA), [aData, scope, sideA.dim, sideA.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const groupB = useMemo(() => pickGroup(bData, scope, sideB), [bData, scope, sideB.dim, sideB.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadSide = (set: (f: (s: Side | null) => Side | null) => void, current: Side) => (from: string, to: string) => startSide(async () => {
    const r = await loadReview({ from, to });
    if (r.ok) set(() => ({ ...current, data: r.data })); else toast.error(r.error);
  });
  const sideOptions = (d: ReviewData, s: Side) => optionsFor(d.domains.filter((x) => isCurrent(x.standing) === (scope === "current")), s.dim);
  const changeDim = (set: (s: Side) => void, current: Side, source: ReviewData) => (next: Dim) => {
    const list = optionsFor(source.domains.filter((x) => isCurrent(x.standing) === (scope === "current")), next);
    set({ ...current, dim: next, key: list[0]?.key ?? "" });
  };
  const toSide = (which: "a" | "b", g: Group) => (which === "a" ? setA : setB)({ dim, key: g.key, data: which === "a" ? sideA.data : sideB.data });

  const filterDims = DIMS.filter((d) => d !== dim && d !== "connected");

  return (
    <div className="flex flex-col gap-3" style={{ opacity: loading ? 0.6 : 1, transition: "opacity 120ms" }}>
      <div className="table-bar">
        <div className="view-tabs" role="tablist" aria-label="Which domains">
          <button type="button" role="tab" aria-selected={scope === "current"} className={scope === "current" ? "is-on" : undefined} title="Connected in Smartlead with a live order, plus domains in their grace period" onClick={() => setScope("current")}>
            Active <span>{int(counts.current)}</span>
          </button>
          <button type="button" role="tab" aria-selected={scope === "ended"} className={scope === "ended" ? "is-on" : undefined} title="Have numbers in this range but aren't active today" onClick={() => setScope("ended")}>
            Disconnected or replaced <span>{int(counts.ended)}</span>
          </button>
        </div>
        <RangePicker from={data.from} to={data.to} today={data.today} loading={loading} onChange={load} />
        <span className="cmp-only">
          {filterDims.map((d) => {
            const list = optionsFor(scoped.filter((x) => matchesOnly(x, d)), d);
            return (
              <select key={d} className="select rv-filter" data-on={only[d] != null || undefined} value={only[d] ?? "*"} aria-label={`Only ${DIM_META[d].label}`}
                onChange={(e) => setOnly((s) => { const n = { ...s }; if (e.target.value === "*") delete n[d]; else n[d] = e.target.value; return n; })}>
                <option value="*">{DIM_META[d].all}</option>
                {list.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
            );
          })}
          {Object.keys(only).length ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOnly({})}><X size={13} /> Clear</button> : null}
        </span>
      </div>

      {scope === "current" ? <Findings domains={rows} /> : null}

      <section className="card" aria-labelledby="cmp-title">
        <div className="card-head flex-wrap gap-y-2">
          <h2 id="cmp-title" className="card-title">Compare by</h2>
          <div className="seg" role="group" aria-label="Compare by">
            {DIMS.map((d) => <button key={d} type="button" aria-pressed={dim === d} onClick={() => { setDim(d); setOpen(new Set()); setOnly((s) => { const n = { ...s }; delete n[d]; return n; }); }}>{DIM_META[d].label}</button>)}
          </div>
          <span className="card-sub">{nice(data.from)}{data.from === data.to ? "" : ` to ${nice(data.to)}`} · change against {previousLabel(data.from, data.to)}{dim === "tag" ? " · a domain with two tags counts under both" : ""}</span>
        </div>
        <div className="table-scroll" style={{ maxHeight: 560 }}>
          <table className="data-table is-main cmp-table">
            <thead>
              <tr>
                <SortTh k="label" sort={sort} onSort={sortBy}>{DIM_META[dim].label}</SortTh>
                <SortTh k="domains" sort={sort} onSort={sortBy} num>Domains</SortTh>
                <SortTh k="age" sort={sort} onSort={sortBy} num title="Average days since the domains were bought">Age</SortTh>
                <SortTh k="rep" sort={sort} onSort={sortBy} num title="Average warm-up reputation">Rep</SortTh>
                <SortTh k="sent" sort={sort} onSort={sortBy} num>Sent</SortTh>
                <SortTh k="replies" sort={sort} onSort={sortBy} num title="Every reply, out of office included. Sorts by rate">Replies</SortTh>
                <SortTh k="real" sort={sort} onSort={sortBy} num title="Without out of office and auto-replies. Sorts by rate">Excl. OOO</SortTh>
                <SortTh k="human" sort={sort} onSort={sortBy} num title="Interested and referrals. Sorts by rate">Human</SortTh>
                <SortTh k="ooo" sort={sort} onSort={sortBy} num title="Out of office">OOO</SortTh>
                <SortTh k="negative" sort={sort} onSort={sortBy} num title="Not interested, wrong person and unsubscribe">Not int.</SortTh>
                <SortTh k="bounces" sort={sort} onSort={sortBy} num title="Sorts by rate">Bounces</SortTh>
                <SortTh k="spam" sort={sort} onSort={sortBy} num title="Spam and blocklist rejections. Sorts by rate">Spam</SortTh>
                <th title="Hover for every reason">Why they bounced</th>
                <th className="is-num" title="Human reply rate, change in points">Human ±</th>
                <th className="is-num" title="Bounce rate, change in points">Bounce ±</th>
                <th title="Put this group on a side of the split below">Split</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((g) => {
                const isOpen = open.has(g.key);
                return (
                  <Fragment key={g.key || "none"}>
                    <tr data-low={g.sent < MIN_SENT || undefined} className={g.sent < MIN_SENT ? "cmp-low" : undefined}>
                      <td className="col-first">
                        <button type="button" className="cmp-row-open" aria-expanded={isOpen} onClick={() => toggleOpen(g.key)}>
                          <ChevronRight size={13} style={{ transform: isOpen ? "rotate(90deg)" : undefined }} aria-hidden="true" />
                          <span className="strong">{g.label}</span>
                        </button>
                      </td>
                      <td className="is-num">{int(g.domains)}</td>
                      <td className="is-num">{days(g.ageDays)}</td>
                      <td className="is-num">{g.rep != null ? <Rep value={g.rep} /> : <span className="zero">—</span>}</td>
                      <td className="is-num"><span className="strong text-ink">{int(g.sent)}</span></td>
                      <td className="is-num"><Pair n={g.replies} of={g.sent} tone="st-v-rep" /></td>
                      <td className="is-num"><Pair n={g.real} of={g.sent} tone="st-v-rep" mark={markOf(g, "real", "high")} /></td>
                      <td className="is-num"><Pair n={g.human} of={g.sent} tone="st-v-hum" mark={markOf(g, "human", "high")} /></td>
                      <td className="is-num">{g.ooo ? int(g.ooo) : <span className="zero">0</span>}</td>
                      <td className="is-num">{g.negative ? int(g.negative) : <span className="zero">0</span>}</td>
                      <td className="is-num"><Pair n={g.bounces} of={g.sent} digits={1} tone="st-v-bnc" mark={markOf(g, "bounces", "low")} /></td>
                      <td className="is-num"><Pair n={g.spam} of={g.sent} tone="st-v-bnc" mark={markOf(g, "spam", "low")} /></td>
                      <td><Reasons g={g} /></td>
                      <td className="is-num"><Change now={pct(g.human, g.sent)} before={pct(g.prevHuman, g.prevSent)} /></td>
                      <td className="is-num"><Change now={pct(g.bounces, g.sent)} before={pct(g.prevBounces, g.prevSent)} invert /></td>
                      <td>
                        <span className="cmp-ab">
                          <button type="button" className="is-a" aria-pressed={sideA.dim === dim && sideA.key === g.key} aria-label={`Put ${g.label} on side A`} onClick={() => toSide("a", g)}>A</button>
                          <button type="button" className="is-b" aria-pressed={sideB.dim === dim && sideB.key === g.key} aria-label={`Put ${g.label} on side B`} onClick={() => toSide("b", g)}>B</button>
                        </span>
                      </td>
                    </tr>
                    {isOpen ? [...g.rows].sort((x, y) => y.sent - x.sent || x.name.localeCompare(y.name)).map((d) => {
                      const one = summarize(d.id, d.name, [d]);
                      return (
                        <tr key={d.id} className="cmp-domain">
                          <td className="col-first"><DomainLink id={d.id} tab="stats" className="hover:underline">{d.name}</DomainLink> <span className="text-faint">{d.provider ?? espName(d.esp)}</span></td>
                          <td className="is-num text-faint">{int(d.inboxes)} in.</td>
                          <td className="is-num">{days(d.ageDays)}</td>
                          <td className="is-num">{d.rep != null ? <Rep value={d.rep} /> : <span className="zero">—</span>}</td>
                          <td className="is-num">{d.sent ? int(d.sent) : <span className="zero">0</span>}</td>
                          <td className="is-num"><Pair n={one.replies} of={one.sent} tone="st-v-rep" /></td>
                          <td className="is-num"><Pair n={one.real} of={one.sent} tone="st-v-rep" /></td>
                          <td className="is-num"><Pair n={one.human} of={one.sent} tone="st-v-hum" /></td>
                          <td className="is-num">{one.ooo ? int(one.ooo) : <span className="zero">0</span>}</td>
                          <td className="is-num">{one.negative ? int(one.negative) : <span className="zero">0</span>}</td>
                          <td className="is-num"><Pair n={one.bounces} of={one.sent} digits={1} tone="st-v-bnc" /></td>
                          <td className="is-num"><Pair n={one.spam} of={one.sent} tone="st-v-bnc" /></td>
                          <td><Reasons g={one} /></td>
                          <td className="is-num"><Change now={pct(one.human, one.sent)} before={pct(one.prevHuman, one.prevSent)} /></td>
                          <td className="is-num"><Change now={pct(one.bounces, one.sent)} before={pct(one.prevBounces, one.prevSent)} invert /></td>
                          <td />
                        </tr>
                      );
                    }) : null}
                  </Fragment>
                );
              })}
            </tbody>
            {groups.length > 1 ? (
              <tfoot>
                <tr>
                  <td className="col-first strong">All{dim === "tag" ? " (each domain once)" : ""}</td>
                  <td className="is-num">{int(all.domains)}</td>
                  <td className="is-num">{days(all.ageDays)}</td>
                  <td className="is-num">{all.rep != null ? all.rep.toFixed(1) : "—"}</td>
                  <td className="is-num strong">{int(all.sent)}</td>
                  <td className="is-num"><Pair n={all.replies} of={all.sent} tone="st-v-rep" /></td>
                  <td className="is-num"><Pair n={all.real} of={all.sent} tone="st-v-rep" /></td>
                  <td className="is-num"><Pair n={all.human} of={all.sent} tone="st-v-hum" /></td>
                  <td className="is-num">{int(all.ooo)}</td>
                  <td className="is-num">{int(all.negative)}</td>
                  <td className="is-num"><Pair n={all.bounces} of={all.sent} digits={1} tone="st-v-bnc" /></td>
                  <td className="is-num"><Pair n={all.spam} of={all.sent} tone="st-v-bnc" /></td>
                  <td><Reasons g={all} /></td>
                  <td className="is-num"><Change now={pct(all.human, all.sent)} before={pct(all.prevHuman, all.prevSent)} /></td>
                  <td className="is-num"><Change now={pct(all.bounces, all.sent)} before={pct(all.prevBounces, all.prevSent)} invert /></td>
                  <td />
                </tr>
              </tfoot>
            ) : null}
          </table>
          {groups.length === 0 ? <Empty icon={Columns2} title="Nothing to compare">No domains here for these dates and filters.</Empty> : null}
        </div>
        {groups.some((g) => g.sent < MIN_SENT) && groups.length > 1 ? <p className="cmp-note">Faded rows have under {int(MIN_SENT)} sent: too little to judge. Green and red mark the best and worst of the rest.</p> : null}
      </section>

      <section className="card" aria-labelledby="split-title">
        <div className="card-head"><h2 id="split-title" className="card-title">Split view</h2><span className="card-sub">Any two groups, each with its own dates: .info this week against .com last week</span></div>
        <div className="cmp-split-picks">
          <SidePicker name="A" side={sideA} today={data.today} loading={sideLoading} range={{ from: aData.from, to: aData.to }} options={sideOptions(aData, sideA)}
            onDim={changeDim((s) => setA(s), sideA, aData)} onKey={(k) => setA({ ...sideA, key: k })} onRange={loadSide(setA, sideA)} />
          <SidePicker name="B" side={sideB} today={data.today} loading={sideLoading} range={{ from: bData.from, to: bData.to }} options={sideOptions(bData, sideB)}
            onDim={changeDim((s) => setB(s), sideB, bData)} onKey={(k) => setB({ ...sideB, key: k })} onRange={loadSide(setB, sideB)} />
        </div>
        <div className="cmp-split-body" style={{ opacity: sideLoading ? 0.6 : 1 }}>
          <div className="cmp-h2h-head">
            <strong>{groupA?.label ?? "Nothing here"}</strong>
            <span>vs</span>
            <strong>{groupB?.label ?? "Nothing here"}</strong>
          </div>
          <HeadToHead a={groupA} b={groupB} />
        </div>
      </section>
    </div>
  );
}
