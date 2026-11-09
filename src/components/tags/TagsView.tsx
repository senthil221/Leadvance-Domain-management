"use client";

import { ArrowRightLeft, Plus, Search, Tags as TagsIcon, TriangleAlert, UserRound, Wand2, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useSearchParams } from "next/navigation";
import { Fragment, useLayoutEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { addDomainsToTag, removeDomainsFromTag, saveTagTarget } from "@/app/actions";
import { ColumnsMenu, useColumns, type ColumnDef } from "@/components/Columns";
import { Select } from "@/components/Select";
import { ColResizer, useColumnWidths } from "@/components/table-tools";
import { Empty, Rep, StatusDot } from "@/components/ui";
import { int } from "@/lib/format";
import {
  buildTags, clientTagsOf, fillPick, fillPlan, freeState, isPoolTag, mainCampaigns, sameSender, senderOff, volumeOn, warmupOf,
  type BoardCampaign, type BoardDomain, type BoardTag, type FillStep,
} from "@/lib/tag-board";
import { normTag } from "@/lib/tag-map";

type Result = { ok: true; data: { message: string } } | { ok: false; error: string };
type Widths = ReturnType<typeof useColumnWidths>;

// ── Tag list columns ────────────────────────────────────────────────────────
type TagCol = "tag" | "client" | "sender" | "domains" | "inboxes" | "volume" | "target" | "gap" | "progress" | "sent" | "rep";
const TAG_COLS: (ColumnDef<TagCol> & { width: number; num?: boolean; title?: string })[] = [
  { key: "tag", label: "Tag", locked: true, width: 170 },
  { key: "client", label: "Client", width: 130, title: "The client most of its domains belong to" },
  { key: "sender", label: "Sender", width: 190, title: "The sender name most of its inboxes use; the badge counts domains with an inbox under another name" },
  { key: "domains", label: "Domains", width: 78, num: true },
  { key: "inboxes", label: "Inboxes", width: 84, num: true, title: "Connected inboxes, and disconnected ones in red" },
  { key: "volume", label: "Volume / day", width: 118, num: true, locked: true, title: "Campaign emails a day: the daily limits of the connected inboxes, added up" },
  { key: "target", label: "Target", width: 96, num: true, locked: true, title: "The volume you want this tag to reach. Type to change it" },
  { key: "gap", label: "vs target", width: 86, num: true, title: "Volume minus target" },
  { key: "progress", label: "Toward target", width: 220, title: "Volume as a share of the target" },
  { key: "sent", label: "Sent today", width: 88, num: true, hidden: true },
  { key: "rep", label: "Rep.", width: 66, num: true },
];
const TAG_WIDTHS = Object.fromEntries(TAG_COLS.map((c) => [c.key, c.width]));
/** With a tag open, the list keeps only what you need to pick and set targets, at these widths. */
const COMPACT: TagCol[] = ["tag", "volume", "target"];
const RAIL_WIDTHS: Partial<Record<TagCol, number>> = { volume: 104, target: 84 };

// ── Domain table columns (inside a tag) ────────────────────────────────────
const ON_COLS = [
  { key: "domain", label: "Domain", width: 200 }, { key: "status", label: "Status", width: 196 },
  { key: "inboxes", label: "Inboxes", width: 74, num: true }, { key: "volume", label: "Volume", width: 74, num: true },
  { key: "rep", label: "Rep.", width: 62, num: true }, { key: "sender", label: "Sender", width: 160 },
  { key: "campaigns", label: "Camp.", width: 64, num: true, title: "Campaigns its inboxes are in" },
] as const;
const POOL_COLS = [
  { key: "domain", label: "Domain", width: 200 }, { key: "from", label: "Pool", width: 76 },
  { key: "warmup", label: "Warm-up", width: 104 }, { key: "inboxes", label: "Inboxes", width: 74, num: true },
  { key: "adds", label: "Adds / day", width: 86, num: true, title: "Its connected inboxes at this tag's usual daily limit" },
  { key: "rep", label: "Rep.", width: 62, num: true }, { key: "sender", label: "Sender", width: 160 },
] as const;
type SubCol = { key: string; label: string; width: number; num?: boolean; title?: string };
const widthsOf = (cols: readonly SubCol[]) => Object.fromEntries(cols.map((c) => [c.key, c.width]));
const ON_WIDTHS = widthsOf(ON_COLS);
const POOL_WIDTHS = widthsOf(POOL_COLS);

const CHECK_W = 34;

/** Volume against the target: a thin bar, full at the target. */
function VolumeBar({ volume, target }: { volume: number; target: number | null }) {
  if (!target) return null;
  const pct = Math.min(100, (100 * volume) / target);
  return (
    <span className={`tg-bar${volume >= target ? " is-met" : ""}`} title={`${int(volume)} of ${int(target)} a day (${Math.round((100 * volume) / target)}%)`}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

/** Status, with the grace days left for a replaced domain and the expiry when it's close. */
function DomainState({ d, now }: { d: BoardDomain; now: number }) {
  const days = d.expiresAt ? Math.floor((new Date(d.expiresAt).getTime() - now) / 86_400_000) : null;
  return (
    <span className="tg-state">
      {d.status === "draining" && d.graceDaysLeft != null
        ? <span className="status-dot tone-warning" title="Replaced: still sending through its grace period">Replaced · {d.graceDaysLeft}d</span>
        : <StatusDot status={d.status} />}
      {d.beingReplaced && d.status !== "draining" ? <span className="badge" title="A replacement for this domain is under way">Replacing</span> : null}
      {days != null && days <= 30 ? <span className={`badge ${days < 0 ? "tone-danger" : "tone-warning"}`} title={`Registration ends ${d.expiresAt}`}>{days < 0 ? "Expired" : `${days}d left`}</span> : null}
    </span>
  );
}

function Sender({ d, tagSender }: { d: BoardDomain; tagSender: string | null }) {
  const main = d.senders[0]?.name ?? null;
  if (!main) return <span className="zero">—</span>;
  const off = senderOff(d, tagSender);
  return (
    <span className={off ? "tg-sender is-off" : "tg-sender"} title={d.senders.map((s) => `${s.name} ×${s.count}`).join(", ") + (off ? ` · the tag's sender is ${tagSender}` : "")}>
      {off ? <TriangleAlert size={12} aria-label="Sender doesn't match" /> : null}{main}{d.senders.length > 1 ? <em> +{d.senders.length - 1}</em> : null}
    </span>
  );
}

/** A header cell that can be resized. */
function Th({ col, label, w, num, title, children }: { col: string; label: string; w: Widths; num?: boolean; title?: string; children?: ReactNode }) {
  return (
    <th className={num ? "is-num" : undefined} title={title}>
      {children ?? label}
      <ColResizer col={col} label={label} onResize={w.setWidth} />
    </th>
  );
}

const tableWidth = (w: Widths, keys: string[], extra = 0) => keys.reduce((a, k) => a + (w.width(k) ?? 0), extra);
/** Fills its panel: the `flex` column takes whatever the others leave, down to `floor`. */
const fillStyle = (w: Widths, keys: string[], flex: string, floor: number, extra = 0) =>
  ({ width: "100%", minWidth: tableWidth(w, keys.filter((k) => k !== flex), extra) + floor });
const colWidth = (w: Widths, key: string, flex: string) => (key === flex ? undefined : w.width(key));

/** The target, typed straight into the list: saved on Enter or when you leave the field. */
function TargetInput({ tag, disabled, tile }: { tag: BoardTag; disabled?: boolean; tile?: boolean }) {
  const [v, setV] = useState(tag.target ? int(tag.target) : "");
  const [pending, start] = useTransition();
  const save = () => {
    const n = v.trim() ? Math.round(Number(v.replace(/[, ]/g, ""))) : 0;
    if (!Number.isFinite(n) || n < 0) { toast.error("Enter a number of emails a day"); setV(tag.target ? int(tag.target) : ""); return; }
    if ((tag.target ?? 0) === n) return;
    start(async () => {
      const r = await saveTagTarget(tag.name, n || null);
      if (!r.ok) toast.error(r.error);
    });
  };
  return (
    <input className={`input num tg-target-in${tile ? " is-tile" : ""}`} inputMode="numeric" value={v} placeholder={tile ? "Set a target" : "—"} disabled={disabled || pending}
      title="The emails a day this tag should reach. Type a number; Enter saves"
      onClick={(e) => e.stopPropagation()} onChange={(e) => setV(e.target.value)} onBlur={save}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setV(tag.target ? int(tag.target) : ""); e.currentTarget.blur(); } }}
      aria-label={`Volume target for ${tag.name}`} />
  );
}

