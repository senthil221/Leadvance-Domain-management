"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { Archive, LifeBuoy, ArrowDown, ArrowRight, ArrowUp, Copy, Download, Globe, Search, Tag, X } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ColumnsMenu, useColumns, type ColumnDef } from "@/components/Columns";
import { SetupDialog } from "@/components/domains/SetupDialog";
import { MarkReplacedDialog } from "./MarkReplacedDialog";
import { Badge, ClientCell, Empty, TagList } from "@/components/ui";
import { daysSince, int, shortDate } from "@/lib/format";
import type { ClientRow, DomainRow } from "@/lib/queries";
import { LIFE, LIFE_ORDER, LIFE_TABS, htOf, lifeOf, nsOf, type Life } from "@/lib/lifecycle";

// Ownership view of every domain: where it is in its life (free, setting up,
// active, replaced, retired), where it is registered, where its nameservers
// point and what Hypertide knows about it.

const COLUMNS: ColumnDef[] = [
  { key: "life", label: "Lifecycle" }, { key: "client", label: "Client" }, { key: "registrar", label: "Registrar" },
  { key: "ns", label: "Nameservers" }, { key: "ht", label: "Hypertide" }, { key: "inboxes", label: "Inboxes" },
  { key: "capacity", label: "Per day" }, { key: "age", label: "Active for" }, { key: "bought", label: "Bought", hidden: true },
  { key: "renews", label: "Renews" },
];

type SortKey = "name" | "life" | "client" | "registrar" | "ns" | "ht" | "inboxCount" | "capacity" | "purchasedAt" | "expiresAt" | "age";
const sortValue = (d: DomainRow, k: SortKey): string | number | null => {
  switch (k) {
    case "life": return LIFE_ORDER.indexOf(lifeOf(d));
    case "client": return d.clientName?.toLowerCase() ?? null;
    case "registrar": return d.registrar?.toLowerCase() ?? null;
    case "ns": { const n = nsOf(d); return `${n.tone === "danger" ? 0 : n.tone === "warning" ? 1 : 2}${n.host ?? "~"}`; }
    case "ht": return htOf(d)?.label ?? null;
    case "purchasedAt": case "expiresAt": return d[k] ? new Date(d[k]!).getTime() : null;
    case "age": return d.activeSince ? new Date(d.activeSince).getTime() * -1 : null;
    default: return d[k] as string | number | null;
  }
};

