"use client";

import { DomainLink } from "@/components/domains/DomainLink";
import { ClipboardList, Copy, ListChecks, Search, Tag, TagsIcon, X } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { loadReview, tagDomains } from "@/app/actions";
import { RangePicker } from "@/components/RangePicker";
import { SortTh } from "@/components/SortTh";
import { ClientCell, Empty, StatusDot, TagList } from "@/components/ui";
import { BOUNCE_META, BOUNCE_ORDER, type BounceReason } from "@/lib/bounces";
import { int } from "@/lib/format";
import type { ClientRow } from "@/lib/queries";
import { nice, previousLabel } from "@/lib/range";
import { VERDICT_META, VERDICT_ORDER, badLists, judge, type Judged, type ReviewData, type Verdict } from "@/lib/review";

// The weekly review: every sending domain sorted into what to do with it,
// each with the numbers behind the call, ready to copy or tag.

const LISTS: Verdict[] = ["fix", "rest", "watch", "idle"];
const CAUSE_COLOR: Record<BounceReason, string> = {
  sender: "var(--danger-solid)", blocklist: "color-mix(in srgb, var(--danger-solid) 65%, var(--warning-solid))", spam: "var(--warning-solid)",
  missing: "var(--info-solid)", restricted: "var(--line-strong)", policy: "color-mix(in srgb, var(--faint) 70%, transparent)",
  full: "var(--line-strong)", temporary: "var(--line)", other: "var(--line)",
};
const pct = (n: number, d: number) => (d > 0 ? (100 * n) / d : null);
const fx = (v: number | null, digits = 1) => (v == null ? "—" : `${v.toFixed(v < 1 && digits === 1 ? 2 : digits)}%`);
const plural = (n: number, one: string, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;

type SortKey = "verdict" | "name" | "client" | "sent" | "human" | "spam" | "missing" | "bounceRate";
const sortValue = (r: Judged, k: SortKey): string | number | null => {
  switch (k) {
    case "verdict": return -VERDICT_ORDER.indexOf(r.verdict) * 1e6 + r.spam;
    case "client": return r.clientName?.toLowerCase() ?? null;
    case "name": return r.name;
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

export function ReviewView({ initial, clients }: { initial: ReviewData; clients: ClientRow[] }) {
  const [data, setData] = useState(initial);
  const [loading, start] = useTransition();
  const [tagging, startTag] = useTransition();
  const [scope, setScope] = useState<"active" | "other">("active");
  const [clientId, setClientId] = useState("");
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<Verdict | "">("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "verdict", dir: -1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tag, setTag] = useState("");

  const load = (from: string, to: string) => start(async () => {
    const r = await loadReview({ from, to });
    if (r.ok) setData(r.data); else toast.error(r.error);
  });

  const judged = useMemo(() => data.domains.map(judge), [data.domains]);
  const inScope = useMemo(() => judged.filter((d) => (scope === "active") === (d.status === "active") && (!clientId || d.clientId === clientId)), [judged, scope, clientId]);
  const byVerdict = useMemo(() => {
    const m = new Map<Verdict, Judged[]>(VERDICT_ORDER.map((v) => [v, []]));
    for (const d of inScope) m.get(d.verdict)!.push(d);
    for (const list of m.values()) list.sort((a, b) => b.spam - a.spam || (b.causes.sender ?? 0) - (a.causes.sender ?? 0) || b.sent - a.sent);
    return m;
  }, [inScope]);
  const needle = q.trim().toLowerCase();
  const rows = useMemo(() => inScope
    .filter((d) => (!only || d.verdict === only) &&
      (!needle || d.name.includes(needle) || d.clientName?.toLowerCase().includes(needle) || d.tags.some((t) => t.toLowerCase().includes(needle))))
    .sort((a, b) => cmp(sortValue(a, sort.key), sortValue(b, sort.key), sort.dir) || a.name.localeCompare(b.name)),
  [inScope, only, needle, sort]);

  const causes = useMemo(() => {
    const t: Partial<Record<BounceReason, number>> = {};
    for (const d of inScope) for (const [k, v] of Object.entries(d.causes) as [BounceReason, number][]) t[k] = (t[k] ?? 0) + v;
    return t;
  }, [inScope]);
  const causeTotal = Object.values(causes).reduce((a, b) => a + (b ?? 0), 0);
  const lists = useMemo(() => {
    const names = new Set(inScope.map((d) => d.clientName));
    return badLists(data.campaigns).filter((c) => !clientId || names.has(c.clientName));
  }, [data.campaigns, inScope, clientId]);
  const knownTags = useMemo(() => [...new Set(["Rest", "Watch", "Fix", "Idle", ...data.domains.flatMap((d) => d.tags)])].sort(), [data.domains]);

  const count = (v: Verdict) => byVerdict.get(v)!.length;
  const selectedRows = rows.filter((r) => selected.has(r.id));
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "name" || key === "client" ? 1 : -1 }));
  const pickList = (v: Verdict) => {
    setOnly(v);
    setSelected(new Set(byVerdict.get(v)!.map((d) => d.id)));
    setTag(VERDICT_META[v].label.split(" ")[0]);
  };
  const reasons = (list: Judged[]) => list.map((d) => [d.name, d.clientName ?? "", VERDICT_META[d.verdict].label, d.why].join("\t")).join("\n");
  const applyTag = (on: boolean) => startTag(async () => {
    const r = await tagDomains({ domainIds: selectedRows.map((d) => d.id), tag, on });
    if (!r.ok) return void toast.error(r.error);
    toast.success(on ? `Tagged ${plural(r.data.changed, "domain")} ${tag.trim()}` : `Took ${tag.trim()} off ${plural(r.data.changed, "domain")}`);
    const again = await loadReview({ from: data.from, to: data.to });
    if (again.ok) setData(again.data);
  });

  const headline = [
    count("fix") ? `fix ${plural(count("fix"), "domain")}` : "",
    count("rest") ? `rest ${int(count("rest"))}` : "",
    count("watch") ? `watch ${int(count("watch"))}` : "",
  ].filter(Boolean).join(", ");
  const tone = count("fix") || count("rest") ? "danger" : count("watch") ? "warning" : "success";

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
        <select className="select" style={{ width: 150 }} value={clientId} onChange={(e) => { setClientId(e.target.value); setSelected(new Set()); }} aria-label="Filter by client">
          <option value="">All clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      <div className={`rv-headline tone-${tone}`}>
        <span className="rv-headline-k">{nice(data.from)}{data.from === data.to ? "" : ` – ${nice(data.to)}`}, compared with {previousLabel(data.from, data.to)}</span>
        <span className="rv-headline-h">
          {headline ? `${headline[0].toUpperCase()}${headline.slice(1)}.` : "Nothing to fix, rest or watch."}
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
                  <div key={d.id} className="rv-item">
                    <DomainLink id={d.id} tab="stats" className="strong hover:underline">{d.name}</DomainLink>
                    <span className="rv-why">{d.clientName ? `${d.clientName} · ` : ""}{d.why}{d.worse ? " ▲" : ""}</span>
                  </div>
                )) : <p className="rv-none">None in this range</p>}
                {list.length > 5 ? <button type="button" className="rv-more" onClick={() => setOnly(v)}>and {int(list.length - 5)} more</button> : null}
              </div>
              {list.length ? (
                <div className="rv-actions">
                  <button type="button" className="btn btn-sm" onClick={() => copy(list.map((d) => d.name).join("\n"), plural(list.length, "domain"))}><Copy size={13} /> Copy</button>
                  <button type="button" className="btn btn-sm" title="Domain, client, call and reason, tab separated: paste into Sheets or Slack" onClick={() => copy(reasons(list), "with reasons")}><ClipboardList size={13} /> With reasons</button>
                  <button type="button" className="btn btn-sm" onClick={() => pickList(v)}><Tag size={13} /> Tag</button>
                </div>
              ) : null}
            </div>
          );
        })}
      </section>

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
                <p className="rv-note">Sender setup, blocklist and spam count against the domain. No such address counts against the list.</p>
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

      <div className="table-wrap">
        <div className="table-scroll" style={{ maxHeight: "calc(100dvh - 220px)", minHeight: 240 }}>
          <table className="data-table is-main">
            <thead>
              <tr>
                <th style={{ width: 36 }}><input type="checkbox" className="checkbox" aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} /></th>
                <SortTh k="name" sort={sort} onSort={sortBy}>Domain</SortTh>
                <SortTh k="client" sort={sort} onSort={sortBy}>Client</SortTh>
                <SortTh k="verdict" sort={sort} onSort={sortBy}>Call</SortTh>
                <th>Why</th>
                <SortTh k="sent" sort={sort} onSort={sortBy} num>Sent</SortTh>
                <SortTh k="human" sort={sort} onSort={sortBy} num>Human</SortTh>
                <SortTh k="spam" sort={sort} onSort={sortBy} num title="Spam and blocklist rejections">Spam</SortTh>
                <SortTh k="missing" sort={sort} onSort={sortBy} num title="Bounces to addresses that don't exist">No address</SortTh>
                <SortTh k="bounceRate" sort={sort} onSort={sortBy} num>Bounce</SortTh>
                <th>Tags</th>
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
                    <td><span className={`badge tone-${m.tone}`} title={m.hint}>{m.label}</span></td>
                    <td className="rv-why-cell" title={r.why}>{r.why}{r.worse ? <span className="rv-worse" title={`Spam share at least doubled since ${previousLabel(data.from, data.to)}`}> ▲</span> : null}</td>
                    <td className="is-num">{r.sent ? int(r.sent) : <span className="zero">0</span>}</td>
                    <td className="is-num">{r.human ? int(r.human) : <span className="zero">0</span>}</td>
                    <td className="is-num">{r.spam ? <span className={r.spam >= 10 ? "metric is-bad" : "metric is-warn"}>{int(r.spam)}</span> : <span className="zero">0</span>}</td>
                    <td className="is-num">{r.causes.missing ? int(r.causes.missing) : <span className="zero">0</span>}</td>
                    <td className="is-num"><span className={`metric${br != null && br > 3 ? " is-bad" : br != null && br > 2 ? " is-warn" : ""}${!br ? " zero" : ""}`}>{fx(br)}</span></td>
                    <td><TagList tags={r.tags} max={2} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 ? <Empty icon={ListChecks} title="No domains here">Pick another range, client or call.</Empty> : null}
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
          <button type="button" className="btn btn-sm" onClick={() => copy(reasons(selectedRows), "with reasons")}><ClipboardList size={14} /> With reasons</button>
          <span className="sep" />
          <button type="button" className="btn btn-sm" aria-label="Clear selection" onClick={() => setSelected(new Set())}><X size={14} /></button>
        </div>
      ) : null}
    </div>
  );
}
