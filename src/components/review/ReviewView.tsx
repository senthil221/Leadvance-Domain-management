"use client";

import { DomainLink } from "@/components/domains/DomainLink";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Copy, ListChecks, Search, Sheet, SlidersHorizontal, TagsIcon, X } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { loadReview, markDomains, tagDomains } from "@/app/actions";
import { ConfigureDomains, PasteSelect } from "@/components/domains/DomainBulk";
import { RangePicker } from "@/components/RangePicker";
import { SortTh } from "@/components/SortTh";
import { ClientCell, Empty, Rep, StatusDot, TagList } from "@/components/ui";
import { BOUNCE_META, BOUNCE_ORDER, type BounceReason } from "@/lib/bounces";
import { ago, int } from "@/lib/format";
import { SlBadge } from "@/components/domains/SlStatus";
import type { ClientRow } from "@/lib/queries";
import { nice, previousLabel } from "@/lib/range";
import { MARK_CHOICES, markOf, type Mark } from "@/lib/tag-map";
import {
  ESP_ORDER, RULES, SIGNAL_META, SIGNAL_ORDER, VERDICT_META, VERDICT_ORDER, badLists, byClient, byEsp, bySmartleadTag, byTld, espName, judge, sheetRows,
  type Chip, type ClientSummary, type Judged, type ReviewData, type Signal, type Verdict,
} from "@/lib/review";

// The weekly review: every sending domain sorted into what to do with it, a
// tab per call with the reason beside each domain, split by mail provider and
// TLD, ready to copy, tag or reconfigure in Smartlead.

