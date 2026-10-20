"use client";

import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Inbox, Info, Search, Settings2, Shuffle, X } from "lucide-react";
import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import { ColumnsMenu, useColumns, type ColumnDef } from "@/components/Columns";
import { SortTh } from "@/components/SortTh";
import { ClientCell, Empty, Metric, StatusDot } from "@/components/ui";
import { InboxSettingsDialog } from "./InboxSettingsDialog";
import { PlansCard } from "./PlansCard";
import { ago, int } from "@/lib/format";
import type { ClientRow, InboxListRow, PlanRow } from "@/lib/queries";
import type { DomainStatus } from "@/lib/status";

const TABS = [
  { key: "connected", label: "Connected", match: (i: InboxListRow) => i.status === "connected" },
  { key: "lowrep", label: "Reputation under 90", match: (i: InboxListRow) => i.status === "connected" && i.warmupReputation != null && i.warmupReputation < 90 },
  { key: "pending", label: "Pending", match: (i: InboxListRow) => i.status === "pending" },
  { key: "disconnected", label: "Disconnected", match: (i: InboxListRow) => i.status === "disconnected" },
  { key: "all", label: "All", match: () => true },
] as const;
type TabKey = (typeof TABS)[number]["key"];

type Group = {
  domainId: string; domain: string; status: DomainStatus; clientName: string | null; clientHue: number | null;
  inboxes: InboxListRow[];
  count: number; warmupOff: number; avgWarmup: number | null; avgLimit: number | null; capacity: number;
  avgRep: number | null; minRep: number | null; lowRep: number; campaigns: number;
  sent7: number; replies7: number; human7: number; bounces7: number;
  sentToday: number; avgWait: number | null; pending: number; tags: string[]; esp: string | null;
};

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const rate = (n: number, d: number) => (d > 0 ? (100 * n) / d : null);

function group(rows: InboxListRow[]): Group[] {
  const map = new Map<string, InboxListRow[]>();
  for (const r of rows) map.set(r.domainId, [...(map.get(r.domainId) ?? []), r]);
  return [...map.values()].map((list) => {
    const f = list[0];
    const reps = list.map((i) => i.warmupReputation).filter((x): x is number => x != null);
    return {
      domainId: f.domainId, domain: f.domain, status: f.domainStatus, clientName: f.clientName, clientHue: f.clientHue,
      inboxes: list,
      count: list.length,
      warmupOff: list.filter((i) => !i.warmupEnabled).length,
      avgWarmup: avg(list.filter((i) => i.warmupEnabled && i.warmupPerDay != null).map((i) => i.warmupPerDay!)),
      avgLimit: avg(list.filter((i) => i.dailyLimit != null).map((i) => i.dailyLimit!)),
      capacity: list.reduce((a, i) => a + (i.dailyLimit ?? 0), 0),
      avgRep: avg(reps),
      minRep: reps.length ? Math.min(...reps) : null,
      lowRep: reps.filter((r) => r < 90).length,
      campaigns: Math.max(0, ...list.map((i) => i.campaigns)),
      sent7: list.reduce((a, i) => a + i.sent7, 0),
      replies7: list.reduce((a, i) => a + i.replies7, 0),
      human7: list.reduce((a, i) => a + i.human7, 0),
      bounces7: list.reduce((a, i) => a + i.bounces7, 0),
      sentToday: list.reduce((a, i) => a + (i.dailySent ?? 0), 0),
      avgWait: avg(list.filter((i) => i.minWaitMins != null).map((i) => i.minWaitMins!)),
      pending: list.filter((i) => i.change?.status === "pending" || i.change?.status === "running").length,
      tags: [...new Set(list.flatMap((i) => i.smartleadTags))],
      esp: (() => { const t = [...new Set(list.map((i) => i.providerType).filter(Boolean))]; return t.length === 1 ? t[0] : t.length ? "MIXED" : null; })(),
    };
  });
}

