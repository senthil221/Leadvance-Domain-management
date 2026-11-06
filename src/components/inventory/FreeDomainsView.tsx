"use client";

import { ArrowDown, ArrowUp, Download, Globe, RefreshCw, Search, Tag, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { recheckNameservers } from "@/app/actions";
import { DomainLink } from "@/components/domains/DomainLink";
import { PasteSelect } from "@/components/domains/DomainBulk";
import { SetupDialog } from "@/components/domains/SetupDialog";
import { Empty } from "@/components/ui";
import { ago, daysSince, fixedDate, int } from "@/lib/format";
import { nsOf } from "@/lib/lifecycle";
import type { ClientRow, DomainRow } from "@/lib/queries";

// Domains bought and never touched, laid out for picking which to use next:
// narrow them by TLD, see where each one's nameservers stand and when it renews.

type NsState = "default" | "none" | "unchecked";
const NS_LABEL: Record<NsState, string> = { default: "On default nameservers", none: "No nameservers", unchecked: "Not checked yet" };
const nsState = (d: DomainRow): NsState => (d.nameservers.length ? "default" : d.nameserversCheckedAt ? "none" : "unchecked");

const RENEW_SOON_DAYS = 60;
const renewsIn = (d: DomainRow) => (d.expiresAt ? Math.ceil((new Date(d.expiresAt).getTime() - Date.now()) / 86_400_000) : null);
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

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

const COLUMNS: { key: SortKey; label: string; width?: number; num?: boolean; title?: string }[] = [
  { key: "name", label: "Domain" },
  { key: "tld", label: "TLD", width: 72 },
  { key: "registrar", label: "Registrar", width: 112 },
  { key: "account", label: "Account", width: 132 },
  { key: "ns", label: "Nameservers", width: 168 },
  { key: "checked", label: "Checked", width: 92, title: "When the nameservers were last looked up" },
  { key: "age", label: "Age", width: 64, num: true, title: "Days since the domain was bought" },
  { key: "bought", label: "Bought", width: 104, num: true },
  { key: "renews", label: "Renews", width: 104, num: true },
  { key: "cost", label: "A year", width: 72, num: true },
];

export function FreeDomainsView({ domains, clients, used, pointed }: { domains: DomainRow[]; clients: ClientRow[]; used: number; pointed: number }) {
  const params = useSearchParams();
  const router = useRouter();
  const [tlds, setTlds] = useState<Set<string>>(() => new Set((params.get("tld") ?? "").split(",").filter(Boolean)));
  const [q, setQ] = useState("");
  const [registrar, setRegistrar] = useState("");
  const [ns, setNs] = useState<NsState | "">("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
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
    return domains.filter((d) => (!registrar || accountKey(d) === registrar) && (!ns || nsState(d) === ns) && (!needle || d.name.includes(needle)));
  }, [domains, registrar, ns, q]);
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
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleTld = (t: string) => setTlds((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }));
  const filtered = q || registrar || ns || tlds.size > 0;

  const check = (list: DomainRow[]) => startCheck(async () => {
    const r = await recheckNameservers(list.map((d) => d.id));
    if (r.ok) {
      toast.success(`Looking up ${int(r.data.queued)} domain${r.data.queued === 1 ? "" : "s"}. This page updates as the answers come in.`);
      router.refresh();
      setWatching(true);
    } else toast.error(r.error);
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
          </div>
          <div className="table-bar">
            <label className="search-input">
              <Search size={14} strokeWidth={1.5} />
              <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search free domains" />
            </label>
            {accounts.length > 1 ? (
              <select className="select rv-filter" data-on={registrar ? true : undefined} value={registrar} onChange={(e) => setRegistrar(e.target.value)} aria-label="Filter by registrar account">
                <option value="">All registrar accounts</option>
                {accounts.map(([a, n]) => <option key={a} value={a}>{a} ({int(n)})</option>)}
              </select>
            ) : null}
            <select className="select rv-filter" data-on={ns ? true : undefined} value={ns} onChange={(e) => setNs(e.target.value as NsState | "")} aria-label="Filter by nameserver status">
              <option value="">Any nameservers</option>
              {(Object.keys(NS_LABEL) as NsState[]).map((k) => <option key={k} value={k}>{NS_LABEL[k]}</option>)}
            </select>
            {filtered ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setQ(""); setRegistrar(""); setNs(""); setTlds(new Set()); }}>Clear</button> : null}
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
            <table className="data-table is-main is-fixed" aria-rowcount={rows.length} style={{ minWidth: 40 + 200 + COLUMNS.reduce((a, c) => a + (c.width ?? 0), 0) }}>
              <colgroup>
                <col style={{ width: 40 }} />
                {COLUMNS.map((c) => <col key={c.key} style={c.width ? { width: c.width } : undefined} />)}
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
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => {
                  const n = nsOf(d);
                  const days = renewsIn(d);
                  const isSel = selected.has(d.id);
                  return (
                    <tr key={d.id} data-selected={isSel} className="is-clickable" onClick={() => toggle(d.id)}>
                      <td className="col-check"><input type="checkbox" className="checkbox" checked={isSel} onChange={() => {}} aria-label={`Select ${d.name}`} tabIndex={-1} /></td>
                      <td className="col-first"><span className="inv-name"><DomainLink id={d.id} className="strong hover:underline" title={d.name}>{d.name}</DomainLink></span></td>
                      <td className="text-muted">{d.tld ? `.${d.tld}` : <span className="zero">—</span>}</td>
                      <td title={d.registrar ?? undefined}>{d.registrar?.replace(/ Domains$/, "") ?? <span className="zero">—</span>}</td>
                      <td className="text-muted" title={d.registrarAccount ?? undefined}>{d.registrarAccount ?? <span className="zero">—</span>}</td>
                      <td>
                        <span className="ns-cell" title={n.title}>
                          <span className={`dot tone-${n.tone}`} />
                          <span className="ns-host">{n.host ?? "—"}</span>
                          <span className={`ns-status tone-${n.tone}`}>{n.status}</span>
                        </span>
                      </td>
                      <td className="text-muted" title={d.nameserversCheckedAt ? fixedDate(d.nameserversCheckedAt) : "Not looked up yet"}>{d.nameserversCheckedAt ? ago(d.nameserversCheckedAt) : <span className="zero">—</span>}</td>
                      <td className="is-num text-muted" title={d.bornAt ? `Bought ${fixedDate(d.bornAt)}` : "Purchase date not known"}>{d.bornAt ? `${int(daysSince(d.bornAt))}d` : <span className="zero">—</span>}</td>
                      <td className="is-num text-muted">{d.purchasedAt ? fixedDate(d.purchasedAt) : <span className="zero">—</span>}</td>
                      <td className={`is-num ${days !== null && days <= RENEW_SOON_DAYS ? "text-warning-ink" : "text-muted"}`} title={days !== null ? `In ${int(days)} days` : undefined}>{d.expiresAt ? fixedDate(d.expiresAt) : <span className="zero">—</span>}</td>
                      <td className="is-num text-muted">{d.costCents != null ? money(d.costCents) : <span className="zero">—</span>}</td>
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
          <button type="button" className="btn btn-sm" onClick={exportCsv}><Download size={14} /> Export</button>
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
