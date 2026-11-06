"use client";

import { DomainLink } from "@/components/domains/DomainLink";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Archive, ArrowDown, ArrowLeftRight, ArrowRight, ArrowUp, CircleDot, Copy, Download, Globe, LifeBuoy, Search, Tag, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ColumnsMenu, useColumns, type ColumnDef } from "@/components/Columns";
import { ChangeStatusDialog } from "@/components/domains/ChangeStatusDialog";
import { ReplaceDialog } from "@/components/domains/ReplaceDialog";
import { SetupDialog } from "@/components/domains/SetupDialog";
import { ConfigureDomains, PasteSelect, WarmingButtons } from "@/components/domains/DomainBulk";
import { MarkReplacedDialog } from "./MarkReplacedDialog";
import { useCompact } from "@/components/ThemeToggle";
import { Badge, ClientCell, Empty, TagList } from "@/components/ui";
import { daysSince, fixedDate, int, shortDate } from "@/lib/format";
import type { ClientRow, DomainRow } from "@/lib/queries";
import { LIFE, LIFE_ORDER, LIFE_TABS, htOf, lifeOf, nsOf, type Life } from "@/lib/lifecycle";
import { SlBadge } from "@/components/domains/SlStatus";
import { SL_META, SL_ORDER, slState, slText, type SlState } from "@/lib/smartlead-state";

// Ownership view of every domain: where it is in its life (free, setting up,
// active, replaced, retired), where it is registered, where its nameservers
// point, what Hypertide knows about it and what its Icemail inboxes cost.

const COLUMNS: ColumnDef[] = [
  { key: "life", label: "Lifecycle" }, { key: "sl", label: "Smartlead" }, { key: "client", label: "Client" }, { key: "registrar", label: "Registrar" },
  { key: "ns", label: "Nameservers" }, { key: "ht", label: "Hypertide" }, { key: "icemail", label: "Icemail" },
  { key: "inboxes", label: "Inboxes" },
  { key: "capacity", label: "Per day" }, { key: "age", label: "Active for" }, { key: "domainAge", label: "Domain age" }, { key: "bought", label: "Bought", hidden: true },
  { key: "renews", label: "Renews" },
];

// Every column has a set width: the table only draws the rows on screen, so left
// to size itself the columns would jump as you scroll or change tab. Domain takes the rest.
const CHECK_WIDTH = 40, DOMAIN_MIN = 184;
const WIDTH: Record<string, number> = {
  life: 100, sl: 112, client: 108, registrar: 128, ns: 176, ht: 84, icemail: 104,
  inboxes: 66, capacity: 64, age: 58, domainAge: 56, bought: 100, renews: 100,
};

type SortKey = "name" | "life" | "sl" | "client" | "registrar" | "ns" | "ht" | "icemailMonthly" | "inboxCount" | "capacity" | "purchasedAt" | "expiresAt" | "age" | "domainAge";
const sortValue = (d: DomainRow, k: SortKey): string | number | null => {
  switch (k) {
    case "life": return LIFE_ORDER.indexOf(lifeOf(d));
    case "sl": return SL_ORDER.indexOf(slState(d));
    case "client": return d.clientName?.toLowerCase() ?? null;
    case "registrar": return d.registrar?.toLowerCase() ?? null;
    case "ns": { const n = nsOf(d); return `${n.tone === "danger" ? 0 : n.tone === "warning" ? 1 : 2}${n.host ?? "~"}`; }
    case "ht": return htOf(d)?.label ?? null;
    case "icemailMonthly": return d.icemailMailboxes ? d.icemailMonthly ?? 0 : null;
    case "purchasedAt": case "expiresAt": return d[k] ? new Date(d[k]!).getTime() : null;
    case "age": return d.activeSince ? new Date(d.activeSince).getTime() * -1 : null;
    case "domainAge": return d.bornAt ? new Date(d.bornAt).getTime() * -1 : null;
    default: return d[k] as string | number | null;
  }
};

const usd = (n: number) => `$${n.toFixed(n % 1 ? 2 : 0)}`;