const LISTS: Verdict[] = ["fix", "rest", "drop", "dead", "watch", "idle"];
// The tag each list's Tag button suggests. Marks also go to Smartlead.
const LIST_TAG: Partial<Record<Verdict, Mark>> = { rest: "Replace", drop: "Cancelled", dead: "Disconnected", watch: "Watch" };
const CAUSE_COLOR: Record<BounceReason, string> = {
  sender: "var(--danger-solid)", dns: "color-mix(in srgb, var(--danger-solid) 70%, var(--violet-solid))",
  blocklist: "color-mix(in srgb, var(--danger-solid) 65%, var(--warning-solid))", spam: "var(--warning-solid)",
  missing: "var(--info-solid)", restricted: "var(--line-strong)", policy: "color-mix(in srgb, var(--faint) 70%, transparent)",
  full: "var(--line-strong)", temporary: "var(--line)", other: "var(--line)",
};
const pct = (n: number, d: number) => (d > 0 ? (100 * n) / d : null);
const fx = (v: number | null, digits = 1) => (v == null ? "—" : `${v.toFixed(v < 1 && digits === 1 ? 2 : digits)}%`);
const plural = (n: number, one: string, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;

type SortKey = "verdict" | "name" | "client" | "esp" | "signals" | "sent" | "replies" | "human" | "quiet" | "rep" | "spam" | "missing" | "bounceRate";
const sortValue = (r: Judged, k: SortKey): string | number | null => {
  switch (k) {
    case "verdict": return -VERDICT_ORDER.indexOf(r.verdict) * 1e6 + r.strikes * 1e4 + r.spam;
    case "signals": return r.strikes * 100 + r.chips.length;
    case "client": return r.clientName?.toLowerCase() ?? null;
    case "esp": return espName(r.esp);
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

function EspBadge({ esp }: { esp: string | null }) {
  const name = espName(esp);
  return <span className={`badge${name === "Outlook" ? " tone-info" : name === "Google" ? " tone-success" : ""}`}>{name}</span>;
}

/** A filter as a compact select with counts. The chosen value stays listed even when nothing has it. */
function FacetSelect({ label, all, items, value, onPick }: { label: string; all: string; items: [string, number, string?][]; value: string | null; onPick: (v: string | null) => void }) {
  const list = value != null && !items.some(([k]) => k === value) ? [...items, [value, 0] as [string, number]] : items;
  return (
    <select className="select rv-filter" data-on={value != null || undefined} value={value ?? ""} onChange={(e) => onPick(e.target.value || null)} aria-label={label}>
      <option value="">{all}</option>
      {list.map(([k, n, shown]) => <option key={k} value={k}>{shown ?? k} ({int(n)})</option>)}
    </select>
  );
}

/** The signals (Spam, Blocklisted, Low rep…) as a menu of checkboxes: a domain must have every one ticked. */
function SignalMenu({ counts, value, onToggle, onClear }: { counts: Map<Signal, number>; value: Set<Signal>; onToggle: (k: Signal) => void; onClear: () => void }) {
  const keys = SIGNAL_ORDER.filter((k) => counts.get(k) || value.has(k));
  const picked = SIGNAL_ORDER.filter((k) => value.has(k));
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="select rv-filter rv-menu-btn" data-on={picked.length > 0 || undefined} aria-label="Filter by signal">
          <span className="truncate">{picked.length ? picked.map((k) => SIGNAL_META[k].label).join(", ") : "All signals"}</span>
          <ChevronDown size={13} className="flex-none text-faint" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align="start" sideOffset={6} style={{ minWidth: 230, maxHeight: 420, overflowY: "auto" }}>
          <DropdownMenu.Label className="menu-label">Show domains with</DropdownMenu.Label>
          {keys.length ? keys.map((k) => (
            <DropdownMenu.CheckboxItem key={k} className="menu-item" checked={value.has(k)} onSelect={(e) => { e.preventDefault(); onToggle(k); }} title={SIGNAL_META[k].hint}>
              <span className="grid w-4 place-items-center">{value.has(k) ? <Check size={13} /> : null}</span>
              <span className="flex-1">{SIGNAL_META[k].label}</span>
              <span className="text-faint tabular-nums">{int(counts.get(k) ?? 0)}</span>
            </DropdownMenu.CheckboxItem>
          )) : <div className="menu-item text-faint">No signals in this view</div>}
          {picked.length ? (
            <>
              <DropdownMenu.Separator className="menu-sep" />
              <DropdownMenu.Item className="menu-item" onSelect={onClear}>Clear signals</DropdownMenu.Item>
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Change against the period before, in percentage points for rates. Good is green whichever way it points. */
function Shift({ now, before, invert = false }: { now: number | null; before: number | null; invert?: boolean }) {
  if (now == null || before == null) return null;
  const d = now - before;
  if (Math.abs(d) < 0.005) return <span className="rv-shift">no change</span>;
  const good = invert ? d < 0 : d > 0;
  return <span className={`rv-shift ${good ? "is-good" : "is-bad"}`}>{d > 0 ? "▲" : "▼"} {Math.abs(d).toFixed(2)} pts</span>;
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
  // Active and not active leave out domains deleted in Smartlead: they have their own tab.
  const [scope, setScope] = useState<"active" | "other" | "gone">("active");
  const [clientId, setClientId] = useState<string | null>(null);
  const [slTag, setSlTag] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<"client" | "tag" | "esp" | "tld">("client");
  const [esp, setEsp] = useState<string | null>(null);
  const [tld, setTld] = useState<string | null>(null);
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
  const scopeOf = (d: Judged) => (d.verdict === "gone" ? "gone" : d.status === "active" ? "active" : "other");
  const scopeCount = useMemo(() => {
    const m = { active: 0, other: 0, gone: 0 };
    for (const d of judged) m[scopeOf(d)]++;
    return m;
  }, [judged]);
  const scoped = useMemo(() => judged.filter((d) => scopeOf(d) === scope), [judged, scope]);
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
  const needle = q.trim().toLowerCase();
  const searched = useMemo(() => inScope.filter((d) =>
    !needle || d.name.includes(needle) || d.clientName?.toLowerCase().includes(needle) || [...d.tags, ...d.slTags].some((t) => t.toLowerCase().includes(needle))),
  [inScope, needle]);
  const ofEsp = (d: Judged) => esp == null || espName(d.esp) === esp;
  const ofTld = (d: Judged) => tld == null || (d.tld ?? "?") === tld;
  const ofCall = (d: Judged) => !only || d.verdict === only;
  const ofSig = (d: Judged) => [...signals].every((k) => d.chips.some((c) => c.key === k));
  /** Every filter but the one skipped, so each menu counts what picking an option would leave. */
  const pass = (d: Judged, skip?: "call" | "esp" | "tld" | "sig") =>
    (skip === "call" || ofCall(d)) && (skip === "esp" || ofEsp(d)) && (skip === "tld" || ofTld(d)) && (skip === "sig" || ofSig(d));
  const facets = useMemo(() => {
    const tabs = new Map<Verdict | "", number>([["", 0]]), esps = new Map<string, number>(), tlds = new Map<string, number>(), sigs = new Map<Signal, number>();
    for (const d of searched) {
      if (pass(d, "call")) { tabs.set(d.verdict, (tabs.get(d.verdict) ?? 0) + 1); tabs.set("", tabs.get("")! + 1); }
      if (pass(d, "esp")) esps.set(espName(d.esp), (esps.get(espName(d.esp)) ?? 0) + 1);
      if (pass(d, "tld")) tlds.set(d.tld ?? "?", (tlds.get(d.tld ?? "?") ?? 0) + 1);
      if (pass(d, "sig")) for (const c of d.chips) sigs.set(c.key, (sigs.get(c.key) ?? 0) + 1);
    }
    return {
      tabs, sigs,
      esps: [...esps.entries()].sort((a, b) => ESP_ORDER.indexOf(a[0]) - ESP_ORDER.indexOf(b[0])) as [string, number][],
      tlds: [...tlds.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => [k, n, k === "?" ? "No TLD" : `.${k}`]) as [string, number, string][],
    };
  }, [searched, only, esp, tld, signals]); // eslint-disable-line react-hooks/exhaustive-deps
  // The domains behind the totals: every filter but the call tab.
  const viewed = useMemo(() => searched.filter((d) => pass(d, "call")), [searched, esp, tld, signals]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => viewed.filter(ofCall)
    .sort((a, b) => cmp(sortValue(a, sort.key), sortValue(b, sort.key), sort.dir) || a.name.localeCompare(b.name)),
  [viewed, only, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const kpi = useMemo(() => {
    const k = { sent: 0, human: 0, bounces: 0, spam: 0, prevSent: 0, prevHuman: 0, prevSpam: 0, inboxes: 0, disconnected: 0, calls: {} as Partial<Record<Verdict, number>> };
    for (const d of viewed) {
      k.sent += d.sent; k.human += d.human; k.bounces += d.bounces; k.spam += d.spam;
      k.prevSent += d.prevSent; k.prevHuman += d.prevHuman; k.prevSpam += d.prevSpam;
      k.inboxes += d.inboxes; k.disconnected += d.disconnected;
      k.calls[d.verdict] = (k.calls[d.verdict] ?? 0) + 1;
    }
    return k;
  }, [viewed]);
  const filtering = esp != null || tld != null || signals.size > 0 || !!needle;
  const clearFilters = () => { setEsp(null); setTld(null); setSignals(new Set()); setQ(""); };

  const causes = useMemo(() => {
    const t: Partial<Record<BounceReason, number>> = {};
    for (const d of viewed) for (const [k, v] of Object.entries(d.causes) as [BounceReason, number][]) t[k] = (t[k] ?? 0) + v;
    return t;
  }, [viewed]);
  const causeTotal = Object.values(causes).reduce((a, b) => a + (b ?? 0), 0);
  const lists = useMemo(() => {
    const names = new Set(inScope.map((d) => d.clientName));
    return badLists(data.campaigns).filter((c) => clientId == null || names.has(c.clientName));
  }, [data.campaigns, inScope, clientId]);
  const knownTags = useMemo(() => [...new Set([...MARK_CHOICES, ...[...new Set(["Fix", "Idle", ...data.domains.flatMap((d) => d.tags)])].filter((t) => !markOf(t)).sort()])], [data.domains]);

  const selectedRows = rows.filter((r) => selected.has(r.id));
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleSignal = (k: Signal) => setSignals((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "name" || key === "client" || key === "esp" ? 1 : -1 }));
  // Every domain the tab shows, with the tag its call suggests ready in the bar.
  const selectShown = () => {
    setSelected(new Set(rows.map((d) => d.id)));
    if (only) setTag(LIST_TAG[only] ?? VERDICT_META[only].label.split(" ")[0]);
  };
  const reload = async () => {
    const again = await loadReview({ from: data.from, to: data.to });
    if (again.ok) setData(again.data);
  };
  const groupRows: ClientSummary[] = groupBy === "client" ? clientRows : groupBy === "tag" ? tagRows : groupBy === "esp" ? byEsp(inScope) : byTld(inScope);
  const groupOn = (c: ClientSummary) => (groupBy === "client" ? c.id === clientId : groupBy === "tag" ? c.id === slTag : groupBy === "esp" ? c.id === esp : c.id === tld);
  const groupPick = (c: ClientSummary) => {
    const on = groupOn(c);
    if (groupBy === "client") pickClient(on ? null : c.id);
    else if (groupBy === "tag") pickTag(on ? null : c.id);
    else if (groupBy === "esp") setEsp(on ? null : c.id);
    else setTld(on ? null : c.id);
  };
  // A mark goes to the inboxes in Smartlead as well; any other tag stays in the app.
  const mark = markOf(tag);
  const applyTag = (on: boolean) => startTag(async () => {
    const domainIds = selectedRows.map((d) => d.id);
    if (mark) {
      const r = await markDomains({ domainIds, mark, on });
      if (!r.ok) return void toast.error(r.error);
      toast.success(r.data.message);
    } else {
      const r = await tagDomains({ domainIds, tag, on });
      if (!r.ok) return void toast.error(r.error);
      toast.success(on ? `Tagged ${plural(r.data.changed, "domain")} ${tag.trim()} (in this app only)` : `Took ${tag.trim()} off ${plural(r.data.changed, "domain")}`);
    }
    await reload();
  });

  const kc = (v: Verdict) => kpi.calls[v] ?? 0;
  const action = kc("fix") + kc("rest") + kc("drop") + kc("dead");
  const actionFoot = [
    kc("fix") ? `${int(kc("fix"))} fix` : "", kc("rest") ? `${int(kc("rest"))} replace` : "",
    kc("drop") ? `${int(kc("drop"))} delete` : "", kc("dead") ? `${int(kc("dead"))} reconnect` : "",
  ].filter(Boolean).join(" · ");
  const current = at >= 0 ? clientRows[at] : null;

  return (
    <div className="flex flex-col gap-3" style={{ opacity: loading ? 0.6 : 1, transition: "opacity 120ms" }}>
      <div className="table-bar">
        <div className="view-tabs" role="tablist" aria-label="Domains">
          <button type="button" role="tab" aria-selected={scope === "active"} className={scope === "active" ? "is-on" : undefined} onClick={() => { setScope("active"); setSelected(new Set()); setOnly(""); }}
            title="Active domains still in Smartlead">
            Active <span>{int(scopeCount.active)}</span>
          </button>
          <button type="button" role="tab" aria-selected={scope === "other"} className={scope === "other" ? "is-on" : undefined} onClick={() => { setScope("other"); setSelected(new Set()); setOnly(""); }}
            title="Warming, draining, and any other domain that sent in this range, still in Smartlead">
            Not active <span>{int(scopeCount.other)}</span>
          </button>
          {scopeCount.gone || scope === "gone" ? (
            <button type="button" role="tab" aria-selected={scope === "gone"} className={scope === "gone" ? "is-on" : undefined} onClick={() => { setScope("gone"); setSelected(new Set()); setOnly(""); }}
              title="Every inbox was deleted in Smartlead. Kept out of the other tabs: their numbers are history">
              Deleted in Smartlead <span>{int(scopeCount.gone)}</span>
            </button>
          ) : null}
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
        {data.slSyncedAt ? <span className="sl-synced" suppressHydrationWarning title="Connected, disconnected and deleted come from the last Smartlead sync (Settings → Background sync)">Smartlead status {ago(data.slSyncedAt)}</span> : null}
        <select className="select" style={{ width: 190 }} value={slTag ?? "*"} onChange={(e) => pickTag(e.target.value === "*" ? null : e.target.value)} aria-label="Filter by Smartlead tag">
          <option value="*">All Smartlead tags</option>
          {[...tagRows].sort((a, b) => (a.id ? 0 : 1) - (b.id ? 0 : 1) || a.name.localeCompare(b.name)).map((t) => <option key={t.id || "none"} value={t.id}>{t.name} ({t.domains})</option>)}
          {slTag != null && !tagRows.some((t) => t.id === slTag) ? <option value={slTag}>{slTag || "No tag"}</option> : null}
        </select>
      </div>

      <section className="stats is-6 rv-kpis" aria-label="This view">
        <button type="button" className={`stat rv-kpi${action ? " is-danger" : ""}`} onClick={() => setOnly(kc("rest") ? "rest" : kc("fix") ? "fix" : kc("drop") ? "drop" : kc("dead") ? "dead" : "")}
          title="Fix sender, Replace, Cancelled / replaced and Disconnected. Click to open the biggest list">
          <span className="stat-label">Needs action</span>
          <span className="stat-value">{int(action)}</span>
          <span className="stat-foot">{actionFoot || "nothing to fix or replace"}</span>
        </button>
        <button type="button" className={`stat rv-kpi${kc("watch") ? " is-warning" : ""}`} onClick={() => setOnly(kc("watch") ? "watch" : "")} title={VERDICT_META.watch.hint}>
          <span className="stat-label">Watch</span>
          <span className="stat-value">{int(kc("watch"))}</span>
          <span className="stat-foot">{kc("idle") ? `${int(kc("idle"))} idle · ` : ""}{int(kc("ok"))} OK</span>
        </button>
        <div className="stat">
          <span className="stat-label">Domains</span>
          <span className="stat-value">{int(viewed.length)}</span>
          <span className="stat-foot">{int(kpi.inboxes)} inboxes{kpi.disconnected ? <> · <span className="text-danger-ink">{int(kpi.disconnected)} disconnected</span></> : null}</span>
        </div>
        <div className="stat" title={`Compared with ${previousLabel(data.from, data.to)}`}>
          <span className="stat-label">Sent · {nice(data.from)}{data.from === data.to ? "" : ` – ${nice(data.to)}`}</span>
          <span className="stat-value">{int(kpi.sent)}</span>
          <span className="stat-foot">vs {int(kpi.prevSent)} before</span>
        </div>
        <div className="stat">
          <span className="stat-label">Human reply rate</span>
          <span className="stat-value">{fx(pct(kpi.human, kpi.sent), 2)}</span>
          <span className="stat-foot">{int(kpi.human)} human <Shift now={pct(kpi.human, kpi.sent)} before={pct(kpi.prevHuman, kpi.prevSent)} /></span>
        </div>
        <div className="stat">
          <span className="stat-label">Bounce · spam</span>
          <span className="stat-value">{fx(pct(kpi.bounces, kpi.sent))}<span className="rv-kpi-sub"> · {fx(pct(kpi.spam, kpi.sent), 2)}</span></span>
          <span className="stat-foot">{int(kpi.bounces)} bounces · {int(kpi.spam)} spam <Shift now={pct(kpi.spam, kpi.sent)} before={pct(kpi.prevSpam, kpi.prevSent)} invert /></span>
        </div>
      </section>

      <div className="table-wrap rv-board">
        <div className="rv-board-head">
          <div className="view-tabs rv-calls" role="tablist" aria-label="Call">
            <button type="button" role="tab" aria-selected={!only} className={!only ? "is-on" : undefined} onClick={() => setOnly("")}>All <span>{int(facets.tabs.get("") ?? 0)}</span></button>
            {VERDICT_ORDER.filter((v) => facets.tabs.get(v) || only === v).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={only === v} className={only === v ? "is-on" : undefined} onClick={() => setOnly(v)} title={VERDICT_META[v].hint}>
                {VERDICT_META[v].label} <span className={`rv-count tone-${LISTS.includes(v) ? VERDICT_META[v].tone : "faint"}`}>{int(facets.tabs.get(v) ?? 0)}</span>
              </button>
            ))}
          </div>
          <div className="rv-board-tools">
            <SlidersHorizontal size={14} className="text-faint flex-none" aria-hidden />
            <FacetSelect label="Filter by ESP" all="All ESPs" items={facets.esps} value={esp} onPick={setEsp} />
            <FacetSelect label="Filter by TLD" all="All TLDs" items={facets.tlds} value={tld} onPick={setTld} />
            <SignalMenu counts={facets.sigs} value={signals} onToggle={toggleSignal} onClear={() => setSignals(new Set())} />
            {filtering ? <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}><X size={13} /> Clear</button> : null}
            <span className="spacer-auto" />
            <label className="search-input rv-search">
              <Search size={14} strokeWidth={1.5} />
              <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search domain, client, tag" aria-label="Search domains" />
            </label>
            <PasteSelect rows={inScope} selected={selected} where="in this review"
              onSelect={(s) => { setSelected(s); setOnly(""); clearFilters(); }} />
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button type="button" className="btn btn-sm" disabled={!rows.length}><Copy size={13} /> Copy <ChevronDown size={12} className="text-faint" /></button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu" align="end" sideOffset={6} style={{ minWidth: 220 }}>
                  <DropdownMenu.Label className="menu-label">{plural(rows.length, "domain")} in this view</DropdownMenu.Label>
                  <DropdownMenu.Item className="menu-item" onSelect={() => copy(rows.map((d) => d.name).join("\n"), plural(rows.length, "domain"))}><Copy size={13} /> Domain names</DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item" onSelect={() => copy(sheetRows(rows), `${plural(rows.length, "domain")} for Sheets`)}><Sheet size={13} /> For Google Sheets, with reasons</DropdownMenu.Item>
                  <DropdownMenu.Separator className="menu-sep" />
                  <DropdownMenu.Item className="menu-item" onSelect={selectShown}><ListChecks size={13} /> Select all {int(rows.length)}</DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
          {only ? <p className="rv-board-hint" title={VERDICT_META[only].hint}><b>{VERDICT_META[only].label}:</b> {VERDICT_META[only].hint}</p> : null}
        </div>
        <div className="table-scroll" style={{ maxHeight: "calc(100dvh - 300px)", minHeight: 320 }}>
          <table className="data-table is-main">
            <thead>
              <tr>
                <th style={{ width: 36 }}><input type="checkbox" className="checkbox" aria-label="Select all" checked={allSelected} onChange={() => (allSelected ? setSelected(new Set()) : selectShown())} /></th>
                <SortTh k="name" sort={sort} onSort={sortBy}>Domain</SortTh>
                <SortTh k="client" sort={sort} onSort={sortBy}>Client</SortTh>
                <SortTh k="verdict" sort={sort} onSort={sortBy}>Call</SortTh>
                <SortTh k="signals" sort={sort} onSort={sortBy} title="Strikes first: spam, blocklisted, low reputation, no reply, no response">Why</SortTh>
                <SortTh k="esp" sort={sort} onSort={sortBy}>ESP</SortTh>
                <th title="Connected, disconnected or deleted in Smartlead now, as of the last sync">Smartlead now</th>
                <SortTh k="sent" sort={sort} onSort={sortBy} num>Sent</SortTh>
                <SortTh k="replies" sort={sort} onSort={sortBy} num title="Every reply, out of office included">Replies</SortTh>
                <SortTh k="human" sort={sort} onSort={sortBy} num>Human</SortTh>
                <SortTh k="quiet" sort={sort} onSort={sortBy} num title="Days since the last reply of any kind, out of office included">Last reply</SortTh>
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
                    <td className="rv-why-cell" title={r.why}>
                      <span className="rv-why-line">
                        {r.chips.length ? <Chips chips={r.chips} /> : null}
                        <span className="rv-why">{r.why}</span>
                      </span>
                    </td>
                    <td><EspBadge esp={r.esp} /></td>
                    <td><SlBadge c={{ slConnected: r.inboxes, slDisconnected: r.disconnected, slRemoved: r.removed }} /></td>
                    <td className="is-num">{r.sent ? int(r.sent) : <span className="zero">0</span>}</td>
                    <td className="is-num">{r.replies ? int(r.replies) : <span className={r.sent >= RULES.silentSent ? "metric is-bad" : "zero"}>0</span>}</td>
                    <td className="is-num">{r.human ? int(r.human) : <span className="zero">0</span>}</td>
                    <td className="is-num" title={r.quietDays == null ? "Nothing sent yet" : r.neverReplied ? `No reply on record (${int(r.sentSinceReply)} sent)` : `${int(r.sentSinceReply)} sent since`}>
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
                    <td><TagList tags={r.tags} max={3} /></td>
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

      <div className="card">
        <div className="card-head">
          <div className="seg" role="group" aria-label="Group by">
            <button type="button" aria-pressed={groupBy === "client"} onClick={() => setGroupBy("client")}>By client</button>
            <button type="button" aria-pressed={groupBy === "tag"} onClick={() => setGroupBy("tag")}>By Smartlead tag</button>
            <button type="button" aria-pressed={groupBy === "esp"} onClick={() => setGroupBy("esp")}>By ESP</button>
            <button type="button" aria-pressed={groupBy === "tld"} onClick={() => setGroupBy("tld")}>By TLD</button>
          </div>
          <span className="card-sub">{groupBy === "client"
            ? "Worst first. Click a client to see only its domains; the arrows up top step through them"
            : groupBy === "tag" ? "Worst first. A domain with two tags counts under both. Click a tag to see only its domains"
            : `Worst first. Click a${groupBy === "esp" ? "n ESP" : " TLD"} to see only its domains`}</span>
        </div>
        <div className="table-scroll" style={{ maxHeight: 320 }}>
          <table className="data-table rv-clients">
            <thead>
              <tr>
                <th>{groupBy === "client" ? "Client" : groupBy === "tag" ? "Smartlead tag" : groupBy === "esp" ? "ESP" : "TLD"}</th>
                <th className="is-num">Domains</th>
                {LISTS.map((v) => <th key={v} className="is-num" title={VERDICT_META[v].hint}>{VERDICT_META[v].label}</th>)}
                <th className="is-num">Sent</th>
                <th className="is-num" title="Human replies per email sent">Human</th>
                <th className="is-num" title="Spam and blocklist rejections per email sent">Spam</th>
                <th className="is-num">Bounce</th>
              </tr>
            </thead>
            <tbody>
              {groupRows.map((c: ClientSummary) => {
                const on = groupOn(c);
                return (
                <tr key={c.id || "none"} data-active={on} className="is-clickable" onClick={() => groupPick(c)}>
                  <td>{groupBy === "client" ? <ClientCell name={c.name} hue={c.hue} /> : groupBy === "esp" ? <EspBadge esp={c.id === "Unknown" ? null : c.id.toUpperCase()} />
                    : groupBy === "tld" ? <span className="strong">{c.name}</span> : c.id ? <span className="badge">{c.name}</span> : <span className="zero">No tag</span>}</td>
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
          {groupRows.length === 0 ? <p className="rv-none" style={{ padding: "10px 14px" }}>No domains here.</p> : null}
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

      {selectedRows.length > 0 ? (
        <div className="bulk-bar" role="toolbar" aria-label="Selected domains">
          <span className="bulk-count">{selectedRows.length} selected</span>
          <ConfigureDomains domainIds={selectedRows.map((d) => d.id)} onDone={() => void reload()} />
          <span className="sep" />
          <input className="rv-tag-input" list="rv-tags" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Tag name" aria-label="Tag name"
            onKeyDown={(e) => { if (e.key === "Enter" && tag.trim()) applyTag(true); }} />
          <datalist id="rv-tags">{knownTags.map((t) => <option key={t} value={t} label={markOf(t) ? "Also in Smartlead" : "This app only"} />)}</datalist>
          {tag.trim() ? <span className="rv-tag-where" title={mark ? "Every inbox of these domains gets this tag in Smartlead too, so you can filter and delete them there" : `Only marks go to Smartlead: ${MARK_CHOICES.join(", ")}`}>{mark ? "+ Smartlead" : "App only"}</span> : null}
          <button type="button" className="btn btn-primary btn-sm" disabled={!tag.trim() || tagging} onClick={() => applyTag(true)}><TagsIcon size={14} /> {tagging ? "Tagging…" : "Add tag"}</button>
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
