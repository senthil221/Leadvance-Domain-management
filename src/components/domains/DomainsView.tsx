"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { DropdownMenu } from "radix-ui";
import { ArrowDown, ArrowLeftRight, ArrowUp, Building2, ChevronDown, CircleDot, Download, Globe, Search, TriangleAlert, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { assignClient } from "@/app/actions";
import { isTyping } from "@/components/shell/AppShell";
import { ClientCell, Empty, Kbd, Metric, Spark, StatusDot } from "@/components/ui";
import { daysSince, int, shortDate } from "@/lib/format";
import type { ClientRow, DomainRow } from "@/lib/queries";
import { DOMAIN_STATUSES, type DomainStatus } from "@/lib/status";
import { ChangeStatusDialog } from "./ChangeStatusDialog";
import { DomainSheet } from "./DomainSheet";
import { ReplaceDialog, type ReplaceTarget } from "./ReplaceDialog";

type ViewKey = "all" | "active" | "setup" | "draining" | "storage" | "retired" | "flagged";
const VIEWS: { key: ViewKey; label: string; match: (d: DomainRow) => boolean }[] = [
  { key: "active", label: "Active", match: (d) => d.status === "active" },
  { key: "flagged", label: "Flagged", match: (d) => d.openAlerts > 0 && (d.status === "active" || d.status === "warming") },
  { key: "setup", label: "Setting up", match: (d) => d.status === "provisioning" || d.status === "warming" },
  { key: "draining", label: "Draining", match: (d) => d.status === "draining" },
  { key: "storage", label: "Storage", match: (d) => d.status === "in_storage" },
  { key: "retired", label: "Retired", match: (d) => d.status === "burned" || d.status === "resting" },
  { key: "all", label: "All", match: () => true },
];

type SortKey = "name" | "status" | "client" | "inboxCount" | "sent" | "humanReplyRate" | "bounceRate" | "warmupReputation" | "activeSince" | "purchasedAt" | "expiresAt" | "registrar";
type Sort = { key: SortKey; dir: 1 | -1 };

const statusRank = (s: DomainStatus) => DOMAIN_STATUSES.indexOf(s);
const sortValue = (d: DomainRow, k: SortKey): string | number | null => {
  switch (k) {
    case "status": return statusRank(d.status);
    case "client": return d.clientName?.toLowerCase() ?? null;
    case "registrar": return d.registrar?.toLowerCase() ?? null;
    case "activeSince": case "purchasedAt": case "expiresAt": return d[k] ? new Date(d[k]!).getTime() : null;
    default: return d[k] as string | number | null;
  }
};

const replaceable = (d: DomainRow) => d.status === "active" || d.status === "warming";
const toTarget = (d: DomainRow): ReplaceTarget => ({ id: d.id, name: d.name, tld: d.tld, clientName: d.clientName, clientHue: d.clientHue });

export function DomainsView({ domains, clients }: { domains: DomainRow[]; clients: ClientRow[] }) {
  const params = useSearchParams();
  const [view, setView] = useState<ViewKey>(() => (VIEWS.some((v) => v.key === params.get("view")) ? (params.get("view") as ViewKey) : "active"));
  const [q, setQ] = useState(() => params.get("q") ?? "");
  const [clientId, setClientId] = useState(() => params.get("client") ?? "");
  const [openId, setOpenId] = useState<string | null>(() => params.get("d"));
  const [sort, setSort] = useState<Sort>({ key: "name", dir: 1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(-1);
  const [replaceTargets, setReplaceTargets] = useState<ReplaceTarget[] | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [, startTransition] = useTransition();
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the URL in step so any view can be bookmarked or shared.
  useEffect(() => {
    const p = new URLSearchParams();
    if (view !== "active") p.set("view", view);
    if (q) p.set("q", q);
    if (clientId) p.set("client", clientId);
    if (openId) p.set("d", openId);
    const s = p.toString();
    window.history.replaceState(null, "", s ? `?${s}` : window.location.pathname);
  }, [view, q, clientId, openId]);

  const byClient = useMemo(() => (clientId ? domains.filter((d) => d.clientId === clientId) : domains), [domains, clientId]);
  const counts = useMemo(() => Object.fromEntries(VIEWS.map((v) => [v.key, byClient.filter(v.match).length])), [byClient]);

  const rows = useMemo(() => {
    const match = VIEWS.find((v) => v.key === view)!.match;
    const needle = q.trim().toLowerCase();
    const out = byClient.filter((d) => match(d) && (!needle || d.name.includes(needle) || d.clientName?.toLowerCase().includes(needle)));
    return out.sort((a, b) => {
      const x = sortValue(a, sort.key), y = sortValue(b, sort.key);
      if (x === y) return a.name.localeCompare(b.name);
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * sort.dir;
    });
  }, [byClient, view, q, sort]);

  // Selection only ever holds rows that still exist.
  const selectedRows = useMemo(() => domains.filter((d) => selected.has(d.id)), [domains, selected]);
  const allShownSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someShownSelected = rows.some((r) => selected.has(r.id));

  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => 42, overscan: 14 });

  const toggle = useCallback((id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  }), []);

  const clearSelection = () => setSelected(new Set());
  const afterChange = () => { clearSelection(); setReloadKey((k) => k + 1); };

  const startReplace = useCallback((list: DomainRow[]) => {
    const ok = list.filter(replaceable);
    if (ok.length === 0) {
      toast.error("Only active or warming domains can be replaced");
      return;
    }
    if (ok.length < list.length) toast(`${list.length - ok.length} skipped: only active or warming domains can be replaced`);
    setReplaceTargets(ok.map(toTarget));
  }, []);

  // Keyboard: j/k move, x select, enter open, r replace, / search, esc clear.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector("[role=dialog]")) return;
      if (isTyping(e)) {
        if (e.key === "Escape") (e.target as HTMLElement).blur();
        return;
      }
      const move = (to: number) => {
        const i = Math.max(0, Math.min(rows.length - 1, to));
        setCursor(i);
        virtual.scrollToIndex(i, { align: "auto" });
      };
      if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); move(cursor + 1); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); move(cursor - 1); }
      else if (e.key === "x" && rows[cursor]) toggle(rows[cursor].id);
      else if (e.key === "Enter" && rows[cursor]) setOpenId(rows[cursor].id);
      else if (e.key === "r") {
        if (selectedRows.length) startReplace(selectedRows);
        else if (rows[cursor]) startReplace([rows[cursor]]);
      } else if (e.key === "Escape" && selected.size) clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, cursor, selected, selectedRows, toggle, startReplace, virtual]);

  const changeView = (v: ViewKey) => { setView(v); setCursor(-1); scrollRef.current?.scrollTo({ top: 0 }); };

  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "name" || key === "client" || key === "registrar" ? 1 : -1 }));
  const Th = ({ k, children, num }: { k: SortKey; children: React.ReactNode; num?: boolean }) => (
    <th className={num ? "is-num" : undefined} aria-sort={sort.key === k ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
      <button type="button" className="sort-head" onClick={() => sortBy(k)}>
        {children}
        {sort.key === k ? (sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : null}
      </button>
    </th>
  );

  const storageView = view === "storage";
  const totals = useMemo(() => rows.reduce((a, r) => ({ sent: a.sent + r.sent, human: a.human + r.humanReplies, bounces: a.bounces + r.bounces, inboxes: a.inboxes + r.inboxCount }), { sent: 0, human: 0, bounces: 0, inboxes: 0 }), [rows]);

  const exportCsv = () => {
    const list = selectedRows.length ? selectedRows : rows;
    const head = ["domain", "status", "client", "registrar", "inboxes", "sent_7d", "human_replies_7d", "bounces_7d", "bounce_rate", "human_reply_rate", "warmup_reputation", "active_since"];
    const esc = (v: unknown) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = list.map((d) => [d.name, d.status, d.clientName, d.registrar, d.inboxCount, d.sent, d.humanReplies, d.bounces, d.bounceRate, d.humanReplyRate, d.warmupReputation, d.activeSince ? new Date(d.activeSince).toISOString().slice(0, 10) : ""].map(esc).join(","));
    const url = URL.createObjectURL(new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `domains-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };

  const doAssign = (id: string | null) =>
    startTransition(async () => {
      const res = await assignClient({ ids: selectedRows.map((d) => d.id), clientId: id });
      if (!res.ok) return void toast.error(res.error);
      const name = clients.find((c) => c.id === id)?.name;
      toast.success(`${res.data.changed} domain${res.data.changed === 1 ? "" : "s"} ${name ? `assigned to ${name}` : "unassigned"}`);
      afterChange();
    });

  const items = virtual.getVirtualItems();
  const padTop = items[0]?.start ?? 0;
  const padBottom = items.length ? virtual.getTotalSize() - items[items.length - 1].end : 0;
  const colCount = storageView ? 6 : 11;

  return (
    <>
      <div className="flex flex-col gap-3">
        <div className="view-tabs" role="tablist" aria-label="Views">
          {VIEWS.map((v) => (
            <button key={v.key} type="button" role="tab" aria-selected={view === v.key} className={view === v.key ? "is-on" : undefined} onClick={() => changeView(v.key)}>
              {v.key === "flagged" && counts.flagged > 0 ? <TriangleAlert size={13} className="text-warning-ink" /> : null}
              {v.label} <span>{int(counts[v.key])}</span>
            </button>
          ))}
        </div>

        <div className="toolbar">
          <label className="search-input">
            <Search size={14} strokeWidth={1.5} />
            <input ref={searchRef} className="input" value={q} onChange={(e) => { setQ(e.target.value); setCursor(-1); }} placeholder="Search domains or clients" aria-label="Search domains" />
            {!q ? <span className="pointer-events-none absolute right-2"><Kbd>/</Kbd></span> : null}
          </label>
          <select className="select" style={{ width: 180 }} value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Filter by client">
            <option value="">All clients</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {(q || clientId) ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setQ(""); setClientId(""); }}>Clear</button> : null}
          <div className="view-tabs-summary">
            <b>{int(rows.length)}</b> domains
            {!storageView ? <> · <b>{int(totals.sent)}</b> sent this week</> : null}
          </div>
        </div>

        <div className="table-wrap">
          <div ref={scrollRef} className="table-scroll" style={{ maxHeight: "calc(100dvh - 248px)", minHeight: 280 }}>
            <table className="data-table is-main" aria-rowcount={rows.length}>
              <thead>
                <tr>
                  <th className="col-check">
                    <input
                      type="checkbox"
                      className="checkbox"
                      aria-label="Select all shown"
                      checked={allShownSelected}
                      ref={(el) => { if (el) el.indeterminate = !allShownSelected && someShownSelected; }}
                      onChange={() => setSelected((s) => {
                        const n = new Set(s);
                        if (allShownSelected) rows.forEach((r) => n.delete(r.id)); else rows.forEach((r) => n.add(r.id));
                        return n;
                      })}
                    />
                  </th>
                  <Th k="name">Domain</Th>
                  {storageView ? (
                    <><Th k="registrar">Registrar</Th><Th k="purchasedAt">Purchased</Th><Th k="expiresAt">Renews</Th><th>TLD</th></>
                  ) : (
                    <>
                      <Th k="status">Status</Th>
                      <Th k="client">Client</Th>
                      <Th k="inboxCount" num>Inboxes</Th>
                      <Th k="sent" num>Sent 7d</Th>
                      <Th k="humanReplyRate" num>Human reply</Th>
                      <Th k="bounceRate" num>Bounce</Th>
                      <Th k="warmupReputation" num>Reputation</Th>
                      <th>14 days</th>
                      <Th k="activeSince" num>Active</Th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {padTop > 0 ? <tr aria-hidden="true"><td colSpan={colCount} style={{ height: padTop, padding: 0, border: 0 }} /></tr> : null}
                {items.map((vi) => {
                  const d = rows[vi.index];
                  const isSel = selected.has(d.id);
                  return (
                    <tr
                      key={d.id}
                      data-index={vi.index}
                      className="is-clickable"
                      data-selected={isSel}
                      data-active={cursor === vi.index}
                      onClick={(e) => {
                        setCursor(vi.index);
                        if (e.shiftKey || e.metaKey || e.ctrlKey) toggle(d.id);
                        else setOpenId(d.id);
                      }}
                    >
                      <td className="col-check" onClick={(e) => { e.stopPropagation(); toggle(d.id); setCursor(vi.index); }}>
                        <input type="checkbox" className="checkbox" checked={isSel} onChange={() => {}} aria-label={`Select ${d.name}`} tabIndex={-1} />
                      </td>
                      <td className="col-first">
                        <span className="flex items-center gap-2">
                          <span className="strong">{d.name}</span>
                          {d.openAlerts > 0 && replaceable(d) ? <TriangleAlert size={13} className="text-warning-ink" aria-label={`${d.openAlerts} open alerts`} /> : null}
                        </span>
                      </td>
                      {storageView ? (
                        <>
                          <td>{d.registrar ?? <span className="zero">—</span>}</td>
                          <td className="num">{shortDate(d.purchasedAt)}</td>
                          <td className="num">{shortDate(d.expiresAt)}</td>
                          <td><span className="badge">.{d.tld}</span></td>
                        </>
                      ) : (
                        <>
                          <td><StatusDot status={d.status} /></td>
                          <td><ClientCell name={d.clientName} hue={d.clientHue} /></td>
                          <td className="is-num">{d.inboxCount ? d.inboxCount : <span className="zero">0</span>}</td>
                          <td className="is-num">
                            {d.sent ? int(d.sent) : d.sl7Sent ? (
                              <span className="text-faint" title="From Smartlead's 7-day analytics. The app's own count starts with the Email Sent webhook.">{int(d.sl7Sent)}*</span>
                            ) : <span className="zero">0</span>}
                          </td>
                          <td className="is-num"><Metric value={d.sent ? d.humanReplyRate : null} digits={2} /></td>
                          <td className="is-num"><Metric value={d.sent ? d.bounceRate : null} warn={2} bad={3} /></td>
                          <td className="is-num"><Metric value={d.warmupReputation} warn={95} bad={90} invert digits={0} suffix="" /></td>
                          <td><Spark values={d.spark} bad={d.openAlerts > 0} /></td>
                          <td className="is-num text-muted">{d.activeSince && d.status !== "in_storage" ? `${daysSince(d.activeSince)}d` : <span className="zero">—</span>}</td>
                        </>
                      )}
                    </tr>
                  );
                })}
                {padBottom > 0 ? <tr aria-hidden="true"><td colSpan={colCount} style={{ height: padBottom, padding: 0, border: 0 }} /></tr> : null}
              </tbody>
            </table>
            {rows.length === 0 ? (
              <Empty icon={Globe} title={q || clientId ? "No domains match" : "Nothing here yet"}>
                {q || clientId ? "Try a different search or client." : view === "flagged" ? "No sending domain is breaking a health rule." : "Domains in this state will show up here."}
              </Empty>
            ) : null}
          </div>
          <div className="table-footer">
            <span><b>{int(rows.length)}</b> domains</span>
            {!storageView ? (
              <>
                <span><b>{int(totals.inboxes)}</b> inboxes</span>
                <span><b>{int(totals.sent)}</b> sent</span>
                <span><b>{int(totals.human)}</b> human replies</span>
                <span><b>{totals.sent ? ((100 * totals.bounces) / totals.sent).toFixed(1) : "0.0"}%</b> bounce</span>
              </>
            ) : null}
            <span className="table-footer-hint hidden md:inline-flex"><Kbd>J</Kbd><Kbd>K</Kbd> move <Kbd>X</Kbd> select <Kbd>R</Kbd> replace</span>
          </div>
        </div>
      </div>

      {selected.size > 0 ? (
        <div className="bulk-bar" role="toolbar" aria-label="Selected domains">
          <span className="bulk-count">{selected.size} selected</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => startReplace(selectedRows)}>
            <ArrowLeftRight size={14} /> Replace
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setStatusOpen(true)}>
            <CircleDot size={14} /> Status
          </button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" className="btn btn-sm menu-trigger"><Building2 size={14} /> Client <ChevronDown size={12} /></button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="menu" side="top" sideOffset={8} align="center">
                <DropdownMenu.Label className="menu-label">Assign to client</DropdownMenu.Label>
                {clients.map((c) => (
                  <DropdownMenu.Item key={c.id} className="menu-item" onSelect={() => doAssign(c.id)}>
                    <ClientCell name={c.name} hue={c.hue} />
                    <span className="menu-hint num">{c.activeCount}</span>
                  </DropdownMenu.Item>
                ))}
                <DropdownMenu.Separator className="menu-sep" />
                <DropdownMenu.Item className="menu-item" onSelect={() => doAssign(null)}>No client</DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <button type="button" className="btn btn-sm" onClick={exportCsv}><Download size={14} /> Export</button>
          <span className="sep" />
          <button type="button" className="btn btn-sm" aria-label="Clear selection" onClick={clearSelection}><X size={14} /></button>
        </div>
      ) : null}

      <DomainSheet
        domainId={openId}
        reloadKey={reloadKey}
        onClose={() => setOpenId(null)}
        onOpenDomain={(id) => setOpenId(id)}
        onReplace={(d) => { setOpenId(null); setReplaceTargets([{ id: d.id, name: d.name, tld: d.tld, clientName: d.clientName, clientHue: d.clientHue }]); }}
      />
      <ReplaceDialog
        open={replaceTargets !== null}
        onOpenChange={(o) => !o && setReplaceTargets(null)}
        targets={replaceTargets ?? []}
        onDone={afterChange}
      />
      <ChangeStatusDialog
        open={statusOpen}
        onOpenChange={setStatusOpen}
        targets={selectedRows.map((d) => ({ id: d.id, status: d.status }))}
        onDone={afterChange}
      />
    </>
  );
}
