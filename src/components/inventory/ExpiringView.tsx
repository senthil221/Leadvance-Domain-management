"use client";

import { ArrowDown, ArrowRight, ArrowUp, ArrowLeftRight, CalendarCheck, Copy, Download, Search, X } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { DomainLink } from "@/components/domains/DomainLink";
import { PasteSelect } from "@/components/domains/DomainBulk";
import { ReplaceDialog } from "@/components/domains/ReplaceDialog";
import { ColResizer, copyDomains, keepTextUnselected, useColumnWidths, useRangeSelect } from "@/components/table-tools";
import { Badge, ClientCell, Dot, Empty } from "@/components/ui";
import { fixedDate, int } from "@/lib/format";
import { EXPIRY_WINDOWS, autoRenewOf, expiryLabel, expiryTone, isWithin, needsAction } from "@/lib/expiring";
import { htOf } from "@/lib/lifecycle";
import { useSticky } from "@/lib/sticky";
import type { DomainRow } from "@/lib/queries";
import { canReplace } from "@/lib/status";
import { Select } from "@/components/Select";

// What's running out among the domains in use: how long is left, whether the
// registrar will renew it, what's riding on it, and whether a swap has started.

// "expired" lists only the ones already past their date; every window includes them too.
type Window = (typeof EXPIRY_WINDOWS)[number] | "none" | "expired";
const USE: Partial<Record<DomainRow["status"], { label: string; tone: "success" | "info" }>> = {
  active: { label: "Active", tone: "success" },
  warming: { label: "Warming", tone: "info" },
  provisioning: { label: "In setup", tone: "info" },
};
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const vendorText = (d: DomainRow) => htOf(d) ? `Hypertide · ${htOf(d)?.label}` : d.icemailMailboxes ? `Icemail · ${int(d.icemailMailboxes)}` : null;
const isExpired = (d: DomainRow) => d.daysToExpiry !== null && d.daysToExpiry < 0;
const accountKey = (d: DomainRow) => `${d.registrar ?? "No registrar"}${d.registrarAccount ? ` · ${d.registrarAccount}` : ""}`;

type SortKey = "name" | "expires" | "renew" | "use" | "client" | "inboxes" | "capacity" | "vendor" | "replacement" | "registrar" | "account" | "cost";
const sortValue = (d: DomainRow, k: SortKey): string | number | null => {
  switch (k) {
    case "name": return d.name;
    case "expires": return d.daysToExpiry;
    case "renew": return d.autoRenew === null ? 1 : d.autoRenew ? 2 : 0;
    case "use": return d.status;
    case "client": return d.clientName?.toLowerCase() ?? null;
    case "inboxes": return d.inboxCount;
    case "capacity": return d.capacity;
    case "vendor": return vendorText(d);
    case "replacement": return d.replacedByName;
    case "registrar": return d.registrar?.toLowerCase() ?? null;
    case "account": return d.registrarAccount?.toLowerCase() ?? null;
    case "cost": return d.costCents;
  }
};

const COLUMNS: { key: SortKey; label: string; width?: number; num?: boolean; title?: string }[] = [
  { key: "name", label: "Domain" },
  { key: "expires", label: "Expires", width: 204, title: "The date at the registrar and how long is left" },
  { key: "renew", label: "Auto-renew", width: 96 },
  { key: "use", label: "In use", width: 88 },
  { key: "client", label: "Client", width: 104 },
  { key: "inboxes", label: "Inboxes", width: 68, num: true },
  { key: "capacity", label: "Per day", width: 62, num: true, title: "What its connected inboxes can send a day" },
  { key: "vendor", label: "Email vendor", width: 112 },
  { key: "replacement", label: "Replacement", width: 108 },
  { key: "registrar", label: "Registrar", width: 88 },
  { key: "account", label: "Account", width: 92 },
  { key: "cost", label: "A year", width: 62, num: true },
];

// Each column's usual width; Domain takes what's left until you size it.
const DEFAULT_WIDTHS: Record<string, number> = Object.fromEntries(COLUMNS.filter((c) => c.width).map((c) => [c.key, c.width as number]));
const tableStyle = (custom: Record<string, number>, nameMin: number) => {
  const total = 40 + (custom.name ?? nameMin) + COLUMNS.reduce((a, c) => a + (c.key === "name" ? 0 : custom[c.key] ?? c.width ?? 0), 0);
  return custom.name ? { width: total, minWidth: total } : { minWidth: total };
};