type SortKey = "domain" | "client" | "esp" | "tags" | "count" | "avgWarmup" | "avgLimit" | "capacity" | "sentToday" | "avgWait" | "avgRep" | "campaigns" | "sent7" | "replyRate" | "bounceRate";
const sortValue = (g: Group, k: SortKey): string | number | null => {
  switch (k) {
    case "client": return g.clientName?.toLowerCase() ?? null;
    case "esp": return g.esp;
    case "tags": return g.tags.join(", ").toLowerCase() || null;
    case "replyRate": return rate(g.replies7, g.sent7);
    case "bounceRate": return rate(g.bounces7, g.sent7);
    default: return g[k];
  }
};

const n0 = (v: number | null, digits = 0) => (v == null ? <span className="zero">—</span> : v.toFixed(digits));

const COLUMNS: ColumnDef[] = [
  { key: "client", label: "Client / sender" }, { key: "esp", label: "ESP" }, { key: "tags", label: "Smartlead tags" },
  { key: "count", label: "Inboxes" }, { key: "warmup", label: "Warmup / day" }, { key: "limit", label: "Limit / inbox" },
  { key: "capacity", label: "Per day" }, { key: "today", label: "Sent today" }, { key: "gap", label: "Gap", hidden: true },
  { key: "rep", label: "Reputation" }, { key: "campaigns", label: "Campaigns", hidden: true }, { key: "sent7", label: "Sent 7d" },
  { key: "reply", label: "Reply rate" }, { key: "bounce", label: "Bounce rate" },
];

const espLabel = (t: string) => (t === "OUTLOOK" ? "Outlook" : t === "GMAIL" || t === "GOOGLE" ? "Google" : t === "MIXED" ? "Mixed" : t === "SMTP" ? "SMTP" : t.charAt(0) + t.slice(1).toLowerCase());
function EspBadge({ type }: { type: string }) {
  const tone = type === "OUTLOOK" ? "tone-info" : type === "GMAIL" || type === "GOOGLE" ? "tone-success" : "";
  return <span className={`badge ${tone}`}>{espLabel(type)}</span>;
}
function Tags({ tags }: { tags: string[] }) {
  if (!tags.length) return <span className="zero">—</span>;
  return <span className="flex items-center gap-1">{tags.slice(0, 2).map((t) => <span key={t} className="badge">{t}</span>)}{tags.length > 2 ? <span className="badge" title={tags.join(", ")}>+{tags.length - 2}</span> : null}</span>;
}

function ChangeBadge({ change }: { change: InboxListRow["change"] }) {
  if (!change) return null;
  const what = Object.entries(change.changes).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ");
  if (change.status === "pending" || change.status === "running") return <span className="badge tone-info" title={what}>Pending</span>;
  if (change.status === "failed") return <span className="badge tone-danger" title={change.error ?? what}>Update failed</span>;
  if (change.status === "dry_run") return <span className="badge" title={`Dry run: would set ${what}`}>Dry run</span>;
  return null;
}