export function TagsView({ domains, campaigns, targets, dryRun, appProblem }: {
  domains: BoardDomain[]; campaigns: BoardCampaign[]; targets: Record<string, number>;
  dryRun: boolean; appProblem: string | null;
}) {
  const tags = useMemo(() => buildTags(domains, targets), [domains, targets]);
  const pool = useMemo(() => domains.filter((d) => freeState(d).free), [domains]);
  const poolReady = useMemo(() => pool.filter((d) => freeState(d).ready), [pool]);
  const campaignName = useMemo(() => new Map(campaigns.map((c) => [c.id, c.name])), [campaigns]);
  const cols = useColumns<TagCol>("tags", TAG_COLS);
  const widths = useColumnWidths("tags", TAG_WIDTHS);
  const [q, setQ] = useState("");
  const params = useSearchParams();
  const [picked, setPicked] = useState<string | null>(() => params.get("tag"));
  const [client, setClient] = useState(() => params.get("client") ?? "");
  const tag = tags.find((t) => t.key === picked) ?? null;
  const [newTag, setNewTag] = useState<string | null>(null);
  const [fillOpen, setFillOpen] = useState(false);
  const [pending, start] = useTransition();
  const blocked = Boolean(appProblem);
  // The panels run to the bottom of the window: measure where they start.
  const layoutRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = layoutRef.current;
    if (!el) return;
    const set = () => el.style.setProperty("--tg-top", `${Math.round(el.getBoundingClientRect().top + window.scrollY) + 32}px`);
    set();
    window.addEventListener("resize", set);
    return () => window.removeEventListener("resize", set);
  }, [dryRun, appProblem]);

  const setParam = (name: string, value: string | null) => {
    const p = new URLSearchParams(window.location.search);
    if (value) p.set(name, value); else p.delete(name);
    window.history.replaceState(null, "", p.toString() ? `?${p}` : window.location.pathname);
  };
  const pick = (key: string | null) => { setPicked(key); setParam("tag", key); };
  const pickClient = (name: string) => { setClient(name); setParam("client", name || null); };

  // The client filter keeps that client's tags (and tags with no domains yet, which have no client) plus the pool.
  const clientNames = useMemo(() => [...new Set(tags.flatMap((t) => (t.client ? [t.client] : [])))].sort((a, b) => a.localeCompare(b)), [tags]);
  const forClient = (t: BoardTag) => t.pool || !client || t.client === client || (!t.domains.length && !t.client);
  const inScope = tags.filter(forClient);
  const plan = fillPlan(inScope, pool);
  const needle = normTag(q);
  const shown = tags.filter((t) => forClient(t) && (!needle || t.key.includes(needle) || normTag(t.sender ?? "").includes(needle)
    || normTag(t.client ?? "").includes(needle) || t.domains.some((d) => d.name.includes(needle))));
  const clientTags = inScope.filter((t) => !t.pool);
  const total = clientTags.reduce((a, t) => a + t.volume, 0);
  const offTotal = clientTags.reduce((a, t) => a + t.offSender, 0);
  const targetTotal = clientTags.reduce((a, t) => a + (t.target ?? 0), 0);
  const visible = TAG_COLS.filter((c) => (tag ? COMPACT.includes(c.key) : cols.on(c.key)));
  // The progress bar (or the sender, or the tag name) takes the list's spare width.
  const flexCol: TagCol = (["progress", "sender", "tag"] as TagCol[]).find((k) => visible.some((c) => c.key === k))!;

  const createTag = () => {
    const name = (newTag ?? "").trim();
    if (!name) return;
    start(async () => {
      const r = await saveTagTarget(name, 1);
      if (!r.ok) return void toast.error(r.error);
      toast.success(`${name} added. Set its target, then add domains from the pool`);
      setNewTag(null);
      pick(normTag(name));
    });
  };

  const cell = (t: BoardTag, k: TagCol) => {
    switch (k) {
      case "tag": return (
        <span className="tg-name-cell">
          <span className="strong tg-clip">{t.name}</span>
          {tag && t.offSender ? <span className="tg-off" title={`${t.offSender} domains with an inbox under another sender name`}><TriangleAlert size={11} />{t.offSender}</span> : null}
        </span>
      );
      case "client": return t.pool ? <span className="zero">—</span> : t.client ? (
        <span className="tg-sender-cell" title={t.clients.map((c) => `${c.name}: ${c.domains} domain${c.domains === 1 ? "" : "s"}`).join("\n")}>
          <span className="tg-clip">{t.client}</span>
          {t.clients.length > 1 ? <span className="tg-also">+{t.clients.length - 1}</span> : null}
        </span>
      ) : <span className="zero">—</span>;
      case "sender": return t.pool ? <span className="zero">Each its own</span> : (
        <span className="tg-sender-cell">
          <span className="tg-clip">{t.sender ?? <span className="zero">—</span>}</span>
          {t.offSender ? <span className="badge tone-warning" title={`${t.offSender} of its domains have an inbox under another sender name`}>{t.offSender} off</span> : null}
        </span>
      );
      case "domains": return int(t.domains.length);
      case "inboxes": return <>{int(t.connected)}{t.disconnected ? <span className="tg-disc"> +{int(t.disconnected)}</span> : null}</>;
      case "volume": return tag ? <span className="tg-vol">{int(t.volume)}<VolumeBar volume={t.volume} target={t.target} /></span> : int(t.volume);
      case "progress": return t.target ? (
        <span className="tg-prog">
          <VolumeBar volume={t.volume} target={t.target} />
          <span className={t.volume >= t.target ? "tg-met" : undefined}>{Math.round((100 * t.volume) / t.target)}%</span>
        </span>
      ) : <span className="zero">{t.pool ? "—" : "No target"}</span>;
      case "target": return t.pool ? <span className="zero">—</span> : <TargetInput key={`${t.key}:${t.target ?? ""}`} tag={t} />;
      case "gap": {
        if (!t.target) return <span className="zero">—</span>;
        const gap = t.volume - t.target;
        return <span className={gap >= 0 ? "tg-met" : "tg-gap"}>{gap >= 0 ? "+" : "−"}{int(Math.abs(gap))}</span>;
      }
      case "sent": return int(t.sentToday);
      case "rep": return <Rep value={t.rep} />;
    }
  };

  const row = (t: BoardTag) => (
    <tr key={t.key} className="is-clickable" data-selected={t.key === picked} onClick={() => pick(t.key === picked ? null : t.key)}>
      {visible.map((c) => <td key={c.key} className={c.num ? "is-num" : c.key === "tag" ? "col-first" : undefined}>{cell(t, c.key)}</td>)}
    </tr>
  );
  const shownClient = shown.filter((t) => !t.pool);
  const shownPool = shown.filter((t) => t.pool);

  return (
    <div className="tg">
      <div className="toolbar">
        <label className="search-input">
          <Search size={14} strokeWidth={1.5} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tags, senders or domains" aria-label="Search tags" />
        </label>
        <Select className="select tg-client" style={{ width: 150 }} value={client} onChange={(e) => pickClient(e.target.value)} aria-label="Filter by client"
          title="Only this client's tags; the totals and Fill to targets follow">
          <option value="">All clients</option>
          {clientNames.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        <dl className="inb-kpis tg-kpistrip" aria-label="Tag numbers">
          <div className="inb-kpi" title={client ? `${client}'s tags` : "Client tags (Free and warmup are the pool)"}><dt>Tags</dt><dd>{int(clientTags.length)}</dd></div>
          <div className="inb-kpi" title={targetTotal ? `${int(total)} of the ${int(targetTotal)} a day the targets add up to` : "Campaign emails a day across client tags"}>
            <dt>Volume / day</dt><dd>{int(total)}</dd>{targetTotal ? <span>of {int(targetTotal)}</span> : null}
          </div>
          <div className="inb-kpi" title="Domains with an inbox under a sender name other than their tag's">
            <dt>Off-sender</dt><dd className={offTotal ? "tg-gap" : undefined}>{int(offTotal)}</dd>
          </div>
          <div className="inb-kpi" title={`${int(pool.length)} domains tagged Free or warmup, ${int(poolReady.length)} warmed up`}>
            <dt>Pool ready</dt><dd>{int(poolReady.length)}</dd><span>of {int(pool.length)}</span>
          </div>
        </dl>
        <span className="spacer-auto" />
        <button type="button" className="btn btn-sm" disabled={!plan.length} onClick={() => setFillOpen(true)}
          title={plan.length ? "Shows which pool domains would go to which tag to reach the targets, before anything changes" : "Every tag with a target has reached it, or the pool has nothing ready"}>
          <Wand2 size={14} /> Fill to targets{plan.length ? ` (${plan.length})` : ""}
        </button>
        {tag ? null : <ColumnsMenu cols={cols} widths={widths} />}
        {newTag == null ? (
          <button type="button" className="btn btn-sm" onClick={() => setNewTag("")}><Plus size={14} /> New tag</button>
        ) : (
          <span className="flex items-center gap-1.5">
            <input className="input" autoFocus value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder="Tag name, as in Smartlead"
              onKeyDown={(e) => { if (e.key === "Enter") createTag(); if (e.key === "Escape") setNewTag(null); }} aria-label="New tag name" />
            <button type="button" className="btn btn-sm btn-primary" disabled={pending || !newTag.trim()} onClick={createTag}>Add</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setNewTag(null)} aria-label="Cancel"><X size={14} /></button>
          </span>
        )}
      </div>
      {dryRun ? <p className="tg-note">Dry run is on: tag changes are made in the app only, Smartlead isn&apos;t changed.</p> : null}
      {appProblem ? <p className="tg-note is-warn">{appProblem}</p> : null}

      <div ref={layoutRef} className={`tg-layout${tag ? " has-detail" : ""}`}>
        <div className="table-wrap tg-list">
          <div className="table-scroll">
            <table className="data-table is-main is-fixed tg-table" style={tag ? { width: "100%" } : fillStyle(widths, visible.map((c) => c.key), flexCol, 120)}>
              <colgroup>{visible.map((c) => <col key={c.key} style={{ width: tag ? (c.key === "tag" ? undefined : RAIL_WIDTHS[c.key]) : colWidth(widths, c.key, flexCol) }} />)}</colgroup>
              <thead>
                <tr>{visible.map((c) => <Th key={c.key} col={c.key} label={c.label} w={widths} num={c.num} title={c.title} />)}</tr>
              </thead>
              <tbody>
                {shownClient.map(row)}
                {shownPool.length ? (
                  <Fragment>
                    <tr className="tg-group"><td colSpan={visible.length}>Pool <span>· waiting for a tag · {int(poolReady.length)} of {int(pool.length)} warmed up</span></td></tr>
                    {shownPool.map(row)}
                  </Fragment>
                ) : null}
              </tbody>
            </table>
            {shown.length === 0 ? <Empty icon={TagsIcon} title={tags.length ? "No tag matches" : "No tags yet"}>Tags come from Smartlead. Inboxes tagged there show up here after the next sync.</Empty> : null}
          </div>
        </div>
        {tag ? (
          <TagDetail key={tag.key} tag={tag} tags={tags} pool={pool} campaignName={campaignName} blocked={blocked} onClose={() => pick(null)} />
        ) : null}
      </div>

      <FillDialog open={fillOpen} onOpenChange={setFillOpen} plan={plan} campaignName={campaignName} blocked={appProblem} />
    </div>
  );
}

