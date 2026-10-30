"use client";

import { DomainLink } from "@/components/domains/DomainLink";
import { ChevronLeft, ChevronRight, Copy, ListChecks, Search, Sheet, Tag, TagsIcon, X } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { loadReview, tagDomains } from "@/app/actions";
import { RangePicker } from "@/components/RangePicker";
import { SortTh } from "@/components/SortTh";
import { ClientCell, Empty, Rep, StatusDot, TagList } from "@/components/ui";
import { BOUNCE_META, BOUNCE_ORDER, type BounceReason } from "@/lib/bounces";
import { int } from "@/lib/format";
import type { ClientRow } from "@/lib/queries";
import { nice, previousLabel } from "@/lib/range";
import {
  RULES, SIGNAL_META, SIGNAL_ORDER, VERDICT_META, VERDICT_ORDER, badLists, byClient, bySmartleadTag, judge, sheetRows,
  type Chip, type ClientSummary, type Judged, type ReviewData, type Signal, type Verdict,
} from "@/lib/review";

// The weekly review: every sending domain sorted into what to do with it,
// with short tags for the evidence behind the call, client by client, ready
// to copy or tag.

const LISTS: Verdict[] = ["fix", "rest", "dead", "watch", "idle"];
const CAUSE_COLOR: Record<BounceReason, string> = {
  sender: "var(--danger-solid)", dns: "color-mix(in srgb, var(--danger-solid) 70%, var(--violet-solid))",
  blocklist: "color-mix(in srgb, var(--danger-solid) 65%, var(--warning-solid))", spam: "var(--warning-solid)",
  missing: "var(--info-solid)", restricted: "var(--line-strong)", policy: "color-mix(in srgb, var(--faint) 70%, transparent)",
  full: "var(--line-strong)", temporary: "var(--line)", other: "var(--line)",
};
const pct = (n: number, d: number) => (d > 0 ? (100 * n) / d : null);
const fx = (v: number | null, digits = 1) => (v == null ? "—" : `${v.toFixed(v < 1 && digits === 1 ? 2 : digits)}%`);
const plural = (n: number, one: string, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;

type SortKey = "verdict" | "name" | "client" | "signals" | "sent" | "human" | "quiet" | "rep" | "spam" | "missing" | "bounceRate";
const sortValue = (r: Judged, k: SortKey): string | number | null => {
  switch (k) {
    case "verdict": return -VERDICT_ORDER.indexOf(r.verdict) * 1e6 + r.strikes * 1e4 + r.spam;
    case "signals": return r.strikes * 100 + r.chips.length;
    case "client": return r.clientName?.toLowerCase() ?? null;
    case "name": return r.name;
    case "quiet": return r.quietDays;
    case "rep": return r.rep;
    case "missing": return r.causes.missing ?? 0;
    case "bounceRate": return pct(r.bounces, r.sent);
    default: return r[k];
  }
};
const cmp = (a: string | number | null, b: string | number | null, dir: 1 | -1) =>
  a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : (a < b ? -1 : a > b ? 1 : 0) * dir;

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`Copied ${what}`);
  } catch {
    toast.error("Couldn't copy");
  }
}

function SlTags({ tags }: { tags: string[] }) {
  if (!tags.length) return <span className="zero">—</span>;
  return (
    <span className="rv-sigs">
      {tags.slice(0, 2).map((t) => <span key={t} className="badge">{t}</span>)}
      {tags.length > 2 ? <span className="badge" title={tags.slice(2).join(", ")}>+{tags.length - 2}</span> : null}
    </span>
  );
}

function Chips({ chips }: { chips: Chip[] }) {
  if (!chips.length) return null;
  return (
    <span className="rv-sigs">
      {chips.map((c) => <span key={c.key} className={`rv-sig tone-${c.tone}`} title={`${SIGNAL_META[c.key].hint}. Here: ${c.why}`}>{c.text}</span>)}
    </span>
  );
}