export function InventoryView({ domains, clients }: { domains: DomainRow[]; clients: ClientRow[] }) {
  const params = useSearchParams();
  const viewOf = (v: string | null): Life | "all" => (v && (v === "all" || v in LIFE) ? (v as Life | "all") : "active");
  const [view, setView] = useState<Life | "all">(() => viewOf(params.get("view")));
  // The number cards above link to ?view=…; follow the address when it changes.
  const urlView = params.get("view");
  const [lastUrlView, setLastUrlView] = useState(urlView);
  if (urlView !== lastUrlView) {
    setLastUrlView(urlView);
    setView(viewOf(urlView));
  }
  const [q, setQ] = useState("");
  const [clientId, setClientId] = useState("");
  const [tag, setTag] = useState("");
  const [registrar, setRegistrar] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "life", dir: 1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [setupOpen, setSetupOpen] = useState(false);
  const [moveTo, setMoveTo] = useState<"replaced" | "recovery" | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cols = useColumns("inventory", COLUMNS);
  const on = cols.on;

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (view === "active") p.delete("view"); else p.set("view", view);
    const s = p.toString();
    window.history.replaceState(null, "", s ? `?${s}` : window.location.pathname);
  }, [view]);

  const allTags = useMemo(() => [...new Set(domains.flatMap((d) => d.tags))].sort((a, b) => a.localeCompare(b)), [domains]);
  const registrars = useMemo(() => [...new Set(domains.map((d) => d.registrar ?? "Unknown"))].sort(), [domains]);
  const base = useMemo(() => domains.filter((d) =>
    (!clientId || d.clientId === clientId) && (!tag || d.tags.includes(tag)) && (!registrar || (d.registrar ?? "Unknown") === registrar),
  ), [domains, clientId, tag, registrar]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: base.length };
    for (const d of base) c[lifeOf(d)] = (c[lifeOf(d)] ?? 0) + 1;
    return c;
  }, [base]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return base
      .filter((d) => (view === "all" || lifeOf(d) === view) &&
        (!needle || d.name.includes(needle) || d.clientName?.toLowerCase().includes(needle) || d.tags.some((t) => t.toLowerCase().includes(needle))))
      .sort((a, b) => {
        const x = sortValue(a, sort.key), y = sortValue(b, sort.key);
        if (x === y) return a.name.localeCompare(b.name);
        if (x === null) return 1;
        if (y === null) return -1;
        return (x < y ? -1 : 1) * sort.dir;
      });
  }, [base, view, q, sort]);

  const selectedRows = useMemo(() => domains.filter((d) => selected.has(d.id)), [domains, selected]);
  const allShown = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someShown = rows.some((r) => selected.has(r.id));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => 42, overscan: 14 });
  const items = virtual.getVirtualItems();
  const padTop = items[0]?.start ?? 0;
  const padBottom = items.length ? virtual.getTotalSize() - items[items.length - 1].end : 0;

  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: ["inboxCount", "capacity"].includes(key) ? -1 : 1 }));
  const Th = ({ k, children, num }: { k: SortKey; children: React.ReactNode; num?: boolean }) => (
    <th className={num ? "is-num" : undefined} aria-sort={sort.key === k ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
      <button type="button" className="sort-head" onClick={() => sortBy(k)}>
        {children}
        {sort.key === k ? (sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : null}
      </button>
    </th>
  );

  const copy = async (ns: string[]) => {
    try { await navigator.clipboard.writeText(ns.join("\n")); toast.success("Nameservers copied"); } catch { toast.error("Couldn't copy"); }
  };

  const exportCsv = () => {
    const list = selectedRows.length ? selectedRows : rows;
    const head = ["domain", "lifecycle", "status", "replaced_by", "client", "tags", "registrar", "nameservers", "hypertide", "inboxes", "capacity_per_day", "purchased", "renews"];
    const esc = (v: unknown) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const day = (v: Date | null) => (v ? new Date(v).toISOString().slice(0, 10) : "");
    const lines = list.map((d) => [d.name, LIFE[lifeOf(d)].label, d.status, d.replacedByName, d.clientName, d.tags.join("; "), d.registrar, d.nameservers.join(" "), htOf(d)?.label, d.inboxCount, d.capacity, day(d.purchasedAt), day(d.expiresAt)].map(esc).join(","));
    const url = URL.createObjectURL(new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" }));
    Object.assign(document.createElement("a"), { href: url, download: `inventory-${new Date().toISOString().slice(0, 10)}.csv` }).click();
    URL.revokeObjectURL(url);
  };

  const filtered = q || clientId || tag || registrar;
  const capacity = rows.reduce((a, r) => a + r.capacity, 0);
  const COLS = 2 + cols.count;

  return (
    <>
      <div className="flex flex-col gap-3">
        <div className="table-bar">
          <div className="view-tabs" role="tablist" aria-label="Lifecycle">
            {([...LIFE_TABS, "all"] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={view === k} className={view === k ? "is-on" : undefined} onClick={() => { setView(k); scrollRef.current?.scrollTo({ top: 0 }); }}>
                {k === "all" ? "All" : LIFE[k].label} <span>{int(counts[k] ?? 0)}</span>
              </button>
            ))}
          </div>
          <select className="select" style={{ width: 150 }} value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Filter by client">
            <option value="">All clients</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {allTags.length ? (
            <select className="select" style={{ width: 130 }} value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Filter by tag">
              <option value="">All tags</option>
              {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          ) : null}
          {registrars.length > 1 ? (
            <select className="select" style={{ width: 150 }} value={registrar} onChange={(e) => setRegistrar(e.target.value)} aria-label="Filter by registrar">
              <option value="">All registrars</option>
              {registrars.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          ) : null}
          {filtered ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setQ(""); setClientId(""); setTag(""); setRegistrar(""); }}>Clear</button> : null}
          <span className="spacer-auto" />
          <label className="search-input">
            <Search size={14} strokeWidth={1.5} />
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search inventory" />
          </label>
          <button type="button" className="btn btn-sm" onClick={exportCsv}><Download size={14} /> Export</button>
          <ColumnsMenu cols={cols} />
        </div>

        <div className="table-wrap">
          <div ref={scrollRef} className="table-scroll" style={{ maxHeight: "calc(100dvh - 240px)", minHeight: 280 }}>
            <table className="data-table is-main" aria-rowcount={rows.length}>
              <thead>
                <tr>
                  <th className="col-check">
                    <input type="checkbox" className="checkbox" aria-label="Select all shown" checked={allShown}
                      ref={(el) => { if (el) el.indeterminate = !allShown && someShown; }}
                      onChange={() => setSelected((s) => { const n = new Set(s); rows.forEach((r) => (allShown ? n.delete(r.id) : n.add(r.id))); return n; })} />
                  </th>
                  <Th k="name">Domain</Th>
                  {on("life") ? <Th k="life">Lifecycle</Th> : null}
                  {on("client") ? <Th k="client">Client</Th> : null}
                  {on("registrar") ? <Th k="registrar">Registrar</Th> : null}
                  {on("ns") ? <Th k="ns">Nameservers</Th> : null}
                  {on("ht") ? <Th k="ht">Hypertide</Th> : null}
                  {on("inboxes") ? <Th k="inboxCount" num>Inboxes</Th> : null}
                  {on("capacity") ? <Th k="capacity" num>Per day</Th> : null}
                  {on("age") ? <Th k="age" num>Active</Th> : null}
                  {on("bought") ? <Th k="purchasedAt" num>Bought</Th> : null}
                  {on("renews") ? <Th k="expiresAt" num>Renews</Th> : null}
                </tr>
              </thead>
              <tbody>
                {padTop > 0 ? <tr aria-hidden="true"><td colSpan={COLS} style={{ height: padTop, padding: 0, border: 0 }} /></tr> : null}
                {items.map((vi) => {
                  const d = rows[vi.index];
                  const life = LIFE[lifeOf(d)];
                  const ns = nsOf(d);
                  const ht = htOf(d);
                  const isSel = selected.has(d.id);
                  return (
                    <tr key={d.id} data-index={vi.index} data-selected={isSel} className="is-clickable" onClick={() => toggle(d.id)}>
                      <td className="col-check"><input type="checkbox" className="checkbox" checked={isSel} onChange={() => {}} aria-label={`Select ${d.name}`} tabIndex={-1} /></td>
                      <td className="col-first">
                        <span className="flex items-center gap-2">
                          <Link href={`/domains?d=${d.id}&view=all`} className="strong hover:underline" onClick={(e) => e.stopPropagation()}>{d.name}</Link>
                          <TagList tags={d.tags} graceDaysLeft={d.graceDaysLeft} />
                        </span>
                      </td>
                      {on("life") ? (
                      <td>
                        <span className="flex items-center gap-1.5">
                          <span className={`status-dot tone-${life.tone}`}>{life.label}</span>
                          {d.replacedById ? (
                            <Link href={`/domains?d=${d.replacedById}&view=all`} className="flex items-center gap-1 truncate text-muted hover:text-ink" onClick={(e) => e.stopPropagation()} title={`Replaced ${shortDate(d.replacedAt)}`}>
                              <ArrowRight size={12} />{d.replacedByName}
                            </Link>
                          ) : null}
                        </span>
                      </td>
                      ) : null}
                      {on("client") ? (
                      <td><ClientCell name={d.clientName} hue={d.clientHue} /></td>
                      ) : null}
                      {on("registrar") ? (
                      <td>
                        {d.registrar ?? <span className="zero">—</span>}
                        {d.registrar === "Porkbun" && d.apiAccess === false ? (
                          <span className="badge tone-warning ml-1.5" title="API access is off for this domain at Porkbun, so the app can read but not change its nameservers. Turn it on in Porkbun → Domain → Details → API Access.">API off</span>
                        ) : null}
                      </td>
                      ) : null}
                      {on("ns") ? (
                      <td>
                        <span className="ns-cell" title={ns.title}>
                          <span className={`dot tone-${ns.tone}`} />
                          <span className="ns-host">{ns.host ?? "—"}</span>
                          <span className={`ns-status tone-${ns.tone}`}>{ns.status}</span>
                          {ns.copy?.length ? (
                            <button type="button" className="icon-btn row-actions" aria-label="Copy nameservers" title={`Copy ${ns.copy.join(", ")}`} onClick={(e) => { e.stopPropagation(); copy(ns.copy!); }}><Copy size={12} /></button>
                          ) : null}
                        </span>
                      </td>
                      ) : null}
                      {on("ht") ? (
                      <td>{ht ? <Badge tone={ht.tone}>{ht.label}</Badge> : <span className="zero">—</span>}</td>
                      ) : null}
                      {on("inboxes") ? (
                      <td className="is-num">{d.inboxCount ? int(d.inboxCount) : <span className="zero">0</span>}</td>
                      ) : null}
                      {on("capacity") ? (
                      <td className="is-num">{d.capacity ? int(d.capacity) : <span className="zero">0</span>}</td>
                      ) : null}
                      {on("age") ? (
                      <td className="is-num text-muted">{d.activeSince && d.status !== "in_storage" ? `${daysSince(d.activeSince)}d` : <span className="zero">—</span>}</td>
                      ) : null}
                      {on("bought") ? (
                      <td className="is-num text-muted">{d.purchasedAt ? shortDate(d.purchasedAt) : <span className="zero">—</span>}</td>
                      ) : null}
                      {on("renews") ? (
                      <td className="is-num text-muted">{d.expiresAt ? shortDate(d.expiresAt) : <span className="zero">—</span>}</td>
                      ) : null}
                    </tr>
                  );
                })}
                {padBottom > 0 ? <tr aria-hidden="true"><td colSpan={COLS} style={{ height: padBottom, padding: 0, border: 0 }} /></tr> : null}
              </tbody>
            </table>
            {rows.length === 0 ? (
              <Empty icon={Globe} title={filtered ? "No domains match" : "Nothing here"}>
                {filtered ? "Try a different search or filter." : "Domains show up here as they move through their life."}
              </Empty>
            ) : null}
          </div>
          <div className="table-footer">
            <span><b>{int(rows.length)}</b> domains</span>
            <span><b>{int(rows.reduce((a, r) => a + r.inboxCount, 0))}</b> inboxes</span>
            <span><b>{int(capacity)}</b> campaign emails a day</span>
            <span className="table-footer-hint hidden md:inline-flex">Click rows to select, then Set up</span>
          </div>
        </div>
      </div>

      {selected.size > 0 ? (
        <div className="bulk-bar" role="toolbar" aria-label="Selected domains">
          <span className="bulk-count">{selected.size} selected</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setSetupOpen(true)}><Tag size={14} /> Set up</button>
          <button type="button" className="btn btn-sm" disabled={!selectedRows.some((d) => lifeOf(d) !== "replaced")} onClick={() => setMoveTo("replaced")}><Archive size={14} /> Mark as replaced</button>
          <button type="button" className="btn btn-sm" disabled={!selectedRows.some((d) => lifeOf(d) !== "recovery")} onClick={() => setMoveTo("recovery")}><LifeBuoy size={14} /> Move to recovery</button>
          <button type="button" className="btn btn-sm" onClick={exportCsv}><Download size={14} /> Export</button>
          <span className="sep" />
          <button type="button" className="btn btn-sm" aria-label="Clear selection" onClick={() => setSelected(new Set())}><X size={14} /></button>
        </div>
      ) : null}

      <MarkReplacedDialog to={moveTo ?? "replaced"} open={moveTo !== null} onOpenChange={(o) => { if (!o) setMoveTo(null); }}
        targets={selectedRows.filter((d) => lifeOf(d) !== moveTo).map((d) => ({ id: d.id, name: d.name }))}
        onDone={() => setSelected(new Set())} />
      <SetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        targets={selectedRows.map((d) => ({ id: d.id, name: d.name, status: d.status, tags: d.tags, registrar: d.registrar }))}
        clients={clients}
        allTags={allTags}
        onDone={() => setSelected(new Set())}
      />
    </>
  );
}