export function InboxesView({ inboxes, clients, plans, smartleadConnected, dryRun, timezone }: {
  inboxes: InboxListRow[]; clients: ClientRow[]; plans: PlanRow[]; smartleadConnected: boolean; dryRun: boolean; timezone: string;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editOpen, setEditOpen] = useState(false);
  const [tab, setTab] = useState<TabKey>("connected");
  const [q, setQ] = useState("");
  const [clientId, setClientId] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "domain", dir: 1 });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [esp, setEsp] = useState("");
  const cols = useColumns("inboxes", COLUMNS);
  const on = cols.on;
  const esps = useMemo(() => [...new Set(inboxes.map((i) => i.providerType).filter((x): x is string => Boolean(x)))].sort(), [inboxes]);

  const base = useMemo(() => {
    const client = clients.find((c) => c.id === clientId)?.name;
    return inboxes.filter((i) => (!client || i.clientName === client) && (!esp || i.providerType === esp));
  }, [inboxes, clients, clientId, esp]);
  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.key, base.filter(t.match).length])), [base]);

  const groups = useMemo(() => {
    const match = TABS.find((t) => t.key === tab)!.match;
    const needle = q.trim().toLowerCase();
    const shown = base.filter((i) => match(i) && (!needle || i.email.includes(needle) || i.domain.includes(needle) || i.senderName?.toLowerCase().includes(needle) || i.smartleadTags.some((t) => t.toLowerCase().includes(needle))));
    return group(shown).sort((a, b) => {
      const x = sortValue(a, sort.key), y = sortValue(b, sort.key);
      if (x === y) return a.domain.localeCompare(b.domain);
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * sort.dir;
    });
  }, [base, tab, q, sort]);

  const all = useMemo(() => groups.flatMap((g) => g.inboxes), [groups]);
  const totals = useMemo(() => {
    const reps = all.map((i) => i.warmupReputation).filter((x): x is number => x != null);
    return {
      inboxes: all.length,
      capacity: all.reduce((a, i) => a + (i.dailyLimit ?? 0), 0),
      warmup: all.reduce((a, i) => a + (i.warmupEnabled ? i.warmupPerDay ?? 0 : 0), 0),
      avgRep: avg(reps),
      sent: all.reduce((a, i) => a + i.sent7, 0),
      replies: all.reduce((a, i) => a + i.replies7, 0),
      bounces: all.reduce((a, i) => a + i.bounces7, 0),
    };
  }, [all]);

  const selectedRows = useMemo(() => inboxes.filter((i) => selected.has(i.id)), [inboxes, selected]);
  const selectedDomains = useMemo(() => [...new Set(selectedRows.map((i) => i.domainId))], [selectedRows]);
  const current = useMemo(() => {
    const m = (f: (i: InboxListRow) => number | null) => avg(selectedRows.map(f).filter((x): x is number => x != null));
    return { dailyLimit: m((i) => i.dailyLimit), minWait: m((i) => i.minWaitMins), warmupPerDay: m((i) => i.warmupPerDay), warmupRampup: m((i) => i.warmupRampup), warmupReplyRate: m((i) => i.warmupReplyRate) };
  }, [selectedRows]);
  const toggleIds = (ids: string[]) => setSelected((s) => {
    const n = new Set(s);
    const on = ids.every((id) => n.has(id));
    for (const id of ids) if (on) n.delete(id); else n.add(id);
    return n;
  });
  const allIds = all.map((i) => i.id);
  const allSel = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someSel = allIds.some((id) => selected.has(id));

  const allOpen = groups.length > 0 && groups.every((g) => open.has(g.domainId));
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "domain" || key === "client" ? 1 : -1 }));

  return (
    <div className="flex flex-col gap-3">
      {!smartleadConnected ? (
        <div className="callout tone-info">
          <Info size={15} strokeWidth={1.75} />
          <span>
            Showing the last synced settings. Add your Smartlead API key in <Link href="/settings" className="underline">Settings</Link> to
            change warmup and daily limits from here.
          </span>
        </div>
      ) : null}

      <section className="stats" aria-label="Inbox numbers">
        <div className="stat"><span className="stat-label">Inboxes</span><span className="stat-value">{int(totals.inboxes)}</span><span className="stat-foot">on {int(groups.length)} domains · {groups.length ? (totals.inboxes / groups.length).toFixed(1) : "0"} per domain</span></div>
        <div className="stat"><span className="stat-label">Campaign emails / day</span><span className="stat-value">{int(totals.capacity)}</span><span className="stat-foot">{totals.inboxes ? (totals.capacity / totals.inboxes).toFixed(1) : "0"} per inbox on average</span></div>
        <div className="stat"><span className="stat-label">Warmup emails / day</span><span className="stat-value">{int(totals.warmup)}</span><span className="stat-foot">{int(all.filter((i) => !i.warmupEnabled).length)} inboxes with warmup off</span></div>
        <div className="stat"><span className="stat-label">Average reputation</span><span className="stat-value">{totals.avgRep == null ? "—" : totals.avgRep.toFixed(1)}</span><span className="stat-foot">{int(counts.lowrep ?? 0)} connected inboxes under 90</span></div>
      </section>

      <div className="table-bar">
        <div className="view-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? "is-on" : undefined} onClick={() => setTab(t.key)}>
              {t.label} <span>{int(counts[t.key] ?? 0)}</span>
            </button>
          ))}
        </div>
        <label className="search-input">
          <Search size={14} strokeWidth={1.5} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search domains, inboxes, senders" aria-label="Search inboxes" />
        </label>
        <select className="select" style={{ width: 160 }} value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Filter by client">
          <option value="">All clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="select" style={{ width: 130 }} value={esp} onChange={(e) => setEsp(e.target.value)} aria-label="Filter by ESP">
          <option value="">All ESPs</option>
          {esps.map((x) => <option key={x} value={x}>{espLabel(x)}</option>)}
        </select>
        <span className="spacer-auto" />
        <button type="button" className="btn btn-sm" onClick={() => setOpen(allOpen ? new Set() : new Set(groups.map((g) => g.domainId)))}>
          {allOpen ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />} {allOpen ? "Collapse" : "Expand"}
        </button>
        <ColumnsMenu cols={cols} />
      </div>

      <div className="table-wrap">
        <div className="table-scroll" style={{ maxHeight: "calc(100dvh - 270px)", minHeight: 260 }}>
          <table className="data-table is-main">
            <thead>
              <tr>
                <th className="col-check">
                  <input type="checkbox" className="checkbox" aria-label="Select all shown inboxes" checked={allSel}
                    ref={(el) => { if (el) el.indeterminate = !allSel && someSel; }}
                    onChange={() => setSelected((s0) => { const n = new Set(s0); for (const id of allIds) if (allSel) n.delete(id); else n.add(id); return n; })} />
                </th>
                <SortTh k="domain" sort={sort} onSort={sortBy}>Domain</SortTh>
                {on("client") ? <SortTh k="client" sort={sort} onSort={sortBy}>Client / sender</SortTh> : null}
                {on("esp") ? <SortTh k="esp" sort={sort} onSort={sortBy}>ESP</SortTh> : null}
                {on("tags") ? <SortTh k="tags" sort={sort} onSort={sortBy}>Smartlead tags</SortTh> : null}
                {on("count") ? <SortTh k="count" sort={sort} onSort={sortBy} num>Inboxes</SortTh> : null}
                {on("warmup") ? <SortTh k="avgWarmup" sort={sort} onSort={sortBy} num>Warmup / day</SortTh> : null}
                {on("limit") ? <SortTh k="avgLimit" sort={sort} onSort={sortBy} num>Limit / inbox</SortTh> : null}
                {on("capacity") ? <SortTh k="capacity" sort={sort} onSort={sortBy} num>Per day</SortTh> : null}
                {on("today") ? <SortTh k="sentToday" sort={sort} onSort={sortBy} num title="Campaign emails sent today, as Smartlead counts them">Today</SortTh> : null}
                {on("gap") ? <SortTh k="avgWait" sort={sort} onSort={sortBy} num title="Minimum minutes between campaign emails">Gap</SortTh> : null}
                {on("rep") ? <SortTh k="avgRep" sort={sort} onSort={sortBy} num>Reputation</SortTh> : null}
                {on("campaigns") ? <SortTh k="campaigns" sort={sort} onSort={sortBy} num>Campaigns</SortTh> : null}
                {on("sent7") ? <SortTh k="sent7" sort={sort} onSort={sortBy} num>Sent 7d</SortTh> : null}
                {on("reply") ? <SortTh k="replyRate" sort={sort} onSort={sortBy} num>Reply</SortTh> : null}
                {on("bounce") ? <SortTh k="bounceRate" sort={sort} onSort={sortBy} num>Bounce</SortTh> : null}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const isOpen = open.has(g.domainId);
                const ids = g.inboxes.map((i) => i.id);
                const gSel = ids.every((id) => selected.has(id));
                const gSome = ids.some((id) => selected.has(id));
                return (
                  <Fragment key={g.domainId}>
                    <tr className="is-clickable" aria-expanded={isOpen} data-selected={gSel} onClick={() => toggle(g.domainId)}>
                      <td className="col-check" onClick={(e) => { e.stopPropagation(); toggleIds(ids); }}>
                        <input type="checkbox" className="checkbox" checked={gSel} ref={(el) => { if (el) el.indeterminate = !gSel && gSome; }} onChange={() => {}} aria-label={`Select inboxes on ${g.domain}`} tabIndex={-1} />
                      </td>
                      <td className="col-first">
                        <span className="flex items-center gap-1.5">
                          <ChevronRight size={14} className="flex-none text-faint transition-transform" style={{ transform: isOpen ? "rotate(90deg)" : undefined }} />
                          <Link href={`/domains?d=${g.domainId}&view=all`} className="strong hover:underline" onClick={(e) => e.stopPropagation()}>{g.domain}</Link>
                          <span className="hidden xl:inline-flex"><StatusDot status={g.status} /></span>
                          {g.pending ? <span className="badge tone-info">{g.pending} pending</span> : null}
                        </span>
                      </td>
                      {on("client") ? <td><ClientCell name={g.clientName} hue={g.clientHue} /></td> : null}
                      {on("esp") ? <td>{g.esp ? <EspBadge type={g.esp} /> : <span className="zero">—</span>}</td> : null}
                      {on("tags") ? <td><Tags tags={g.tags} /></td> : null}
                      {on("count") ? <td className="is-num">{int(g.count)}</td> : null}
                      {on("warmup") ? (
                        <td className="is-num" title={g.warmupOff ? `${g.warmupOff} with warmup off` : undefined}>
                          {n0(g.avgWarmup)}{g.warmupOff ? <span className="text-faint"> · {g.warmupOff} off</span> : null}
                        </td>
                      ) : null}
                      {on("limit") ? <td className="is-num">{n0(g.avgLimit)}</td> : null}
                      {on("capacity") ? <td className="is-num">{g.capacity ? int(g.capacity) : <span className="zero">0</span>}</td> : null}
                      {on("today") ? <td className="is-num">{g.sentToday ? int(g.sentToday) : <span className="zero">0</span>}</td> : null}
                      {on("gap") ? <td className="is-num">{g.avgWait != null ? `${Math.round(g.avgWait)}m` : <span className="zero">—</span>}</td> : null}
                      {on("rep") ? (
                        <td className="is-num" title={g.minRep != null ? `Lowest ${g.minRep.toFixed(0)}${g.lowRep ? `, ${g.lowRep} under 90` : ""}` : undefined}>
                          <Metric value={g.avgRep} warn={95} bad={90} invert digits={1} suffix="" />
                          {g.lowRep ? <span className="text-danger-ink"> · {g.lowRep} low</span> : null}
                        </td>
                      ) : null}
                      {on("campaigns") ? <td className="is-num">{g.campaigns ? int(g.campaigns) : <span className="zero">0</span>}</td> : null}
                      {on("sent7") ? <td className="is-num">{g.sent7 ? int(g.sent7) : <span className="zero">0</span>}</td> : null}
                      {on("reply") ? <td className="is-num"><Metric value={rate(g.replies7, g.sent7)} digits={2} /></td> : null}
                      {on("bounce") ? <td className="is-num"><Metric value={rate(g.bounces7, g.sent7)} warn={2} bad={3} /></td> : null}
                    </tr>
                    {isOpen ? g.inboxes.map((i) => (
                      <tr key={i.id} className="is-clickable" data-selected={selected.has(i.id)} style={{ background: "var(--surface-2)" }} onClick={() => toggleIds([i.id])}>
                        <td className="col-check"><input type="checkbox" className="checkbox" checked={selected.has(i.id)} onChange={() => {}} aria-label={`Select ${i.email}`} tabIndex={-1} /></td>
                        <td className="col-first" style={{ paddingLeft: 34 }}>
                          <span className="flex items-center gap-2" title={i.lastSyncedAt ? `Synced ${ago(i.lastSyncedAt)}` : undefined}>
                            <span className="text-ink-soft">{i.email}</span>
                            {i.status !== "connected" ? <span className="badge">{i.status}</span> : null}
                            <ChangeBadge change={i.change} />
                          </span>
                        </td>
                        {on("client") ? <td className="text-muted">{i.senderName ?? <span className="zero">—</span>}</td> : null}
                        {on("esp") ? <td>{i.providerType ? <EspBadge type={i.providerType} /> : <span className="zero">—</span>}</td> : null}
                        {on("tags") ? <td><Tags tags={i.smartleadTags} /></td> : null}
                        {on("count") ? <td className="is-num"><span className="zero">—</span></td> : null}
                        {on("warmup") ? (
                          <td className="is-num" title={i.warmupMin != null ? `Smartlead sends ${i.warmupMin}–${i.warmupPerDay} a day${i.warmupReplyRate != null ? `, ${i.warmupReplyRate}% reply rate` : ""}` : undefined}>
                            {i.warmupEnabled ? (i.warmupMin != null && i.warmupMin !== i.warmupPerDay ? `${i.warmupMin}–${i.warmupPerDay}` : int(i.warmupPerDay)) : <span className="zero">off</span>}
                            {i.warmupRampup ? <span className="text-faint"> · +{i.warmupRampup}</span> : null}
                          </td>
                        ) : null}
                        {on("limit") ? <td className="is-num">{i.dailyLimit ? int(i.dailyLimit) : <span className="zero">0</span>}</td> : null}
                        {on("capacity") ? <td className="is-num">{i.dailyLimit ? int(i.dailyLimit) : <span className="zero">0</span>}</td> : null}
                        {on("today") ? <td className="is-num">{i.dailySent ? int(i.dailySent) : <span className="zero">0</span>}</td> : null}
                        {on("gap") ? <td className="is-num">{i.minWaitMins != null ? `${i.minWaitMins}m` : <span className="zero">—</span>}</td> : null}
                        {on("rep") ? <td className="is-num"><Metric value={i.warmupReputation} warn={95} bad={90} invert digits={0} suffix="" /></td> : null}
                        {on("campaigns") ? <td className="is-num">{i.campaigns ? int(i.campaigns) : <span className="zero">0</span>}</td> : null}
                        {on("sent7") ? <td className="is-num">{i.sent7 ? int(i.sent7) : <span className="zero">0</span>}</td> : null}
                        {on("reply") ? <td className="is-num"><Metric value={rate(i.replies7, i.sent7)} digits={2} /></td> : null}
                        {on("bounce") ? <td className="is-num"><Metric value={rate(i.bounces7, i.sent7)} warn={2} bad={3} /></td> : null}
                      </tr>
                    )) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {groups.length === 0 ? <Empty icon={Inbox} title="No inboxes here">Inboxes appear once a domain is set up on Hypertide and connected to Smartlead.</Empty> : null}
        </div>
        <div className="table-footer">
          <span><b>{int(groups.length)}</b> domains</span>
          <span><b>{int(totals.inboxes)}</b> inboxes</span>
          <span><b>{int(totals.capacity)}</b> campaign emails a day</span>
          <span><b>{int(totals.warmup)}</b> warmup a day</span>
          <span><b>{int(totals.sent)}</b> sent · <b>{totals.sent ? ((100 * totals.replies) / totals.sent).toFixed(2) : "0.00"}%</b> reply · <b>{totals.sent ? ((100 * totals.bounces) / totals.sent).toFixed(1) : "0.0"}%</b> bounce, 7 days</span>
          <span className="table-footer-hint hidden md:inline-flex">Tick domains or inboxes to edit them</span>
        </div>
      </div>

      <PlansCard plans={plans} clients={clients} selectedDomainIds={selectedDomains} timezone={timezone} />

      {selected.size > 0 ? (
        <div className="bulk-bar" role="toolbar" aria-label="Selected inboxes">
          <span className="bulk-count">{selected.size} inbox{selected.size === 1 ? "" : "es"} · {selectedDomains.length} domain{selectedDomains.length === 1 ? "" : "s"}</span>
          <button type="button" className="btn btn-primary btn-sm" disabled={!smartleadConnected} onClick={() => setEditOpen(true)}><Settings2 size={14} /> Edit settings</button>
          <button type="button" className="btn btn-sm" onClick={() => document.getElementById("plans-title")?.scrollIntoView({ behavior: "smooth" })}><Shuffle size={14} /> Daily plan</button>
          <span className="sep" />
          <button type="button" className="btn btn-sm" aria-label="Clear selection" onClick={() => setSelected(new Set())}><X size={14} /></button>
        </div>
      ) : null}
      <InboxSettingsDialog open={editOpen} onOpenChange={setEditOpen} inboxIds={[...selected]} domains={selectedDomains.length} current={current} dryRun={dryRun} onDone={() => setSelected(new Set())} />
    </div>
  );
}