export function ReviewView({ initial, clients }: { initial: ReviewData; clients: ClientRow[] }) {
  const [data, setData] = useState(initial);
  const [loading, start] = useTransition();
  const [tagging, startTag] = useTransition();
  const [scope, setScope] = useState<"active" | "other">("active");
  const [clientId, setClientId] = useState<string | null>(null);
  const [slTag, setSlTag] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<"client" | "tag">("client");
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<Verdict | "">("");
  const [signals, setSignals] = useState<Set<Signal>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "verdict", dir: -1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tag, setTag] = useState("");

  const load = (from: string, to: string) => start(async () => {
    const r = await loadReview({ from, to });
    if (r.ok) setData(r.data); else toast.error(r.error);
  });

  const judged = useMemo(() => data.domains.map(judge), [data.domains]);
  const scoped = useMemo(() => judged.filter((d) => (scope === "active") === (d.status === "active")), [judged, scope]);
  // "" is the domains without a client (or Smartlead tag); null is all of them.
  const ofClient = (d: Judged) => clientId == null || (d.clientId ?? "") === clientId;
  const ofTag = (d: Judged) => slTag == null || (slTag ? d.slTags.includes(slTag) : !d.slTags.length);
  const clientRows = useMemo(() => byClient(scoped.filter(ofTag)), [scoped, slTag]); // eslint-disable-line react-hooks/exhaustive-deps
  const tagRows = useMemo(() => bySmartleadTag(scoped.filter(ofClient)), [scoped, clientId]); // eslint-disable-line react-hooks/exhaustive-deps
  const pickClient = (id: string | null) => { setClientId(id); setSelected(new Set()); };
  const pickTag = (t: string | null) => { setSlTag(t); setSelected(new Set()); };
  const at = clientId == null ? -1 : clientRows.findIndex((c) => c.id === clientId);
  const step = (by: 1 | -1) => {
    if (!clientRows.length) return;
    const i = at < 0 ? (by === 1 ? 0 : clientRows.length - 1) : (at + by + clientRows.length) % clientRows.length;
    pickClient(clientRows[i].id);
  };

  const inScope = useMemo(() => scoped.filter((d) => ofClient(d) && ofTag(d)), [scoped, clientId, slTag]); // eslint-disable-line react-hooks/exhaustive-deps
  const byVerdict = useMemo(() => {
    const m = new Map<Verdict, Judged[]>(VERDICT_ORDER.map((v) => [v, []]));
    for (const d of inScope) m.get(d.verdict)!.push(d);
    for (const list of m.values()) list.sort((a, b) => b.strikes - a.strikes || b.spam - a.spam || (b.causes.sender ?? 0) + (b.causes.dns ?? 0) - (a.causes.sender ?? 0) - (a.causes.dns ?? 0) || b.sent - a.sent);
    return m;
  }, [inScope]);
  const needle = q.trim().toLowerCase();
  const listed = useMemo(() => inScope.filter((d) => (!only || d.verdict === only) &&
    (!needle || d.name.includes(needle) || d.clientName?.toLowerCase().includes(needle) || [...d.tags, ...d.slTags].some((t) => t.toLowerCase().includes(needle)))),
  [inScope, only, needle]);
  const signalCounts = useMemo(() => {
    const m = new Map<Signal, number>();
    for (const d of listed) for (const c of d.chips) m.set(c.key, (m.get(c.key) ?? 0) + 1);
    return m;
  }, [listed]);
  const rows = useMemo(() => listed
    .filter((d) => [...signals].every((k) => d.chips.some((c) => c.key === k)))
    .sort((a, b) => cmp(sortValue(a, sort.key), sortValue(b, sort.key), sort.dir) || a.name.localeCompare(b.name)),
  [listed, signals, sort]);

  const causes = useMemo(() => {
    const t: Partial<Record<BounceReason, number>> = {};
    for (const d of inScope) for (const [k, v] of Object.entries(d.causes) as [BounceReason, number][]) t[k] = (t[k] ?? 0) + v;
    return t;
  }, [inScope]);
  const causeTotal = Object.values(causes).reduce((a, b) => a + (b ?? 0), 0);
  const lists = useMemo(() => {
    const names = new Set(inScope.map((d) => d.clientName));
    return badLists(data.campaigns).filter((c) => clientId == null || names.has(c.clientName));
  }, [data.campaigns, inScope, clientId]);
  const knownTags = useMemo(() => [...new Set(["Replace", "Watch", "Fix", "Idle", ...data.domains.flatMap((d) => d.tags)])].sort(), [data.domains]);

  const count = (v: Verdict) => byVerdict.get(v)!.length;
  const selectedRows = rows.filter((r) => selected.has(r.id));
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleSignal = (k: Signal) => setSignals((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "name" || key === "client" ? 1 : -1 }));
  const pickList = (v: Verdict) => {
    setOnly(v);
    setSignals(new Set());
    setSelected(new Set(byVerdict.get(v)!.map((d) => d.id)));
    setTag(VERDICT_META[v].label.split(" ")[0]);
  };
  const applyTag = (on: boolean) => startTag(async () => {
    const r = await tagDomains({ domainIds: selectedRows.map((d) => d.id), tag, on });
    if (!r.ok) return void toast.error(r.error);
    toast.success(on ? `Tagged ${plural(r.data.changed, "domain")} ${tag.trim()}` : `Took ${tag.trim()} off ${plural(r.data.changed, "domain")}`);
    const again = await loadReview({ from: data.from, to: data.to });
    if (again.ok) setData(again.data);
  });

  const headline = [
    count("fix") ? `fix ${plural(count("fix"), "domain")}` : "",
    count("rest") ? `replace ${int(count("rest"))}` : "",
    count("dead") ? `delete or replace ${int(count("dead"))} fully disconnected` : "",
    count("watch") ? `watch ${int(count("watch"))}` : "",
  ].filter(Boolean).join(", ");
  const tone = count("fix") || count("rest") || count("dead") ? "danger" : count("watch") ? "warning" : "success";
  const current = at >= 0 ? clientRows[at] : null;

  return (
    <div className="flex flex-col gap-3" style={{ opacity: loading ? 0.6 : 1, transition: "opacity 120ms" }}>
      <div className="table-bar">
        <div className="view-tabs" role="tablist" aria-label="Domains">
          <button type="button" role="tab" aria-selected={scope === "active"} className={scope === "active" ? "is-on" : undefined} onClick={() => { setScope("active"); setSelected(new Set()); }}>
            Active <span>{int(judged.filter((d) => d.status === "active").length)}</span>
          </button>
          <button type="button" role="tab" aria-selected={scope === "other"} className={scope === "other" ? "is-on" : undefined} onClick={() => { setScope("other"); setSelected(new Set()); }}
            title="Warming, draining, and any other domain that sent in this range">
            Not active <span>{int(judged.filter((d) => d.status !== "active").length)}</span>
          </button>
        </div>
        <RangePicker from={data.from} to={data.to} today={data.today} loading={loading} onChange={load} />
        <span className="rv-client-pick">
          <button type="button" className="btn btn-sm btn-icon" aria-label="Previous client" title="Previous client" onClick={() => step(-1)}><ChevronLeft size={14} /></button>
          <select className="select" style={{ width: 170 }} value={clientId ?? "*"} onChange={(e) => pickClient(e.target.value === "*" ? null : e.target.value)} aria-label="Filter by client">
            <option value="*">All clients</option>
            {clientRows.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            {clients.filter((c) => !clientRows.some((r) => r.id === c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button type="button" className="btn btn-sm btn-icon" aria-label="Next client" title="Next client, worst first" onClick={() => step(1)}><ChevronRight size={14} /></button>
          {current ? <span className="rv-client-at">{at + 1} of {clientRows.length}</span> : null}
        </span>
        <select className="select" style={{ width: 190 }} value={slTag ?? "*"} onChange={(e) => pickTag(e.target.value === "*" ? null : e.target.value)} aria-label="Filter by Smartlead tag">
          <option value="*">All Smartlead tags</option>
          {[...tagRows].sort((a, b) => (a.id ? 0 : 1) - (b.id ? 0 : 1) || a.name.localeCompare(b.name)).map((t) => <option key={t.id || "none"} value={t.id}>{t.name} ({t.domains})</option>)}
          {slTag != null && !tagRows.some((t) => t.id === slTag) ? <option value={slTag}>{slTag || "No tag"}</option> : null}
        </select>
      </div>

      <div className={`rv-headline tone-${tone}`}>
        <span className="rv-headline-k">{current ? `${current.name} · ` : ""}{slTag != null ? `${slTag || "No Smartlead tag"} · ` : ""}{nice(data.from)}{data.from === data.to ? "" : ` – ${nice(data.to)}`}, compared with {previousLabel(data.from, data.to)}</span>
        <span className="rv-headline-h">
          {headline ? `${headline[0].toUpperCase()}${headline.slice(1)}.` : "Nothing to fix, replace or watch."}
          {scope === "active" && count("idle") ? ` ${plural(count("idle"), "active domain")} sent nothing.` : ""}
        </span>
      </div>

      <section className="rv-lists" aria-label="What to do">
        {LISTS.map((v) => {
          const list = byVerdict.get(v)!;
          const m = VERDICT_META[v];
          return (
            <div key={v} className={`card rv-list${list.length ? ` has-${m.tone}` : ""}`}>
              <div className="rv-list-head">
                <span className="card-title">{m.label}</span>
                <span className={`rv-count tone-${list.length ? m.tone : "faint"}`}>{int(list.length)}</span>
              </div>
              <p className="rv-hint">{m.hint}</p>
              <div className="rv-items">
                {list.length ? list.slice(0, 5).map((d) => (
                  <div key={d.id} className="rv-item" title={d.why}>
                    <span className="rv-item-head">
                      <DomainLink id={d.id} tab="stats" className="strong hover:underline">{d.name}</DomainLink>
                      <span className="rv-why">{[clientId == null ? d.clientName : null, d.slTags.join(", ")].filter(Boolean).join(" · ")}</span>
                    </span>
                    {d.chips.length ? <Chips chips={d.chips} /> : <span className="rv-why">{d.why}</span>}
                  </div>
                )) : <p className="rv-none">None in this range</p>}
                {list.length > 5 ? <button type="button" className="rv-more" onClick={() => { setOnly(v); setSignals(new Set()); }}>and {int(list.length - 5)} more</button> : null}
              </div>
              {list.length ? (
                <div className="rv-actions">
                  <button type="button" className="btn btn-sm" onClick={() => copy(list.map((d) => d.name).join("\n"), plural(list.length, "domain"))}><Copy size={13} /> Copy</button>
                  <button type="button" className="btn btn-sm" title="Domain, call, reason, signals, Smartlead tags, client and numbers, one column each with a header row: paste into Google Sheets" onClick={() => copy(sheetRows(list), `${plural(list.length, "domain")} for Sheets`)}><Sheet size={13} /> Copy for Sheets</button>
                  <button type="button" className="btn btn-sm" onClick={() => pickList(v)}><Tag size={13} /> Tag</button>
                </div>
              ) : null}
            </div>
          );
        })}
      </section>

      <div className="card">
        <div className="card-head">
          <div className="seg" role="group" aria-label="Group by">
            <button type="button" aria-pressed={groupBy === "client"} onClick={() => setGroupBy("client")}>By client</button>
            <button type="button" aria-pressed={groupBy === "tag"} onClick={() => setGroupBy("tag")}>By Smartlead tag</button>
          </div>
          <span className="card-sub">{groupBy === "client"
            ? "Worst first. Click a client to see only its domains; the arrows up top step through them"
            : "Worst first. A domain with two tags counts under both. Click a tag to see only its domains"}</span>
        </div>
        <div className="table-scroll" style={{ maxHeight: 320 }}>
          <table className="data-table rv-clients">
            <thead>
              <tr>
                <th>{groupBy === "client" ? "Client" : "Smartlead tag"}</th>
                <th className="is-num">Domains</th>
                {LISTS.map((v) => <th key={v} className="is-num" title={VERDICT_META[v].hint}>{VERDICT_META[v].label}</th>)}
                <th className="is-num">Sent</th>
                <th className="is-num" title="Human replies per email sent">Human</th>
                <th className="is-num" title="Spam and blocklist rejections per email sent">Spam</th>
                <th className="is-num">Bounce</th>
              </tr>
            </thead>
            <tbody>
              {(groupBy === "client" ? clientRows : tagRows).map((c: ClientSummary) => {
                const on = groupBy === "client" ? c.id === clientId : c.id === slTag;
                const pick = () => (groupBy === "client" ? pickClient(on ? null : c.id) : pickTag(on ? null : c.id));
                return (
                <tr key={c.id || "none"} data-active={on} className="is-clickable" onClick={pick}>
                  <td>{groupBy === "client" ? <ClientCell name={c.name} hue={c.hue} /> : c.id ? <span className="badge">{c.name}</span> : <span className="zero">No tag</span>}</td>
                  <td className="is-num">{int(c.domains)}</td>
                  {LISTS.map((v) => (
                    <td key={v} className="is-num">{c.counts[v] ? <span className={`rv-count tone-${VERDICT_META[v].tone}`}>{int(c.counts[v])}</span> : <span className="zero">0</span>}</td>
                  ))}
                  <td className="is-num">{c.sent ? int(c.sent) : <span className="zero">0</span>}</td>
                  <td className="is-num">{fx(pct(c.human, c.sent))}</td>
                  <td className="is-num"><span className={(pct(c.spam, c.sent) ?? 0) >= RULES.restSpamRate ? "metric is-bad" : (pct(c.spam, c.sent) ?? 0) >= RULES.watchSpamRate ? "metric is-warn" : "metric"}>{fx(pct(c.spam, c.sent))}</span></td>
                  <td className="is-num">{fx(pct(c.bounces, c.sent))}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
          {(groupBy === "client" ? clientRows : tagRows).length === 0 ? <p className="rv-none" style={{ padding: "10px 14px" }}>No domains here.</p> : null}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="card">
          <div className="card-head"><span className="card-title">Why things bounced</span><span className="card-sub">{plural(causeTotal, "bounce")} with a notice</span></div>
          <div className="card-body">
            {causeTotal ? (
              <>
                <div className="rv-bar" role="img" aria-label="Bounces by cause">
                  {BOUNCE_ORDER.filter((k) => causes[k]).map((k) => <span key={k} style={{ width: `${(100 * (causes[k] ?? 0)) / causeTotal}%`, background: CAUSE_COLOR[k] }} title={`${BOUNCE_META[k].label}: ${int(causes[k] ?? 0)}`} />)}
                </div>
                <div className="rv-legend">
                  {BOUNCE_ORDER.filter((k) => causes[k]).map((k) => (
                    <span key={k} title={BOUNCE_META[k].hint}><i style={{ background: CAUSE_COLOR[k] }} />{BOUNCE_META[k].label} <b>{fx(pct(causes[k] ?? 0, causeTotal), 0)}</b></span>
                  ))}
                </div>
                <p className="rv-note">Tenant, DNS, blocklist and spam count against the domain. No such address counts against the list.</p>
              </>
            ) : <p className="rv-none">No bounces in this range.</p>}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><span className="card-title">Lists to re-verify</span><span className="card-sub">Mostly addresses that don&apos;t exist</span></div>
          <div className="card-body rv-camps">
            {lists.length ? lists.slice(0, 6).map((c) => (
              <div key={c.id} className="rv-item">
                <span className="strong">{c.name}</span>
                <span className="rv-why">{c.clientName ? `${c.clientName} · ` : ""}{int(c.missing)} of {plural(c.bounces, "bounce")} are dead addresses</span>
              </div>
            )) : <p className="rv-none">No campaign stands out.</p>}
          </div>
        </div>
      </div>

      <div className="table-bar">
        <div className="view-tabs" role="tablist" aria-label="Call">
          <button type="button" role="tab" aria-selected={!only} className={!only ? "is-on" : undefined} onClick={() => setOnly("")}>All <span>{int(inScope.length)}</span></button>
          {VERDICT_ORDER.filter((v) => count(v)).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={only === v} className={only === v ? "is-on" : undefined} onClick={() => setOnly(v)}>{VERDICT_META[v].label} <span>{int(count(v))}</span></button>
          ))}
        </div>
        <span className="spacer-auto" />
        <label className="search-input">
          <Search size={14} strokeWidth={1.5} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search domain, client, tag" aria-label="Search domains" />
        </label>
      </div>

      <div className="rv-sig-filter" role="group" aria-label="Show only domains with these tags">
        <span className="rv-sig-filter-k">Show only</span>
        {SIGNAL_ORDER.filter((k) => signalCounts.get(k) || signals.has(k)).map((k) => (
          <button key={k} type="button" className="rv-sig-btn" aria-pressed={signals.has(k)} title={SIGNAL_META[k].hint} onClick={() => toggleSignal(k)}>
            {SIGNAL_META[k].label} <span>{int(signalCounts.get(k) ?? 0)}</span>
          </button>
        ))}
        {signals.size ? <button type="button" className="rv-more" onClick={() => setSignals(new Set())}>Clear</button> : null}
        {!signalCounts.size && !signals.size ? <span className="rv-none">No tags in this view</span> : null}
      </div>

      <div className="table-wrap">
        <div className="table-scroll" style={{ maxHeight: "calc(100dvh - 220px)", minHeight: 240 }}>
          <table className="data-table is-main">
            <thead>
              <tr>
                <th style={{ width: 36 }}><input type="checkbox" className="checkbox" aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} /></th>
                <SortTh k="name" sort={sort} onSort={sortBy}>Domain</SortTh>
                <SortTh k="client" sort={sort} onSort={sortBy}>Client</SortTh>
                <SortTh k="verdict" sort={sort} onSort={sortBy}>Call</SortTh>
                <SortTh k="signals" sort={sort} onSort={sortBy} title="Strikes first: spam, blocklisted, low reputation, no reply">Tags</SortTh>
                <SortTh k="sent" sort={sort} onSort={sortBy} num>Sent</SortTh>
                <SortTh k="human" sort={sort} onSort={sortBy} num>Human</SortTh>
                <SortTh k="quiet" sort={sort} onSort={sortBy} num title="Days since the last human reply">Last reply</SortTh>
                <SortTh k="rep" sort={sort} onSort={sortBy} num title="Average warmup reputation of connected inboxes">Rep</SortTh>
                <SortTh k="spam" sort={sort} onSort={sortBy} num title="Spam and blocklist rejections">Spam</SortTh>
                <SortTh k="missing" sort={sort} onSort={sortBy} num title="Bounces to addresses that don't exist">No address</SortTh>
                <SortTh k="bounceRate" sort={sort} onSort={sortBy} num>Bounce</SortTh>
                <th title="Tags on the domain's inboxes in Smartlead">Smartlead tags</th>
                <th>Your tags</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const m = VERDICT_META[r.verdict];
                const br = pct(r.bounces, r.sent);
                return (
                  <tr key={r.id} data-selected={selected.has(r.id)}>
                    <td><input type="checkbox" className="checkbox" aria-label={`Select ${r.name}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                    <td className="col-first">
                      <span className="flex items-center gap-2">
                        <DomainLink id={r.id} tab="stats" className="strong hover:underline">{r.name}</DomainLink>
                        {r.status !== "active" ? <StatusDot status={r.status as Parameters<typeof StatusDot>[0]["status"]} /> : null}
                      </span>
                    </td>
                    <td><ClientCell name={r.clientName} hue={r.clientHue} /></td>
                    <td><span className={`badge tone-${m.tone}`} title={r.why}>{m.label}</span></td>
                    <td className="rv-sig-cell" title={r.why}>{r.chips.length ? <Chips chips={r.chips} /> : <span className="zero">—</span>}</td>
                    <td className="is-num">{r.sent ? int(r.sent) : <span className="zero">0</span>}</td>
                    <td className="is-num">{r.human ? int(r.human) : <span className="zero">0</span>}</td>
                    <td className="is-num" title={r.quietDays == null ? "Nothing sent yet" : r.neverReplied ? `No human reply on record (${int(r.sentSinceReply)} sent)` : `${int(r.sentSinceReply)} sent since`}>
                      {r.quietDays == null ? <span className="zero">—</span>
                        : <span className={`metric${r.quietDays >= RULES.longQuietDays && r.sentSinceReply >= RULES.quietSent ? " is-bad" : r.quietDays >= RULES.quietDays && r.sentSinceReply >= RULES.quietSent ? " is-warn" : ""}`}>
                          {r.neverReplied ? `${r.quietDays}d+` : r.quietDays === 0 ? "Today" : `${r.quietDays}d`}
                        </span>}
                    </td>
                    <td className="is-num"><Rep value={r.rep} /></td>
                    <td className="is-num">{r.spam ? <span className={r.spam >= 10 ? "metric is-bad" : "metric is-warn"}>{int(r.spam)}</span> : <span className="zero">0</span>}</td>
                    <td className="is-num">{r.causes.missing ? int(r.causes.missing) : <span className="zero">0</span>}</td>
                    <td className="is-num"><span className={`metric${br != null && br > 3 ? " is-bad" : br != null && br > 2 ? " is-warn" : ""}${!br ? " zero" : ""}`}>{fx(br)}</span></td>
                    <td><SlTags tags={r.slTags} /></td>
                    <td><TagList tags={r.tags} max={2} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 ? <Empty icon={ListChecks} title="No domains here">Pick another range, client, call or tag.</Empty> : null}
        </div>
        <div className="table-footer">
          <span><b>{int(rows.length)}</b> domains</span>
          <span><b>{int(rows.reduce((a, r) => a + r.sent, 0))}</b> sent</span>
          <span><b>{int(rows.reduce((a, r) => a + r.human, 0))}</b> human replies</span>
          <span><b>{int(rows.reduce((a, r) => a + r.spam, 0))}</b> spam rejections</span>
        </div>
      </div>

      {selectedRows.length > 0 ? (
        <div className="bulk-bar" role="toolbar" aria-label="Selected domains">
          <span className="bulk-count">{selectedRows.length} selected</span>
          <input className="rv-tag-input" list="rv-tags" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Tag name" aria-label="Tag name"
            onKeyDown={(e) => { if (e.key === "Enter" && tag.trim()) applyTag(true); }} />
          <datalist id="rv-tags">{knownTags.map((t) => <option key={t} value={t} />)}</datalist>
          <button type="button" className="btn btn-primary btn-sm" disabled={!tag.trim() || tagging} onClick={() => applyTag(true)}><TagsIcon size={14} /> Add tag</button>
          <button type="button" className="btn btn-sm" disabled={!tag.trim() || tagging} onClick={() => applyTag(false)}>Remove</button>
          <span className="sep" />
          <button type="button" className="btn btn-sm" onClick={() => copy(selectedRows.map((d) => d.name).join("\n"), plural(selectedRows.length, "domain"))}><Copy size={14} /> Copy</button>
          <button type="button" className="btn btn-sm" title="One column per fact with a header row: paste into Google Sheets" onClick={() => copy(sheetRows(selectedRows), `${plural(selectedRows.length, "domain")} for Sheets`)}><Sheet size={14} /> Copy for Sheets</button>
          <span className="sep" />
          <button type="button" className="btn btn-sm" aria-label="Clear selection" onClick={() => setSelected(new Set())}><X size={14} /></button>
        </div>
      ) : null}
    </div>
  );
}