const replaceable = (d: DomainRow) => d.status === "active" || d.status === "warming";

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
  const [clientId, setClientId] = useState(() => params.get("client") ?? "");
  const [tag, setTag] = useState("");
  // "v:<registrar>" for every account at a registrar, "a:<registrar>|<account>"
  // for one login. The breakdown tables link here with ?registrar= / ?tld=.
  const [registrar, setRegistrar] = useState(() => params.get("registrar") ?? "");
  const [tld, setTld] = useState(() => params.get("tld") ?? "");
  const [sl, setSl] = useState<SlState | "">(() => (SL_ORDER as string[]).includes(params.get("sl") ?? "") ? params.get("sl") as SlState : "");
  const urlRegistrar = params.get("registrar") ?? "", urlTld = params.get("tld") ?? "";
  const [lastUrlFilter, setLastUrlFilter] = useState(`${urlRegistrar}\n${urlTld}`);
  if (`${urlRegistrar}\n${urlTld}` !== lastUrlFilter) {
    setLastUrlFilter(`${urlRegistrar}\n${urlTld}`);
    setRegistrar(urlRegistrar);
    setTld(urlTld);
  }
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "life", dir: 1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [setupOpen, setSetupOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [moveTo, setMoveTo] = useState<"replaced" | "recovery" | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cols = useColumns("inventory", COLUMNS);
  // A provider nobody on this server uses is only an empty column.
  const hasHt = useMemo(() => domains.some((d) => htOf(d)), [domains]);
  const hasIcemail = useMemo(() => domains.some((d) => d.icemailMailboxes || d.icemailIssue), [domains]);
  // Nothing is sending on these tabs, so a daily capacity column only says 0.
  const idle = view === "replaced" || view === "cooling" || view === "recovery" || view === "expired";
  const on = (k: string) => cols.on(k) && (k !== "ht" || hasHt) && (k !== "icemail" || hasIcemail) && (k !== "capacity" || !idle);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (view === "active") p.delete("view"); else p.set("view", view);
    if (registrar) p.set("registrar", registrar); else p.delete("registrar");
    if (tld) p.set("tld", tld); else p.delete("tld");
    if (sl) p.set("sl", sl); else p.delete("sl");
    const s = p.toString();
    window.history.replaceState(null, "", s ? `?${s}` : window.location.pathname);
  }, [view, registrar, tld, sl]);

  const allTags = useMemo(() => [...new Set(domains.flatMap((d) => d.tags))].sort((a, b) => a.localeCompare(b)), [domains]);
  // Registrars with their accounts and counts, for the filter.
  const registrars = useMemo(() => {
    const by = new Map<string, { total: number; accounts: Map<string, number> }>();
    for (const d of domains) {
      const v = d.registrar ?? "Unknown";
      const r = by.get(v) ?? { total: 0, accounts: new Map() };
      r.total++;
      if (d.registrarAccount) r.accounts.set(d.registrarAccount, (r.accounts.get(d.registrarAccount) ?? 0) + 1);
      by.set(v, r);
    }
    return [...by.entries()].sort((a, b) => (a[0] === "Unknown" ? 1 : b[0] === "Unknown" ? -1 : b[1].total - a[1].total))
      .map(([name, r]) => ({ name, total: r.total, accounts: [...r.accounts.entries()].sort((a, b) => b[1] - a[1]) }));
  }, [domains]);
  const tlds = useMemo(() => {
    const c = new Map<string, number>();
    for (const d of domains) c.set(d.tld ?? "?", (c.get(d.tld ?? "?") ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [domains]);
  // Every filter but Smartlead's, so its menu counts what each choice would leave.
  const preSl = useMemo(() => {
    const [kind, value] = [registrar.slice(0, 2), registrar.slice(2)];
    const [vendor, account] = kind === "a:" ? value.split("|") : [value, null];
    return domains.filter((d) =>
      (!clientId || d.clientId === clientId) && (!tag || d.tags.includes(tag)) && (!tld || (d.tld ?? "?") === tld) &&
      (!registrar || ((d.registrar ?? "Unknown") === vendor && (account == null || d.registrarAccount === account))));
  }, [domains, clientId, tag, registrar, tld]);
  const slCounts = useMemo(() => {
    const c = new Map<SlState, number>();
    for (const d of preSl) if (view === "all" || lifeOf(d) === view) c.set(slState(d), (c.get(slState(d)) ?? 0) + 1);
    return c;
  }, [preSl, view]);
  const base = useMemo(() => (sl ? preSl.filter((d) => slState(d) === sl) : preSl), [preSl, sl]);
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
  const compact = useCompact();
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => (compact ? 30 : 42), overscan: 14 });
  // Rows change height with the compact view: size them again.
  useEffect(() => { virtual.measure(); }, [compact, virtual]);
  const items = virtual.getVirtualItems();
  const padTop = items[0]?.start ?? 0;
  const padBottom = items.length ? virtual.getTotalSize() - items[items.length - 1].end : 0;

  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: ["inboxCount", "capacity"].includes(key) ? -1 : 1 }));
  const Th = ({ k, children, num, first, title }: { k: SortKey; children: React.ReactNode; num?: boolean; first?: boolean; title?: string }) => (
    <th className={num ? "is-num" : first ? "col-first" : undefined} title={title} aria-sort={sort.key === k ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
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
    const head = ["domain", "lifecycle", "smartlead", "status", "replaced_by", "client", "tags", "registrar", "registrar_account", "nameservers", "hypertide", "icemail_mailboxes", "icemail_per_month", "icemail_next_bill", "icemail_issue", "inboxes", "capacity_per_day", "purchased", "renews", "last_used", "reuse_from"];
    const esc = (v: unknown) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const day = (v: Date | null) => (v ? new Date(v).toISOString().slice(0, 10) : "");
    const lines = list.map((d) => [d.name, LIFE[lifeOf(d)].label, slText(d), d.status, d.replacedByName, d.clientName, d.tags.join("; "), d.registrar, d.registrarAccount, d.nameservers.join(" "), htOf(d)?.label, d.icemailMailboxes, d.icemailMonthly?.toFixed(2), day(d.icemailNextBill), d.icemailIssue, d.inboxCount, d.capacity, day(d.purchasedAt), day(d.expiresAt), day(d.lastUsedOn), day(d.coolingUntil)].map(esc).join(","));
    const url = URL.createObjectURL(new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" }));
    Object.assign(document.createElement("a"), { href: url, download: `inventory-${new Date().toISOString().slice(0, 10)}.csv` }).click();
    URL.revokeObjectURL(url);
  };

  const filtered = q || clientId || tag || registrar || tld || sl;
  const capacity = rows.reduce((a, r) => a + r.capacity, 0);
  // Long values only appear on some tabs: "Replaced → newdomain.com", "Cooling down · until Dec 3".
  const lifeWidth = view === "replaced" || view === "cooling" || view === "all" ? 140 : WIDTH.life;
  const shown = COLUMNS.filter((c) => on(c.key)).map((c) => ({ key: c.key, width: c.key === "life" ? lifeWidth : WIDTH[c.key] }));
  const COLS = 2 + shown.length;

  const registrarFilter = (
    <select className="select rv-filter" data-on={registrar ? true : undefined} value={registrar} onChange={(e) => setRegistrar(e.target.value)} aria-label="Filter by registrar account">
      <option value="">All registrar accounts</option>
      {registrars.map((r) => r.accounts.length > 1 ? (
        <optgroup key={r.name} label={r.name}>
          <option value={`v:${r.name}`}>All {r.name} ({int(r.total)})</option>
          {r.accounts.map(([a, n]) => <option key={a} value={`a:${r.name}|${a}`}>{r.name} · {a} ({int(n)})</option>)}
        </optgroup>
      ) : (
        <option key={r.name} value={r.accounts.length === 1 ? `a:${r.name}|${r.accounts[0][0]}` : `v:${r.name}`}>
          {r.name === "Unknown" ? "No registrar account" : r.name}{r.accounts.length === 1 ? ` · ${r.accounts[0][0]}` : ""} ({int(r.total)})
        </option>
      ))}
    </select>
  );
  const tldFilter = (
    <select className="select rv-filter" data-on={tld ? true : undefined} value={tld} onChange={(e) => setTld(e.target.value)} aria-label="Filter by TLD">
      <option value="">All TLDs</option>
      {tlds.map(([t, n]) => <option key={t} value={t}>.{t} ({int(n)})</option>)}
    </select>
  );

  return (
    <>
      <div className="flex flex-col gap-3">
        <div className="inv-bar">
        <div className="table-bar">
          <div className="view-tabs" role="tablist" aria-label="Lifecycle">
            {([...LIFE_TABS, "all"] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={view === k} className={view === k ? "is-on" : undefined} onClick={() => { setView(k); scrollRef.current?.scrollTo({ top: 0 }); }}>
                {k === "all" ? "All" : k === "setup" ? "Warming & setup" : LIFE[k].label} <span>{int(counts[k] ?? 0)}</span>
              </button>
            ))}
          </div>
          <span className="spacer-auto" />
          <label className="search-input">
            <Search size={14} strokeWidth={1.5} />
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search inventory" />
          </label>
          <PasteSelect rows={domains} selected={selected} where="in your domains"
            onSelect={(s) => { setSelected(s); if ([...s].some((id) => !rows.some((r) => r.id === id))) { setView("all"); setQ(""); } }} />
          <button type="button" className="btn btn-sm" onClick={exportCsv}><Download size={14} /> Export</button>
          <ColumnsMenu cols={cols} />
        </div>
        <div className="table-bar">
          <select className="select rv-filter" data-on={clientId ? true : undefined} value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Filter by client">
            <option value="">All clients</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {allTags.length ? (
            <select className="select rv-filter" data-on={tag ? true : undefined} value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Filter by tag">
              <option value="">All tags</option>
              {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          ) : null}
          {registrars.length > 1 || registrars.some((r) => r.accounts.length > 1) ? registrarFilter : null}
          {tlds.length > 1 ? tldFilter : null}
          <select className="select rv-filter" data-on={sl ? true : undefined} value={sl} onChange={(e) => setSl(e.target.value as SlState | "")} aria-label="Filter by Smartlead status"
            title="Connected, disconnected or deleted in Smartlead now, as of the last Smartlead sync">
            <option value="">Any Smartlead status</option>
            {SL_ORDER.map((k) => <option key={k} value={k}>{SL_META[k].label} ({int(slCounts.get(k) ?? 0)})</option>)}
          </select>
          {filtered ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setQ(""); setClientId(""); setTag(""); setRegistrar(""); setTld(""); setSl(""); }}>Clear</button> : null}
        </div>
        </div>

        <div className="table-wrap">
          <div ref={scrollRef} className="table-scroll" style={{ maxHeight: "calc(100dvh - 240px)", minHeight: 280 }}>
            <table className="data-table is-main is-fixed" aria-rowcount={rows.length}
              style={{ minWidth: CHECK_WIDTH + DOMAIN_MIN + shown.reduce((a, c) => a + c.width, 0) }}>
              <colgroup>
                <col style={{ width: CHECK_WIDTH }} />
                <col />
                {shown.map((c) => <col key={c.key} style={{ width: c.width }} />)}
              </colgroup>
              <thead>
                <tr>
                  <th className="col-check">
                    <input type="checkbox" className="checkbox" aria-label="Select all shown" checked={allShown}
                      ref={(el) => { if (el) el.indeterminate = !allShown && someShown; }}
                      onChange={() => setSelected((s) => { const n = new Set(s); rows.forEach((r) => (allShown ? n.delete(r.id) : n.add(r.id))); return n; })} />
                  </th>
                  <Th k="name" first>Domain</Th>
                  {on("life") ? <Th k="life">Lifecycle</Th> : null}
                  {on("sl") ? <Th k="sl">Smartlead</Th> : null}
                  {on("client") ? <Th k="client">Client</Th> : null}
                  {on("registrar") ? <Th k="registrar">Registrar</Th> : null}
                  {on("ns") ? <Th k="ns">Nameservers</Th> : null}
                  {on("ht") ? <Th k="ht">Hypertide</Th> : null}
                  {on("icemail") ? <Th k="icemailMonthly">Icemail</Th> : null}
                  {on("inboxes") ? <Th k="inboxCount" num>Inboxes</Th> : null}
                  {on("capacity") ? <Th k="capacity" num>Per day</Th> : null}
                  {on("age") ? <Th k="age" num title="Days since the domain went active">Active</Th> : null}
                  {on("domainAge") ? <Th k="domainAge" num title="Days since the domain was bought">Age</Th> : null}
                  {on("bought") ? <Th k="purchasedAt" num>Bought</Th> : null}
                  {on("renews") ? <Th k="expiresAt" num>{view === "expired" ? "Expired on" : "Renews"}</Th> : null}
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
                        <span className="inv-name">
                          <DomainLink id={d.id} className="strong hover:underline" title={d.name}>{d.name}</DomainLink>
                          {d.tags.length ? <span className="inv-tags" title={d.tags.join(", ")}><TagList tags={d.tags} graceDaysLeft={d.graceDaysLeft} /></span> : null}
                        </span>
                      </td>
                      {on("life") ? (
                      <td>
                        <span className="inv-line">
                          <span className={`status-dot tone-${life.tone}`}
                            title={d.coolingUntil ? `Last used ${shortDate(d.lastUsedOn)}; free to reuse from ${shortDate(d.coolingUntil)}` : d.status === "in_storage" && d.lastUsedOn ? `Used before, last on ${shortDate(d.lastUsedOn)}` : undefined}>
                            {d.status === "warming" ? "Warming" : life.label}{d.coolingUntil ? <span className="text-muted"> · until {shortDate(d.coolingUntil)}</span> : null}
                          </span>
                          {d.replacedById ? (
                            <DomainLink id={d.replacedById} className="flex items-center gap-1 truncate text-muted hover:text-ink" title={`Replaced by ${d.replacedByName} on ${shortDate(d.replacedAt)}`}>
                              <ArrowRight size={12} />{d.replacedByName}
                            </DomainLink>
                          ) : null}
                        </span>
                      </td>
                      ) : null}
                      {on("sl") ? (
                      <td><SlBadge c={d} short /></td>
                      ) : null}
                      {on("client") ? (
                      <td><ClientCell name={d.clientName} hue={d.clientHue} /></td>
                      ) : null}
                      {on("registrar") ? (
                      <td title={d.registrar ? [d.registrar, d.registrarAccount].filter(Boolean).join(" · ") : undefined}>
                        <span className="inv-line">
                        <span className="inv-cut" title={d.registrar ? `${d.registrar}${d.registrarAccount ? ` · ${d.registrarAccount}` : ""}` : undefined}>
                        {d.registrar?.replace(/ Domains$/, "") ?? <span className="zero">—</span>}
                        {d.registrarAccount ? <span className="text-muted"> · {d.registrarAccount}</span> : null}
                        </span>
                        {d.registrar === "Porkbun" && d.apiAccess === false ? (
                          <span className="badge tone-warning" title="API access is off for this domain at Porkbun, so the app can read but not change its nameservers. Turn it on in Porkbun → Domain → Details → API Access.">API off</span>
                        ) : null}
                        </span>
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
                      {on("icemail") ? (
                      <td>
                        {d.icemailMailboxes ? (
                          <span className="inv-line" title={d.icemailNextBill ? `Next bill ${shortDate(d.icemailNextBill)}` : undefined}>
                            <span className="inv-cut text-muted">{int(d.icemailMailboxes)} · {usd(d.icemailMonthly ?? 0)}/mo</span>
                            {d.icemailIssue ? <Badge tone="danger">{d.icemailIssue}</Badge> : null}
                          </span>
                        ) : d.icemailIssue ? <Badge tone="danger">{d.icemailIssue}</Badge> : <span className="zero">—</span>}
                      </td>
                      ) : null}
                      {on("inboxes") ? (
                      <td className="is-num">{d.inboxCount ? int(d.inboxCount) : <span className="zero">0</span>}</td>
                      ) : null}
                      {on("capacity") ? (
                      <td className="is-num">{d.capacity ? int(d.capacity) : <span className="zero">0</span>}</td>
                      ) : null}
                      {on("age") ? (
                      <td className="is-num text-muted">{d.activeSince && d.status !== "in_storage" && d.status !== "warming" ? `${daysSince(d.activeSince)}d` : <span className="zero">—</span>}</td>
                      ) : null}
                      {on("domainAge") ? (
                      <td className="is-num text-muted" title={d.bornAt ? `Bought ${shortDate(d.bornAt)}` : "Purchase date not known"}>{d.bornAt ? `${int(daysSince(d.bornAt))}d` : <span className="zero">—</span>}</td>
                      ) : null}
                      {on("bought") ? (
                      <td className="is-num text-muted">{d.purchasedAt ? fixedDate(d.purchasedAt) : <span className="zero">—</span>}</td>
                      ) : null}
                      {on("renews") ? (
                      <td className={`is-num ${d.expired && /redemption/i.test(d.registrarStatus ?? "") ? "text-warning-ink" : "text-muted"}`} title={d.expired && d.registrarStatus ? `The registrar says: ${d.registrarStatus}` : undefined}>{d.expiresAt ? fixedDate(d.expiresAt) : <span className="zero">—</span>}</td>
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
          <ConfigureDomains domainIds={[...selected]} />
          <WarmingButtons rows={selectedRows} onDone={() => setSelected(new Set())} />
          <button type="button" className="btn btn-sm" onClick={() => setSetupOpen(true)}><Tag size={14} /> Set up</button>
          <button type="button" className="btn btn-sm" disabled={!selectedRows.some(replaceable)} title="Swap the selected active or warming domains for free ones" onClick={() => setReplaceOpen(true)}><ArrowLeftRight size={14} /> Replace</button>
              <button type="button" className="btn btn-sm" disabled={!selectedRows.some((d) => lifeOf(d) !== "replaced")} onClick={() => setMoveTo("replaced")}><Archive size={14} /> Mark as replaced</button>
              <button type="button" className="btn btn-sm" disabled={!selectedRows.some((d) => lifeOf(d) !== "recovery")} onClick={() => setMoveTo("recovery")}><LifeBuoy size={14} /> Move to recovery</button>
              <button type="button" className="btn btn-sm" onClick={() => setStatusOpen(true)}><CircleDot size={14} /> Status</button>
          <button type="button" className="btn btn-sm" onClick={exportCsv}><Download size={14} /> Export</button>
          <span className="sep" />
          <button type="button" className="btn btn-sm" aria-label="Clear selection" onClick={() => setSelected(new Set())}><X size={14} /></button>
        </div>
      ) : null}

      <MarkReplacedDialog to={moveTo ?? "replaced"} open={moveTo !== null} onOpenChange={(o) => { if (!o) setMoveTo(null); }}
        targets={selectedRows.filter((d) => lifeOf(d) !== moveTo).map((d) => ({ id: d.id, name: d.name }))}
        onDone={() => setSelected(new Set())} />
      <ReplaceDialog
        open={replaceOpen}
        onOpenChange={setReplaceOpen}
        targets={selectedRows.filter(replaceable).map((d) => ({ id: d.id, name: d.name, tld: d.tld, clientName: d.clientName, clientHue: d.clientHue }))}
        onDone={() => setSelected(new Set())}
      />
      <ChangeStatusDialog
        open={statusOpen}
        onOpenChange={setStatusOpen}
        targets={selectedRows.map((d) => ({ id: d.id, status: d.status }))}
        onDone={() => setSelected(new Set())}
      />
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
