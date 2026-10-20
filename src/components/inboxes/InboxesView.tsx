"use client";

import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Inbox, Info, Search } from "lucide-react";
import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import { SortTh } from "@/components/SortTh";
import { ClientCell, Empty, Metric, StatusDot } from "@/components/ui";
import { ago, int } from "@/lib/format";
import type { ClientRow, InboxListRow } from "@/lib/queries";
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
    };
  });
}

type SortKey = "domain" | "client" | "count" | "avgWarmup" | "avgLimit" | "capacity" | "avgRep" | "campaigns" | "sent7" | "replyRate" | "bounceRate";
const sortValue = (g: Group, k: SortKey): string | number | null => {
  switch (k) {
    case "client": return g.clientName?.toLowerCase() ?? null;
    case "replyRate": return rate(g.replies7, g.sent7);
    case "bounceRate": return rate(g.bounces7, g.sent7);
    default: return g[k];
  }
};

const n0 = (v: number | null, digits = 0) => (v == null ? <span className="zero">—</span> : v.toFixed(digits));

export function InboxesView({ inboxes, clients, smartleadConnected }: { inboxes: InboxListRow[]; clients: ClientRow[]; smartleadConnected: boolean }) {
  const [tab, setTab] = useState<TabKey>("connected");
  const [q, setQ] = useState("");
  const [clientId, setClientId] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "domain", dir: 1 });
  const [open, setOpen] = useState<Set<string>>(new Set());

  const base = useMemo(() => {
    const client = clients.find((c) => c.id === clientId)?.name;
    return inboxes.filter((i) => !client || i.clientName === client);
  }, [inboxes, clients, clientId]);
  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.key, base.filter(t.match).length])), [base]);

  const groups = useMemo(() => {
    const match = TABS.find((t) => t.key === tab)!.match;
    const needle = q.trim().toLowerCase();
    const shown = base.filter((i) => match(i) && (!needle || i.email.includes(needle) || i.domain.includes(needle) || i.senderName?.toLowerCase().includes(needle)));
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

      <div className="view-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? "is-on" : undefined} onClick={() => setTab(t.key)}>
            {t.label} <span>{int(counts[t.key] ?? 0)}</span>
          </button>
        ))}
      </div>
      <div className="toolbar">
        <label className="search-input">
          <Search size={14} strokeWidth={1.5} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search domains, inboxes or senders" aria-label="Search inboxes" />
        </label>
        <select className="select" style={{ width: 180 }} value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Filter by client">
          <option value="">All clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button type="button" className="btn btn-sm" onClick={() => setOpen(allOpen ? new Set() : new Set(groups.map((g) => g.domainId)))}>
          {allOpen ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />} {allOpen ? "Collapse all" : "Expand all"}
        </button>
        <div className="view-tabs-summary"><b>{int(totals.sent)}</b> sent · <b>{totals.sent ? ((100 * totals.replies) / totals.sent).toFixed(2) : "0.00"}%</b> reply · <b>{totals.sent ? ((100 * totals.bounces) / totals.sent).toFixed(1) : "0.0"}%</b> bounce · 7 days</div>
      </div>

      <div className="table-wrap">
        <div className="table-scroll" style={{ maxHeight: "calc(100dvh - 380px)", minHeight: 260 }}>
          <table className="data-table is-main">
            <thead>
              <tr>
                <SortTh k="domain" sort={sort} onSort={sortBy}>Domain</SortTh>
                <SortTh k="client" sort={sort} onSort={sortBy}>Client</SortTh>
                <SortTh k="count" sort={sort} onSort={sortBy} num>Inboxes</SortTh>
                <SortTh k="avgWarmup" sort={sort} onSort={sortBy} num>Warmup / day</SortTh>
                <SortTh k="avgLimit" sort={sort} onSort={sortBy} num>Limit / inbox</SortTh>
                <SortTh k="capacity" sort={sort} onSort={sortBy} num>Per day</SortTh>
                <SortTh k="avgRep" sort={sort} onSort={sortBy} num>Reputation</SortTh>
                <SortTh k="campaigns" sort={sort} onSort={sortBy} num>Campaigns</SortTh>
                <SortTh k="sent7" sort={sort} onSort={sortBy} num>Sent 7d</SortTh>
                <SortTh k="replyRate" sort={sort} onSort={sortBy} num>Reply</SortTh>
                <SortTh k="bounceRate" sort={sort} onSort={sortBy} num>Bounce</SortTh>
                <th className="is-num">Synced</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const isOpen = open.has(g.domainId);
                return (
                  <Fragment key={g.domainId}>
                    <tr className="is-clickable" aria-expanded={isOpen} onClick={() => toggle(g.domainId)}>
                      <td className="col-first">
                        <span className="flex items-center gap-1.5">
                          <ChevronRight size={14} className="flex-none text-faint transition-transform" style={{ transform: isOpen ? "rotate(90deg)" : undefined }} />
                          <Link href={`/domains?d=${g.domainId}&view=all`} className="strong hover:underline" onClick={(e) => e.stopPropagation()}>{g.domain}</Link>
                          <span className="hidden lg:inline-flex"><StatusDot status={g.status} /></span>
                        </span>
                      </td>
                      <td><ClientCell name={g.clientName} hue={g.clientHue} /></td>
                      <td className="is-num">{int(g.count)}</td>
                      <td className="is-num" title={g.warmupOff ? `${g.warmupOff} with warmup off` : undefined}>
                        {n0(g.avgWarmup)}{g.warmupOff ? <span className="text-faint"> · {g.warmupOff} off</span> : null}
                      </td>
                      <td className="is-num">{n0(g.avgLimit)}</td>
                      <td className="is-num">{g.capacity ? int(g.capacity) : <span className="zero">0</span>}</td>
                      <td className="is-num" title={g.minRep != null ? `Lowest ${g.minRep.toFixed(0)}${g.lowRep ? `, ${g.lowRep} under 90` : ""}` : undefined}>
                        <Metric value={g.avgRep} warn={95} bad={90} invert digits={1} suffix="" />
                        {g.lowRep ? <span className="text-danger-ink"> · {g.lowRep} low</span> : null}
                      </td>
                      <td className="is-num">{g.campaigns ? int(g.campaigns) : <span className="zero">0</span>}</td>
                      <td className="is-num">{g.sent7 ? int(g.sent7) : <span className="zero">0</span>}</td>
                      <td className="is-num"><Metric value={rate(g.replies7, g.sent7)} digits={2} /></td>
                      <td className="is-num"><Metric value={rate(g.bounces7, g.sent7)} warn={2} bad={3} /></td>
                      <td className="is-num text-muted"><span className="zero">—</span></td>
                    </tr>
                    {isOpen ? g.inboxes.map((i) => (
                      <tr key={i.id} style={{ background: "var(--surface-2)" }}>
                        <td className="col-first" style={{ paddingLeft: 34 }}>
                          <span className="flex items-center gap-2">
                            <span className="text-ink-soft">{i.email}</span>
                            {i.status !== "connected" ? <span className="badge">{i.status}</span> : null}
                          </span>
                        </td>
                        <td className="text-muted">{i.senderName ?? <span className="zero">—</span>}</td>
                        <td className="is-num"><span className="zero">—</span></td>
                        <td className="is-num">{i.warmupEnabled ? int(i.warmupPerDay) : <span className="zero">off</span>}{i.warmupRampup ? <span className="text-faint"> · +{i.warmupRampup}</span> : null}</td>
                        <td className="is-num">{i.dailyLimit ? int(i.dailyLimit) : <span className="zero">0</span>}</td>
                        <td className="is-num">{i.dailyLimit ? int(i.dailyLimit) : <span className="zero">0</span>}</td>
                        <td className="is-num"><Metric value={i.warmupReputation} warn={95} bad={90} invert digits={0} suffix="" /></td>
                        <td className="is-num">{i.campaigns ? int(i.campaigns) : <span className="zero">0</span>}</td>
                        <td className="is-num">{i.sent7 ? int(i.sent7) : <span className="zero">0</span>}</td>
                        <td className="is-num"><Metric value={rate(i.replies7, i.sent7)} digits={2} /></td>
                        <td className="is-num"><Metric value={rate(i.bounces7, i.sent7)} warn={2} bad={3} /></td>
                        <td className="is-num text-muted">{i.lastSyncedAt ? ago(i.lastSyncedAt) : <span className="zero">never</span>}</td>
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
          <span><b>{totals.avgRep == null ? "—" : totals.avgRep.toFixed(1)}</b> avg reputation</span>
        </div>
      </div>
    </div>
  );
}