export function ExpiringView({ domains, free }: { domains: DomainRow[]; free: number }) {
  // Filters stay while you move between tabs and pages; Clear resets them.
  const [within, setWithin] = useSticky<Window>("expiring:within", 30);
  const [q, setQ] = useSticky("expiring:q", "");
  const [client, setClient] = useSticky("expiring:client", "");
  const [account, setAccount] = useSticky("expiring:account", "");
  const [renew, setRenew] = useSticky<"" | "action" | "on">("expiring:renew", "");
  const [sort, setSort] = useSticky<{ key: SortKey; dir: 1 | -1 }>("expiring:sort", { key: "expires", dir: 1 });
  const widths = useColumnWidths("expiring", DEFAULT_WIDTHS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [replaceOpen, setReplaceOpen] = useState(false);

  const clients = useMemo(() => [...new Set(domains.map((d) => d.clientName).filter((c): c is string => !!c))].sort(), [domains]);
  const accounts = useMemo(() => [...new Set(domains.map(accountKey))].sort(), [domains]);

  // Every filter but the window, so each button says how many it would show.
  const filteredRows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return domains.filter((d) => (!client || d.clientName === client) && (!account || accountKey(d) === account)
      && (!renew || (renew === "on" ? d.autoRenew === true : needsAction(d))) && (!needle || d.name.includes(needle)));
  }, [domains, client, account, renew, q]);

  const rows = useMemo(() => filteredRows
    .filter((d) => (within === "none" ? d.daysToExpiry === null : within === "expired" ? isExpired(d) : isWithin(d, within)))
    .sort((a, b) => {
      const x = sortValue(a, sort.key), y = sortValue(b, sort.key);
      if (x === y) return a.name.localeCompare(b.name);
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * sort.dir;
    }), [filteredRows, within, sort]);

  const noDate = filteredRows.filter((d) => d.daysToExpiry === null).length;
  const expiredCount = filteredRows.filter(isExpired).length;
  const stats = useMemo(() => {
    const dated = rows.filter((d) => d.daysToExpiry !== null);
    const expired = dated.filter((d) => (d.daysToExpiry as number) < 0);
    return {
      // The first number is what's listed: with no date, that's all of them.
      upcoming: within === "expired" ? rows.length : rows.length - expired.length,
      expired: expired.length,
      action: dated.filter(needsAction).length,
      inboxes: rows.reduce((a, d) => a + d.inboxCount, 0),
      capacity: rows.reduce((a, d) => a + d.capacity, 0),
      replacing: rows.filter((d) => d.replacedById).length,
      cost: rows.reduce((a, d) => a + (d.costCents ?? 0), 0),
    };
  }, [rows, within]);

  const selectedRows = useMemo(() => domains.filter((d) => selected.has(d.id)), [domains, selected]);
  const replaceable = selectedRows.filter((d) => canReplace(d.status, d.beingReplaced));
  const allShown = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someShown = rows.some((r) => selected.has(r.id));
  const rowIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const pick = useRangeSelect(rowIds, setSelected);
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }));
  const filtered = !!(q || client || account || renew);
  const windowName = within === "none" ? "No renewal date" : within === "expired" ? "Expired, still in use" : `Next ${within} days`;

  const exportCsv = () => {
    const list = selectedRows.length ? selectedRows : rows;
    const head = ["domain", "expires", "days_left", "auto_renew", "status", "client", "inboxes", "per_day", "email_vendor", "replaced_by", "registrar", "account", "cost_per_year"];
    const esc = (v: unknown) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = list.map((d) => [d.name, d.expiresAt ? new Date(d.expiresAt).toISOString().slice(0, 10) : "", d.daysToExpiry, autoRenewOf(d.autoRenew).label, USE[d.status]?.label, d.clientName, d.inboxCount, d.capacity, vendorText(d), d.replacedByName, d.registrar, d.registrarAccount, d.costCents == null ? "" : (d.costCents / 100).toFixed(2)].map(esc).join(","));
    const url = URL.createObjectURL(new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" }));
    Object.assign(document.createElement("a"), { href: url, download: `expiring-domains-${new Date().toISOString().slice(0, 10)}.csv` }).click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <section className="stats" aria-label="Expiring domains">
        <div className="stat">
          <span className="stat-label"><Dot tone="warning" />{windowName}</span>
          <span className="stat-value">{int(stats.upcoming)}</span>
          <span className="stat-foot">{int(stats.inboxes)} inboxes · {int(stats.capacity)} a day</span>
        </div>
        <div className="stat">
          <span className="stat-label"><Dot tone="danger" />Already expired</span>
          <span className={`stat-value${stats.expired ? " text-danger-ink" : ""}`}>{int(stats.expired)}</span>
          <span className="stat-foot">still marked in use</span>
        </div>
        <div className="stat">
          <span className="stat-label"><Dot tone="danger" />Need you to act</span>
          <span className={`stat-value${stats.action ? " text-warning-ink" : ""}`}>{int(stats.action)}</span>
          <span className="stat-foot" title="Auto-renew off or not known, and no replacement started">won&apos;t renew on their own</span>
        </div>
        <Link href="/free-domains" className="stat">
          <span className="stat-label"><Dot tone="success" />Free domains to swap in</span>
          <span className={`stat-value${free < stats.action ? " text-warning-ink" : ""}`}>{int(free)}</span>
          <span className="stat-foot">{free < stats.action ? "fewer than need a swap" : "see them all"}</span>
        </Link>
      </section>

      <div className="flex flex-col gap-3">
        <div className="free-bar">
          <div className="tld-chips" role="group" aria-label="How far ahead to look">
            {expiredCount || within === "expired" ? (
              <button type="button" className="tld-chip is-danger" aria-pressed={within === "expired"} title="Only the domains already past their date at the registrar and still in use: select them all and replace them in one go" onClick={() => setWithin("expired")}>
                Expired <span>{int(expiredCount)}</span>
              </button>
            ) : null}
            {EXPIRY_WINDOWS.map((w) => (
              <button key={w} type="button" className="tld-chip" aria-pressed={within === w} title={`Expired, or expiring within ${w} days`} onClick={() => setWithin(w)}>
                {w} days <span>{int(filteredRows.filter((d) => isWithin(d, w)).length)}</span>
              </button>
            ))}
            {noDate ? (
              <button type="button" className="tld-chip" aria-pressed={within === "none"} title="In use, but we don't know when these expire: their registrar account isn't connected, so check them yourself" onClick={() => setWithin("none")}>
                No date <span>{int(noDate)}</span>
              </button>
            ) : null}
          </div>
          <div className="table-bar">
            <label className="search-input">
              <Search size={14} strokeWidth={1.5} />
              <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search expiring domains" />
            </label>
            {clients.length > 1 ? (
              <Select className="select rv-filter" data-on={client ? true : undefined} value={client} onChange={(e) => setClient(e.target.value)} aria-label="Filter by client">
                <option value="">All clients</option>
                {clients.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            ) : null}
            {accounts.length > 1 ? (
              <Select className="select rv-filter" data-on={account ? true : undefined} value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Filter by registrar account">
                <option value="">All registrar accounts</option>
                {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
              </Select>
            ) : null}
            <Select className="select rv-filter" data-on={renew ? true : undefined} value={renew} onChange={(e) => setRenew(e.target.value as typeof renew)} aria-label="Filter by what they need">
              <option value="">Any auto-renew</option>
              <option value="action">Need you to act</option>
              <option value="on">Auto-renew on</option>
            </Select>
            {filtered ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setQ(""); setClient(""); setAccount(""); setRenew(""); }}>Clear</button> : null}
            {widths.customized ? <button type="button" className="btn btn-ghost btn-sm" title="Put every column back to its usual width" onClick={widths.reset}>Reset widths</button> : null}
            <span className="spacer-auto" />
            <PasteSelect rows={domains} selected={selected} where="in the domains in use" onSelect={setSelected} />
            <button type="button" className="btn btn-sm" onClick={exportCsv}><Download size={14} /> Export</button>
          </div>
        </div>

        <div className="table-wrap">
          <div className="table-scroll" style={{ maxHeight: "calc(100dvh - 300px)", minHeight: 280 }}>
            <table className="data-table is-main is-fixed" aria-rowcount={rows.length} style={tableStyle(widths.custom, 176)}>
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
                  const isSel = selected.has(d.id);
                  const auto = autoRenewOf(d.autoRenew);
                  const use = USE[d.status];
                  const tone = expiryTone(d.daysToExpiry);
                  return (
                    <tr key={d.id} data-selected={isSel} className="is-clickable" onMouseDown={keepTextUnselected} onClick={(e) => pick(d.id, e)}>
                      <td className="col-check"><input type="checkbox" className="checkbox" checked={isSel} onChange={() => {}} aria-label={`Select ${d.name}`} tabIndex={-1} /></td>
                      <td className="col-first"><span className="inv-name"><DomainLink id={d.id} className="strong hover:underline" title={d.name}>{d.name}</DomainLink></span></td>
                      <td>
                        <span className="inv-line" title={d.registrarStatus ? `The registrar says: ${d.registrarStatus}` : undefined}>
                          <span className="text-muted tabular-nums">{d.expiresAt ? fixedDate(d.expiresAt) : "—"}</span>
                          {tone === "neutral" ? <span className="text-muted">{expiryLabel(d.daysToExpiry)}</span> : <Badge tone={tone}>{expiryLabel(d.daysToExpiry)}</Badge>}
                        </span>
                      </td>
                      <td title={auto.title}><span className="inv-line"><Dot tone={auto.tone} /><span className={d.autoRenew === false ? "text-danger-ink" : "text-muted"}>{auto.label}</span></span></td>
                      <td><span className="inv-line"><Dot tone={use?.tone ?? "faint"} /><span className="text-muted">{use?.label ?? d.status}</span></span></td>
                      <td><ClientCell name={d.clientName} hue={d.clientHue} /></td>
                      <td className="is-num">{d.inboxCount ? int(d.inboxCount) : <span className="zero">0</span>}</td>
                      <td className="is-num">{d.capacity ? int(d.capacity) : <span className="zero">0</span>}</td>
                      <td className="text-muted" title={vendorText(d) ?? undefined}>{vendorText(d) ?? <span className="zero">—</span>}</td>
                      <td>
                        {d.replacedById ? (
                          <DomainLink id={d.replacedById} className="flex items-center gap-1 truncate text-muted hover:text-ink" title={`Being replaced by ${d.replacedByName}`}>
                            <ArrowRight size={12} className="shrink-0" /><span className="truncate">{d.replacedByName}</span>
                          </DomainLink>
                        ) : <span className="zero">Not started</span>}
                      </td>
                      <td title={d.registrar ?? undefined}>{d.registrar?.replace(/ Domains$/, "") ?? <span className="zero">—</span>}</td>
                      <td className="text-muted" title={d.registrarAccount ?? undefined}>{d.registrarAccount ?? <span className="zero">—</span>}</td>
                      <td className="is-num text-muted">{d.costCents != null ? money(d.costCents) : <span className="zero">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 ? (
              <Empty icon={CalendarCheck} title={filtered ? "No domains match" : within === "none" ? "Every domain in use has a date" : within === "expired" ? "Nothing in use has expired" : `Nothing expires in the next ${within} days`}>
                {filtered ? "Try a longer window or clear the filters." : "Domains in use show up here as they get close."}
              </Empty>
            ) : null}
          </div>
          <div className="table-footer">
            <span><b>{int(rows.length)}</b> domain{rows.length === 1 ? "" : "s"}{stats.replacing ? ` · ${int(stats.replacing)} being replaced` : ""}</span>
            <span className="table-footer-hint hidden md:inline-flex">
              <span>{stats.cost ? `About ${money(stats.cost)} a year to keep them. ` : ""}Dates come from your registrars and refresh every 6 hours.</span>
            </span>
          </div>
        </div>
      </div>

      {selected.size > 0 ? (
        <div className="bulk-bar" role="toolbar" aria-label="Selected domains">
          <span className="bulk-count">{selected.size} selected</span>
          <button type="button" className="btn btn-sm" disabled={!replaceable.length} title="Swap the selected domains for free ones" onClick={() => setReplaceOpen(true)}><ArrowLeftRight size={14} /> Replace{replaceable.length && replaceable.length !== selected.size ? ` (${int(replaceable.length)})` : ""}</button>
          <button type="button" className="btn btn-sm" title="Copy the selected domains, one per line" onClick={() => copyDomains(selectedRows.map((d) => d.name))}><Copy size={14} /> Copy</button>
          <button type="button" className="btn btn-sm" onClick={exportCsv}><Download size={14} /> Export</button>
          <span className="sep" />
          <button type="button" className="btn btn-sm" aria-label="Clear selection" onClick={() => setSelected(new Set())}><X size={14} /></button>
        </div>
      ) : null}

      <ReplaceDialog
        open={replaceOpen}
        onOpenChange={setReplaceOpen}
        defaultReason="expiring"
        targets={replaceable.map((d) => ({ id: d.id, name: d.name, tld: d.tld, clientName: d.clientName, clientHue: d.clientHue }))}
        onDone={() => setSelected(new Set())}
      />
    </>
  );
}
