"use client";

import { ArrowDown, ArrowUp, Ban, Copy, Download, Globe, RefreshCw, Search, Tag, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { markDomainsUsed, recheckNameservers } from "@/app/actions";
import { DomainLink } from "@/components/domains/DomainLink";
import { PasteSelect } from "@/components/domains/DomainBulk";
import { SetupDialog } from "@/components/domains/SetupDialog";
import { ColResizer, copyDomains, keepTextUnselected, useColumnWidths, useRangeSelect } from "@/components/table-tools";
import { Empty } from "@/components/ui";
import { ageLabel, ago, daysSince, fixedDate, int } from "@/lib/format";
import { nsOf } from "@/lib/lifecycle";
import { useSticky } from "@/lib/sticky";
import { isReplacementTld, REPLACEMENT_TLDS } from "@/lib/tlds";
import type { ClientRow, DomainRow } from "@/lib/queries";
import { Select } from "@/components/Select";

// Domains bought and never touched, laid out for picking which to use next:
// narrow them by TLD, see where each one's nameservers stand and when it renews.

type NsState = "default" | "none" | "unchecked";
const NS_LABEL: Record<NsState, string> = { default: "On default nameservers", none: "No nameservers", unchecked: "Not checked yet" };
const nsState = (d: DomainRow): NsState => (d.nameservers.length ? "default" : d.nameserversCheckedAt ? "none" : "unchecked");

const RENEW_SOON_DAYS = 60;
const renewsIn = (d: DomainRow) => (d.expiresAt ? Math.ceil((new Date(d.expiresAt).getTime() - Date.now()) / 86_400_000) : null);
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

// "Over 3 months" and so on: the minimum age in days.
const AGE_FILTERS: [string, string][] = [["", "Any age"], ["30", "Over 1 month"], ["90", "Over 3 months"], ["180", "Over 6 months"], ["365", "Over 1 year"], ["730", "Over 2 years"]];

type SortKey = "name" | "tld" | "registrar" | "account" | "ns" | "checked" | "age" | "bought" | "renews" | "cost";
const sortValue = (d: DomainRow, k: SortKey): string | number | null => {
  const time = (v: Date | null) => (v ? new Date(v).getTime() : null);
  switch (k) {
    case "name": return d.name;
    case "tld": return d.tld;
    case "registrar": return d.registrar?.toLowerCase() ?? null;
    case "account": return d.registrarAccount?.toLowerCase() ?? null;
    case "ns": return nsState(d);
    case "checked": return time(d.nameserversCheckedAt);
    case "age": { const t = time(d.bornAt); return t === null ? null : -t; }
    case "bought": return time(d.purchasedAt);
    case "renews": return time(d.expiresAt);
    case "cost": return d.costCents;
  }
};

// What decides a pick sits next to the name: its age, where it's registered and its nameservers.
const COLUMNS: { key: SortKey; label: string; width?: number; num?: boolean; title?: string }[] = [
  { key: "name", label: "Domain" },
  { key: "age", label: "Age", width: 72, num: true, title: "How long ago the domain was bought: older domains usually send with a better reputation" },
  { key: "registrar", label: "Registrar", width: 112 },
  { key: "ns", label: "Nameservers", width: 168 },
  { key: "tld", label: "TLD", width: 64 },
  { key: "account", label: "Account", width: 132 },
  { key: "checked", label: "Checked", width: 92, title: "When the nameservers were last looked up" },
  { key: "bought", label: "Bought", width: 104, num: true },
  { key: "renews", label: "Renews", width: 104, num: true },
  { key: "cost", label: "A year", width: 72, num: true },
];

// Each column's usual width; Domain takes what's left until you size it.
const DEFAULT_WIDTHS: Record<string, number> = Object.fromEntries(COLUMNS.filter((c) => c.width).map((c) => [c.key, c.width as number]));
const tableStyle = (custom: Record<string, number>, nameMin: number) => {
  const total = 40 + (custom.name ?? nameMin) + COLUMNS.reduce((a, c) => a + (c.key === "name" ? 0 : custom[c.key] ?? c.width ?? 0), 0);
  return custom.name ? { width: total, minWidth: total } : { minWidth: total };
};

export function FreeDomainsView({ domains: all, clients, used, pointed }: { domains: DomainRow[]; clients: ClientRow[]; used: number; pointed: number }) {
  const params = useSearchParams();
  // Only the endings used for replacements, unless you ask to see the rest.
  const [showOther, setShowOther] = useSticky("free:other-tlds", false);
  const otherCount = useMemo(() => all.filter((d) => !isReplacementTld(d.tld)).length, [all]);
  const domains = useMemo(() => (showOther ? all : all.filter((d) => isReplacementTld(d.tld))), [all, showOther]);
  const router = useRouter();
  // Filters stay while you move between tabs and pages; Clear resets them. ?tld= links win.
  // Oldest first: an older domain usually carries a better sending reputation.
  const [tldList, setTldList] = useSticky("free:tlds", "", params.get("tld"));
  const tlds = useMemo(() => new Set(tldList.split(",").filter(Boolean)), [tldList]);
  const setTlds = (next: Set<string>) => setTldList([...next].join(","));
  const [q, setQ] = useSticky("free:q", "");
  const [registrar, setRegistrar] = useSticky("free:registrar", "");
  const [ns, setNs] = useSticky<NsState | "">("free:ns", "");
  const [minAge, setMinAge] = useSticky("free:min-age", "");
  const [sort, setSort] = useSticky<{ key: SortKey; dir: 1 | -1 }>("free:sort", { key: "age", dir: -1 });
  const widths = useColumnWidths("free-domains", DEFAULT_WIDTHS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [setupOpen, setSetupOpen] = useState(false);
  const [checking, startCheck] = useTransition();
  // Follows a lookup only while one is running: refreshing all the time can swallow a click.
  const [watching, setWatching] = useState(false);
  const following = watching && domains.some((d) => !d.nameserversCheckedAt);
  useEffect(() => {
    if (!following) return;
    const started = Date.now();
    const id = setInterval(() => {
      if (Date.now() - started > 5 * 60_000) setWatching(false);
      else if (document.visibilityState === "visible") router.refresh();
    }, 5000);
    return () => clearInterval(id);
  }, [following, router]);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (tlds.size) p.set("tld", [...tlds].join(",")); else p.delete("tld");
    const s = p.toString();
    window.history.replaceState(null, "", s ? `?${s}` : window.location.pathname);
  }, [tlds]);

  const accountKey = (d: DomainRow) => `${d.registrar ?? "No registrar"}${d.registrarAccount ? ` · ${d.registrarAccount}` : ""}`;
  const accounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const d of domains) c.set(accountKey(d), (c.get(accountKey(d)) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [domains]);

  // Every filter but the TLDs, so each chip says what picking it would add.
  const beforeTld = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const min = Number(minAge) || 0;
    return domains.filter((d) => (!registrar || accountKey(d) === registrar) && (!ns || nsState(d) === ns) && (!needle || d.name.includes(needle))
      && (!min || (d.bornAt !== null && (daysSince(d.bornAt) ?? 0) >= min)));
  }, [domains, registrar, ns, q, minAge]);
  const tldCounts = useMemo(() => {
    const c = new Map<string, number>(domains.map((d) => [d.tld ?? "?", 0]));
    for (const d of beforeTld) c.set(d.tld ?? "?", (c.get(d.tld ?? "?") ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [domains, beforeTld]);

  const rows = useMemo(() => beforeTld
    .filter((d) => !tlds.size || tlds.has(d.tld ?? "?"))
    .sort((a, b) => {
      const x = sortValue(a, sort.key), y = sortValue(b, sort.key);
      if (x === y) return a.name.localeCompare(b.name);
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * sort.dir;
    }), [beforeTld, tlds, sort]);

  const counts = useMemo(() => {
    const c = { default: 0, none: 0, unchecked: 0, soon: 0 };
    for (const d of rows) {
      c[nsState(d)]++;
      const days = renewsIn(d);
      if (days !== null && days <= RENEW_SOON_DAYS) c.soon++;
    }
    return c;
  }, [rows]);

  const selectedRows = useMemo(() => domains.filter((d) => selected.has(d.id)), [domains, selected]);
  const allShown = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someShown = rows.some((r) => selected.has(r.id));
  const rowIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const pick = useRangeSelect(rowIds, setSelected);
  const toggleTld = (t: string) => { const n = new Set(tlds); if (n.has(t)) n.delete(t); else n.add(t); setTlds(n); };
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }));
  const filtered = q || registrar || ns || minAge || tlds.size > 0;

  const check = (list: DomainRow[]) => startCheck(async () => {
    const r = await recheckNameservers(list.map((d) => d.id));
    if (r.ok) {
      toast.success(`Looking up ${int(r.data.queued)} domain${r.data.queued === 1 ? "" : "s"}. This page updates as the answers come in.`);
      router.refresh();
      setWatching(true);
    } else toast.error(r.error);
  });

  // Used somewhere the app can't see: out of Free domains, with an Undo.
  const markUsed = (list: DomainRow[]) => startCheck(async () => {
    const ids = list.map((d) => d.id);
    const r = await markDomainsUsed({ ids });
    if (!r.ok) { toast.error(r.error); return; }
    setSelected(new Set());
    router.refresh();
    toast.success(`Marked ${int(r.data.changed)} domain${r.data.changed === 1 ? "" : "s"} as used`, {
      description: "They're out of Free domains and won't be offered for replacements until the reuse cool-down ends.",
      duration: 10_000,
      action: {
        label: "Undo",
        onClick: () => { void markDomainsUsed({ ids, undo: true }).then((u) => { if (u.ok) router.refresh(); else toast.error(u.error); }); },
      },
    });
  });

  const exportCsv = () => {
    const list = selectedRows.length ? selectedRows : rows;
    const head = ["domain", "tld", "registrar", "account", "nameservers", "nameserver_status", "last_checked", "bought", "renews", "cost_per_year"];
    const esc = (v: unknown) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const day = (v: Date | null) => (v ? new Date(v).toISOString().slice(0, 10) : "");
    const lines = list.map((d) => [d.name, d.tld, d.registrar, d.registrarAccount, d.nameservers.join(" "), NS_LABEL[nsState(d)], day(d.nameserversCheckedAt), day(d.purchasedAt), day(d.expiresAt), d.costCents == null ? "" : (d.costCents / 100).toFixed(2)].map(esc).join(","));
    const url = URL.createObjectURL(new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" }));
    Object.assign(document.createElement("a"), { href: url, download: `free-domains-${new Date().toISOString().slice(0, 10)}.csv` }).click();
    URL.revokeObjectURL(url);
  };

  const notSure = counts.none + counts.unchecked;
  const checkList = selectedRows.length ? selectedRows : rows;

  return (
    <>
      <section className="stats" aria-label="Free domains">
        <div className="stat">
          <span className="stat-label">Free domains</span>
          <span className="stat-value">{int(rows.length)}</span>
          <span className="stat-foot">{filtered ? `of ${int(domains.length)} free` : `across ${int(tldCounts.length)} TLD${tldCounts.length === 1 ? "" : "s"}`}</span>
        </div>
        <div className="stat">
          <span className="stat-label">On default nameservers</span>
          <span className="stat-value">{int(counts.default)}</span>
          <span className="stat-foot">as the registrar left them</span>
        </div>
        <div className="stat">
          <span className="stat-label">No nameservers found</span>
          <span className="stat-value">{int(notSure)}</span>
          <span className="stat-foot">{counts.unchecked ? `${int(counts.unchecked)} not checked yet` : "DNS, registry and registrar all checked"}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Renew within {RENEW_SOON_DAYS} days</span>
          <span className={`stat-value${counts.soon ? " text-warning-ink" : ""}`}>{int(counts.soon)}</span>
          <span className="stat-foot">use them or let them lapse</span>
        </div>
      </section>

      <div className="flex flex-col gap-3">
        <div className="free-bar">
          <div className="tld-chips" role="group" aria-label="Filter by TLD">
            <button type="button" className="tld-chip" aria-pressed={tlds.size === 0} onClick={() => setTlds(new Set())}>All TLDs</button>
            {tldCounts.map(([t, n]) => (
              <button key={t} type="button" className="tld-chip" aria-pressed={tlds.has(t)} onClick={() => toggleTld(t)}>
                .{t} <span>{int(n)}</span>
              </button>
            ))}
            {otherCount ? (
              <button type="button" className="btn btn-ghost btn-sm" aria-pressed={showOther}
                title={`Replacements use .${REPLACEMENT_TLDS.join(", .")} only`} onClick={() => { setShowOther(!showOther); if (showOther) setTlds(new Set([...tlds].filter(isReplacementTld))); }}>
                {showOther ? "Hide other endings" : `${int(otherCount)} on other endings hidden · Show`}
              </button>
            ) : null}
          </div>
          <div className="table-bar">
            <label className="search-input">
              <Search size={14} strokeWidth={1.5} />
              <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search free domains" />
            </label>
            {accounts.length > 1 ? (
              <Select className="select rv-filter" data-on={registrar ? true : undefined} value={registrar} onChange={(e) => setRegistrar(e.target.value)} aria-label="Filter by registrar account">
                <option value="">All registrar accounts</option>
                {accounts.map(([a, n]) => <option key={a} value={a}>{a} ({int(n)})</option>)}
              </Select>
            ) : null}
            <Select className="select rv-filter" data-on={ns ? true : undefined} value={ns} onChange={(e) => setNs(e.target.value as NsState | "")} aria-label="Filter by nameserver status">
              <option value="">Any nameservers</option>
              {(Object.keys(NS_LABEL) as NsState[]).map((k) => <option key={k} value={k}>{NS_LABEL[k]}</option>)}
            </Select>
            <Select className="select rv-filter" data-on={minAge ? true : undefined} value={minAge} onChange={(e) => setMinAge(e.target.value)} aria-label="Filter by age">
              {AGE_FILTERS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </Select>
            {filtered ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setQ(""); setRegistrar(""); setNs(""); setMinAge(""); setTlds(new Set()); }}>Clear</button> : null}
            {widths.customized ? <button type="button" className="btn btn-ghost btn-sm" title="Put every column back to its usual width" onClick={widths.reset}>Reset widths</button> : null}
            <span className="spacer-auto" />
            <PasteSelect rows={domains} selected={selected} where="in your free domains" onSelect={setSelected} />
            <button type="button" className="btn btn-sm" disabled={checking || !checkList.length} title="Look up the latest nameservers from DNS, the registry and the registrar" onClick={() => check(checkList)}>
              <RefreshCw size={14} /> Check nameservers ({int(checkList.length)})
            </button>
            <button type="button" className="btn btn-sm" onClick={exportCsv}><Download size={14} /> Export</button>
          </div>
        </div>

        <div className="table-wrap">
          <div className="table-scroll" style={{ maxHeight: "calc(100dvh - 300px)", minHeight: 280 }}>
            <table className="data-table is-main is-fixed" aria-rowcount={rows.length} style={tableStyle(widths.custom, 200)}>
              <colgroup>
                <col style={{ width: 40 }} />
                {COLUMNS.map((c) => { const w = widths.custom[c.key] ?? c.width; return <col key={c.key} style={w ? { width: w } : undefined} />; })}
              </colgroup>
              <thead>
                <tr>
                  <th className="col-check">
                    <input type="checkbox" className="checkbox" aria-label="Select all shown" checked={allShown}
                      ref={(el) => { if (el) el.indeterminate = !allShown && someShown; }}
                      onChange={() => setSelected((s) => { const n = new Set(s); rows.forEach((r) => (allShown ? n.delete(r.id) : n.add(r.id))); return n; })} />
                  </th>
                  {COLUMNS.map((c) => (
                    <th key={c.key} className={c.num ? "is-num" : c.key === "name" ? "col-first" : undefined} title={c.title} aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
                      <button type="button" className="sort-head" onClick={() => sortBy(c.key)}>
                        {c.label}
                        {sort.key === c.key ? (sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : null}
                      </button>
                      <ColResizer col={c.key} label={c.label} onResize={widths.setWidth} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => {
                  const n = nsOf(d);
                  const days = renewsIn(d);
                  const isSel = selected.has(d.id);
                  const age = d.bornAt ? daysSince(d.bornAt) : null;
                  // One cell per column, laid out in COLUMNS order.
                  const cell = (k: SortKey) => {
                    switch (k) {
                      case "name": return <td className="col-first"><span className="inv-name"><DomainLink id={d.id} className="strong hover:underline" title={d.name}>{d.name}</DomainLink></span></td>;
                      case "age": return <td className="is-num" title={d.bornAt ? `${int(age)} days · bought ${fixedDate(d.bornAt)}` : "Purchase date not known"}>{age !== null ? ageLabel(age) : <span className="zero">—</span>}</td>;
                      case "registrar": return <td title={d.registrar ?? undefined}>{d.registrar?.replace(/ Domains$/, "") ?? <span className="zero">—</span>}</td>;
                      case "ns": return (
                        <td>
                          <span className="ns-cell" title={n.title}>
                            <span className={`dot tone-${n.tone}`} />
                            <span className="ns-host">{n.host ?? "—"}</span>
                            <span className={`ns-status tone-${n.tone}`}>{n.status}</span>
                          </span>
                        </td>
                      );
                      case "tld": return <td className="text-muted">{d.tld ? `.${d.tld}` : <span className="zero">—</span>}</td>;
                      case "account": return <td className="text-muted" title={d.registrarAccount ?? undefined}>{d.registrarAccount ?? <span className="zero">—</span>}</td>;
                      case "checked": return <td className="text-muted" title={d.nameserversCheckedAt ? fixedDate(d.nameserversCheckedAt) : "Not looked up yet"}>{d.nameserversCheckedAt ? ago(d.nameserversCheckedAt) : <span className="zero">—</span>}</td>;
                      case "bought": return <td className="is-num text-muted">{d.purchasedAt ? fixedDate(d.purchasedAt) : <span className="zero">—</span>}</td>;
                      case "renews": return <td className={`is-num ${days !== null && days <= RENEW_SOON_DAYS ? "text-warning-ink" : "text-muted"}`} title={days !== null ? `In ${int(days)} days` : undefined}>{d.expiresAt ? fixedDate(d.expiresAt) : <span className="zero">—</span>}</td>;
                      case "cost": return <td className="is-num text-muted">{d.costCents != null ? money(d.costCents) : <span className="zero">—</span>}</td>;
                    }
                  };
                  return (
                    <tr key={d.id} data-selected={isSel} className="is-clickable" onMouseDown={keepTextUnselected} onClick={(e) => pick(d.id, e)}>
                      <td className="col-check"><input type="checkbox" className="checkbox" checked={isSel} onChange={() => {}} aria-label={`Select ${d.name}`} tabIndex={-1} /></td>
                      {COLUMNS.map((c) => <Fragment key={c.key}>{cell(c.key)}</Fragment>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 ? (
              <Empty icon={Globe} title={filtered ? "No free domains match" : "No free domains"}>
                {filtered ? "Try another TLD or clear the filters." : "Domains you buy and haven't touched show up here."}
              </Empty>
            ) : null}
          </div>
          <div className="table-footer">
            <span><b>{int(rows.length)}</b> domain{rows.length === 1 ? "" : "s"}</span>
            {used || pointed ? (
              <span className="table-footer-hint hidden md:inline-flex">
                <span>
                  Not counted: {[used ? `${int(used)} used before` : null, pointed ? `${int(pointed)} on other nameservers` : null].filter(Boolean).join(", ")}.{" "}
                  <Link href="/inventory?view=free" className="underline" onClick={(e) => e.stopPropagation()}>See them in storage</Link>
                </span>
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {selected.size > 0 ? (
        <div className="bulk-bar" role="toolbar" aria-label="Selected domains">
          <span className="bulk-count">{selected.size} selected</span>
          <button type="button" className="btn btn-sm" onClick={() => setSetupOpen(true)}><Tag size={14} /> Set up</button>
          <button type="button" className="btn btn-sm" disabled={checking} onClick={() => check(selectedRows)}><RefreshCw size={14} /> Check nameservers</button>
          <button type="button" className="btn btn-sm" title="Copy the selected domains, one per line" onClick={() => copyDomains(selectedRows.map((d) => d.name))}><Copy size={14} /> Copy</button>
          <button type="button" className="btn btn-sm" onClick={exportCsv}><Download size={14} /> Export</button>
          <button type="button" className="btn btn-sm" disabled={checking} title="Already used somewhere the app can't see, like an old Hypertide order: take them out of Free domains"
            onClick={() => markUsed(selectedRows)}><Ban size={14} /> Mark as used</button>
          <span className="sep" />
          <button type="button" className="btn btn-sm" aria-label="Clear selection" onClick={() => setSelected(new Set())}><X size={14} /></button>
        </div>
      ) : null}

      <SetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        targets={selectedRows.map((d) => ({ id: d.id, name: d.name, status: d.status, tags: d.tags, registrar: d.registrar }))}
        clients={clients}
        allTags={[]}
        onDone={() => setSelected(new Set())}
      />
    </>
  );
}