function TagDetail({ tag, tags, pool, campaignName, blocked, onClose }: {
  tag: BoardTag; tags: BoardTag[]; pool: BoardDomain[]; campaignName: Map<number, string>; blocked: boolean; onClose: () => void;
}) {
  const [pane, setPane] = useState<"on" | "pool">(tag.domains.length || tag.pool ? "on" : "pool");
  const [now] = useState(() => Date.now());
  const [pending, start] = useTransition();
  const [onSel, setOnSel] = useState<Set<string>>(new Set());
  const [poolSel, setPoolSel] = useState<Set<string>>(new Set());
  const [moveTo, setMoveTo] = useState("");
  const [onlyReady, setOnlyReady] = useState(true);
  const [offOnly, setOffOnly] = useState(false);
  const [camps, setCamps] = useState<Set<number>>(() => new Set(mainCampaigns(tag)));
  const onW = useColumnWidths("tag-domains", ON_WIDTHS);
  const poolW = useColumnWidths("tag-pool", POOL_WIDTHS);

  const need = tag.target ? Math.max(0, tag.target - tag.volume) : 0;
  const onList = useMemo(() => [...tag.domains].filter((d) => !offOnly || senderOff(d, tag.sender))
    .sort((a, b) => b.volume - a.volume || a.name.localeCompare(b.name)), [tag, offOnly]);
  const poolList = useMemo(() => [...pool].filter((d) => !onlyReady || freeState(d).ready).sort((a, b) =>
    Number(sameSender(b, tag.sender)) - Number(sameSender(a, tag.sender)) || (b.rep ?? 0) - (a.rep ?? 0)
    || volumeOn(b, tag.perInbox) - volumeOn(a, tag.perInbox) || a.name.localeCompare(b.name)), [pool, onlyReady, tag.sender, tag.perInbox]);
  const adding = poolList.filter((d) => poolSel.has(d.id));
  const addVolume = adding.reduce((a, d) => a + volumeOn(d, tag.perInbox), 0);

  const run = (fn: () => Promise<Result>, done?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error(r.error);
      toast.success(r.data.message);
      done?.();
    });
  const toggle = (set: Set<string>, id: string) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); return n; };
  const others = tags.filter((t) => t.key !== tag.key);
  const allOn = onList.length > 0 && onList.every((d) => onSel.has(d.id));

  return (
    <aside className="card tg-detail" aria-label={`Tag ${tag.name}`}>
      <div className="tg-dhead">
        <div className="tg-dtitle">
          <span className="tg-dname">{tag.name}</span>
          {tag.pool ? <span className="badge">Pool</span> : null}
          <span className="tg-pill" title={tag.pool ? undefined : "The sender name most of its inboxes use"}>
            <UserRound size={12} />{tag.pool ? "Domains waiting for a client tag" : tag.sender ?? "No sender name yet"}
          </span>
        </div>
        <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={onClose} aria-label="Close"><X size={14} /></button>
      </div>

      <dl className={`tg-dkpis${tag.pool ? " is-pool" : ""}`}>
        <div className="tg-dkpi is-wide">
          <dt>Volume / day</dt>
          <dd><b>{int(tag.volume)}</b>{tag.target ? <span className="tg-of"> of {int(tag.target)}</span> : null}</dd>
          {tag.target ? (
            <div className="tg-dprog">
              <VolumeBar volume={tag.volume} target={tag.target} />
              {need ? <span className="tg-gap">{int(need)} short</span> : <span className="tg-met">Target met</span>}
            </div>
          ) : <span className="tg-dsub">{tag.pool ? "Across the pool" : "No target yet"}</span>}
        </div>
        {tag.pool ? null : (
          <div className="tg-dkpi">
            <dt>Target</dt>
            <dd><TargetInput key={`${tag.key}:${tag.target ?? ""}`} tag={tag} tile /></dd>
            <span className="tg-dsub">{tag.perInbox ? `${int(tag.perInbox)} a day per inbox` : "emails a day"}</span>
          </div>
        )}
        <div className="tg-dkpi">
          <dt>Domains</dt>
          <dd><b>{int(tag.domains.length)}</b></dd>
          <span className={`tg-dsub${tag.offSender ? " tg-gap" : ""}`}>
            {tag.pool ? `${int(pool.filter((d) => freeState(d).ready).length)} warmed up` : tag.offSender ? `${int(tag.offSender)} off-sender` : "Senders match"}
          </span>
        </div>
        <div className="tg-dkpi">
          <dt>Inboxes</dt>
          <dd><b>{int(tag.connected)}</b></dd>
          <span className={`tg-dsub${tag.disconnected ? " tg-disc" : ""}`}>{tag.disconnected ? `${int(tag.disconnected)} disconnected` : "All connected"}</span>
        </div>
        <div className="tg-dkpi">
          <dt>Reputation</dt>
          <dd><b><Rep value={tag.rep} /></b></dd>
          <span className="tg-dsub">{int(tag.sentToday)} sent today</span>
        </div>
      </dl>

      <div className="tg-bar-row">
        <div className="seg" role="group" aria-label="Domains on this tag or in the pool">
          <button type="button" aria-pressed={pane === "on"} onClick={() => setPane("on")}>On this tag {int(tag.domains.length)}</button>
          {tag.pool ? null : <button type="button" aria-pressed={pane === "pool"} onClick={() => setPane("pool")}>Add from pool {int(pool.filter((d) => freeState(d).ready).length)}</button>}
        </div>
        {pane === "on" && tag.offSender ? (
          <button type="button" className={`tg-chip${offOnly ? " is-on" : ""}`} aria-pressed={offOnly} onClick={() => setOffOnly((x) => !x)}
            title={`Domains with an inbox under a sender name other than ${tag.sender}`}>
            <TriangleAlert size={12} /> Sender off {tag.offSender}
          </button>
        ) : null}
        {pane === "pool" ? <label className="tg-check"><input type="checkbox" className="checkbox" checked={onlyReady} onChange={() => setOnlyReady((x) => !x)} /> Warmed up only</label> : null}
        <span className="spacer-auto" />
        {pane === "on" ? (
          <>
            <span className="tg-move">
              <input className="input" list={`tg-tags-${tag.key}`} value={moveTo} onChange={(e) => setMoveTo(e.target.value)} placeholder="Move to tag…" aria-label="Tag to move to" />
              <datalist id={`tg-tags-${tag.key}`}>{others.map((t) => <option key={t.key} value={t.name} />)}</datalist>
              <button type="button" className="btn btn-sm" disabled={pending || blocked || !onSel.size || !moveTo.trim()}
                title="Puts them on that tag instead, with its sending limits"
                onClick={() => run(() => addDomainsToTag({ domainIds: [...onSel], tag: moveTo.trim(), campaignIds: [] }), () => { setOnSel(new Set()); setMoveTo(""); })}>
                <ArrowRightLeft size={13} /> Move{onSel.size ? ` ${onSel.size}` : ""}
              </button>
            </span>
            <button type="button" className="btn btn-sm" disabled={pending || blocked || !onSel.size}
              title={`Takes ${tag.name} off their inboxes. Their campaigns stay as they are.`}
              onClick={() => run(() => removeDomainsFromTag({ domainIds: [...onSel], tag: tag.name }), () => setOnSel(new Set()))}>
              <X size={13} /> Untag
            </button>
          </>
        ) : (
          <>
            <span className="tg-sel">
              {adding.length
                ? <>+<b>{int(addVolume)}</b> → <b>{int(tag.volume + addVolume)}</b>{tag.target ? ` of ${int(tag.target)}` : ""}</>
                : need ? `${int(need)} a day short` : null}
            </span>
            <button type="button" className="btn btn-sm" disabled={!need}
              title="Ticks warmed-up pool domains until the target is reached: the tag's sender first, then the best reputation"
              onClick={() => setPoolSel(new Set(fillPick(pool, tag.sender, need, tag.perInbox)))}>
              <Wand2 size={13} /> Fill
            </button>
            {poolSel.size ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPoolSel(new Set())}>Clear</button> : null}
            <button type="button" className="btn btn-sm btn-primary" disabled={pending || blocked || !adding.length}
              title={`Puts them on ${tag.name}: its sending limits are copied, Free/warmup and New come off and they go Active${camps.size ? `, then their inboxes join ${camps.size} campaign${camps.size === 1 ? "" : "s"}` : ""}`}
              onClick={() => run(() => addDomainsToTag({ domainIds: adding.map((d) => d.id), tag: tag.name, campaignIds: [...camps] }), () => setPoolSel(new Set()))}>
              <Plus size={13} /> Add {adding.length || ""}
            </button>
          </>
        )}
      </div>

      {pane === "pool" && tag.campaigns.length ? (
        <div className="tg-camps">
          <span className="tg-camps-label">Joins:</span>
          {tag.campaigns.slice(0, 12).map((c) => (
            <label key={c.id} className="tg-camp" title={`${campaignName.get(c.id) ?? c.id}: ${c.domains} of this tag's ${tag.domains.length} domains are in it`}>
              <input type="checkbox" className="checkbox" checked={camps.has(c.id)} onChange={() => setCamps((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })} />
              <span className="tg-clip">{campaignName.get(c.id) ?? `Campaign ${c.id}`}</span>
            </label>
          ))}
        </div>
      ) : null}

      <div className="table-scroll tg-sub-table">
        {pane === "on" ? (
          <table className="data-table is-fixed" style={fillStyle(onW, ON_COLS.map((c) => c.key), "domain", 170, CHECK_W)}>
            <colgroup><col style={{ width: CHECK_W }} />{ON_COLS.map((c) => <col key={c.key} style={{ width: colWidth(onW, c.key, "domain") }} />)}</colgroup>
            <thead>
              <tr>
                <th className="col-check">
                  <input type="checkbox" className="checkbox" aria-label="Select every domain shown" checked={allOn}
                    onChange={() => setOnSel(allOn ? new Set() : new Set(onList.map((d) => d.id)))} />
                </th>
                {ON_COLS.map((c: SubCol) => <Th key={c.key} col={c.key} label={c.label} w={onW} num={c.num} title={c.title} />)}
              </tr>
            </thead>
            <tbody>
              {onList.map((d) => {
                const also = clientTagsOf(d).filter(([k]) => k !== tag.key).map(([, n]) => n);
                return (
                  <tr key={d.id} className="is-clickable" data-selected={onSel.has(d.id)} onClick={() => setOnSel((s) => toggle(s, d.id))}>
                    <td className="col-check"><input type="checkbox" className="checkbox" checked={onSel.has(d.id)} onChange={() => {}} tabIndex={-1} aria-label={`Select ${d.name}`} /></td>
                    <td className="col-first" title={also.length ? `Also tagged ${also.join(", ")}` : undefined}><span className="strong">{d.name}</span>{also.length ? <span className="tg-also"> +{also.length}</span> : null}</td>
                    <td><DomainState d={d} now={now} /></td>
                    <td className="is-num">{int(d.connected)}{d.disconnected ? <span className="tg-disc"> +{d.disconnected}</span> : null}</td>
                    <td className="is-num">{int(d.volume)}</td>
                    <td className="is-num"><Rep value={d.rep} /></td>
                    <td><Sender d={d} tagSender={tag.pool ? null : tag.sender} /></td>
                    <td className="is-num" title={d.campaigns.map((c) => campaignName.get(c) ?? `#${c}`).join("\n")}>{d.campaigns.length || <span className="zero">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <table className="data-table is-fixed" style={fillStyle(poolW, POOL_COLS.map((c) => c.key), "domain", 170, CHECK_W)}>
            <colgroup><col style={{ width: CHECK_W }} />{POOL_COLS.map((c) => <col key={c.key} style={{ width: colWidth(poolW, c.key, "domain") }} />)}</colgroup>
            <thead>
              <tr>
                <th className="col-check" />
                {POOL_COLS.map((c: SubCol) => <Th key={c.key} col={c.key} label={c.label} w={poolW} num={c.num} title={c.title} />)}
              </tr>
            </thead>
            <tbody>
              {poolList.map((d) => {
                const w = warmupOf(d);
                const from = clientTagsOf(d).filter(([k]) => isPoolTag(k)).map(([, n]) => n).join(", ");
                return (
                  <tr key={d.id} className="is-clickable" data-selected={poolSel.has(d.id)} onClick={() => setPoolSel((s) => toggle(s, d.id))}>
                    <td className="col-check"><input type="checkbox" className="checkbox" checked={poolSel.has(d.id)} onChange={() => {}} tabIndex={-1} aria-label={`Select ${d.name}`} /></td>
                    <td className="col-first"><span className="strong">{d.name}</span></td>
                    <td className="tg-muted">{from}</td>
                    <td>{w ? (w.ready ? <span className="tg-met">Done</span> : <span className="tg-muted">Day {w.day} of {w.days}</span>) : <span className="tg-met">Ready</span>}</td>
                    <td className="is-num">{int(d.connected)}{d.disconnected ? <span className="tg-disc"> +{d.disconnected}</span> : null}</td>
                    <td className="is-num">{int(volumeOn(d, tag.perInbox))}</td>
                    <td className="is-num"><Rep value={d.rep} /></td>
                    <td><span className={sameSender(d, tag.sender) ? "tg-met" : undefined}><Sender d={d} tagSender={null} /></span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {pane === "on" && onList.length === 0 ? <Empty icon={TagsIcon} title="No domains on this tag">Add domains from the pool to start it.</Empty> : null}
        {pane === "pool" && poolList.length === 0 ? (
          <Empty icon={TagsIcon} title="Nothing in the pool">
            {onlyReady && pool.length ? "Every pool domain is still warming up. Untick Warmed up only to see them." : "Tag domains Free or warmup in Smartlead to put them in the pool."}
          </Empty>
        ) : null}
      </div>
    </aside>
  );
}

/** Every tag below its target, topped up from the pool: shown first, then done in one go. */
function FillDialog({ open, onOpenChange, plan, campaignName, blocked }: {
  open: boolean; onOpenChange: (o: boolean) => void; plan: FillStep[]; campaignName: Map<number, string>; blocked: string | null;
}) {
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const chosen = plan.filter((s) => !skip.has(s.tag.key));

  const apply = () => start(async () => {
    let done = 0, failed = 0;
    for (const s of chosen) {
      const r = await addDomainsToTag({ domainIds: s.domains.map((d) => d.id), tag: s.tag.name, campaignIds: s.campaignIds });
      if (r.ok) done++;
      else { failed++; toast.error(`${s.tag.name}: ${r.error}`); }
    }
    if (done) toast.success(`Filled ${done} tag${done === 1 ? "" : "s"} from the pool${failed ? `; ${failed} failed` : ""}`);
    setSkip(new Set());
    onOpenChange(false);
  });

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!pending) onOpenChange(o); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog tg-fill">
          <div className="dialog-head">
            <Dialog.Title className="dialog-title">Fill tags to their targets</Dialog.Title>
            <Dialog.Description className="dialog-desc">
              Warmed-up domains from the Free and warmup pool, the tag&apos;s sender first. Each gets the tag&apos;s sending limits, loses Free/warmup and New, goes Active and joins the tag&apos;s main campaigns.
            </Dialog.Description>
          </div>
          <div className="dialog-body">
            {plan.map((s) => {
              const on = !skip.has(s.tag.key);
              const short = s.tag.target! - s.after;
              return (
                <div key={s.tag.key} className={`tg-fill-row${on ? "" : " is-off"}`}>
                  <label className="tg-fill-head">
                    <input type="checkbox" className="checkbox" checked={on} onChange={() => setSkip((x) => { const n = new Set(x); if (n.has(s.tag.key)) n.delete(s.tag.key); else n.add(s.tag.key); return n; })} />
                    <span className="strong">{s.tag.name}</span>
                    <span className="tg-muted">{s.tag.sender ?? "no sender"}</span>
                    <span className="spacer-auto" />
                    <span className="tg-fill-nums">{int(s.tag.volume)} → <b>{int(s.after)}</b> / {int(s.tag.target!)}</span>
                    {short > 0 ? <span className="badge tone-warning" title="The pool runs out before the target">{int(short)} short</span> : null}
                  </label>
                  <div className="tg-fill-doms">
                    {s.domains.map((d) => (
                      <span key={d.id} className={`tg-fill-dom${sameSender(d, s.tag.sender) ? "" : " is-other"}`}
                        title={`${d.connected} inboxes · +${int(volumeOn(d, s.tag.perInbox))} a day · sender ${d.senders[0]?.name ?? "none"}`}>
                        {d.name} <em>+{int(volumeOn(d, s.tag.perInbox))}</em>
                      </span>
                    ))}
                  </div>
                  <div className="tg-muted tg-fill-camps">
                    {s.campaignIds.length ? `Joins ${s.campaignIds.map((c) => campaignName.get(c) ?? `#${c}`).join(", ")}` : "No campaign: tag only"}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="dialog-foot">
            <span className="tg-muted">{int(chosen.reduce((a, s) => a + s.domains.length, 0))} domains to {int(chosen.length)} tag{chosen.length === 1 ? "" : "s"} · +{int(chosen.reduce((a, s) => a + s.adds, 0))} a day</span>
            <span className="spacer" />
            <Dialog.Close asChild><button type="button" className="btn" disabled={pending}>Cancel</button></Dialog.Close>
            <button type="button" className="btn btn-primary" disabled={pending || !chosen.length || Boolean(blocked)} title={blocked ?? undefined} onClick={apply}>
              {pending ? "Adding…" : `Add to ${chosen.length} tag${chosen.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
