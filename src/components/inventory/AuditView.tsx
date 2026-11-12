"use client";

import { Dialog } from "radix-ui";
import { Archive, ArchiveRestore, Copy, Download, Search, ShieldCheck, X } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { archiveDomains, restoreDomains } from "@/app/actions";
import { DomainLink } from "@/components/domains/DomainLink";
import { copyDomains, keepTextUnselected, useRangeSelect } from "@/components/table-tools";
import { Badge, ClientCell, Dot, Empty, StatusDot } from "@/components/ui";
import { ISSUES, ISSUE_ORDER, auditIssues, issueText, type AuditRow, type IssueKey } from "@/lib/audit";
import { ago, fixedDate, int } from "@/lib/format";
import type { AuditAccount, AuditProgress } from "@/lib/queries";
import { useSticky } from "@/lib/sticky";

// Every domain checked against its registrar account's list and the registry:
// the ones we don't want are grouped by why, to archive; the rest are told apart
// so nothing goes unnoticed.

type Group = IssueKey | "archived";
const plural = (n: number, one: string, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;

function registryCell(d: AuditRow) {
  if (!d.registryCheckedAt) return <span className="zero">Not checked yet</span>;
  if (d.registryFound === false) return <span className="text-danger-ink">No record</span>;
  if (d.registryFound === null) return <span className="text-muted" title={d.registryError ?? undefined}>Couldn&apos;t ask</span>;
  const odd = d.registryStatus.filter((s) => !/^(client|server) (transfer|delete|update|renew) prohibited$|^active$|^ok$/.test(s));
  return (
    <span className="inv-line" title={[d.registryRegistrar, d.registryStatus.join(", ")].filter(Boolean).join(" · ")}>
      <span className="truncate">{d.registryRegistrar?.replace(/,? Inc\.?$|,? LLC$/i, "") ?? "?"}</span>
      <span className="text-muted tabular-nums">{d.registryExpiresAt ? fixedDate(d.registryExpiresAt) : ""}</span>
      {odd.length ? <Badge tone="warning">{odd[0]}</Badge> : null}
    </span>
  );
}

export function AuditView({ rows, accounts, progress, today }: { rows: AuditRow[]; accounts: AuditAccount[]; progress: AuditProgress; today: string }) {
  const issues = useMemo(() => new Map(rows.map((d) => [d.id, auditIssues(d, today)])), [rows, today]);
  const groupOf = (d: AuditRow): Group | null => (d.archivedAt ? "archived" : issues.get(d.id)?.[0] ?? null);
  const counts = useMemo(() => {
    const c = new Map<Group, number>();
    for (const d of rows) { const g = groupOf(d); if (g) c.set(g, (c.get(g) ?? 0) + 1); }
    return c;
  }, [rows, issues]); // eslint-disable-line react-hooks/exhaustive-deps
  const firstGroup = ISSUE_ORDER.find((k) => counts.get(k)) ?? "unregistered";
  const [group, setGroup] = useSticky<Group>("audit:group", firstGroup);
  const [q, setQ] = useSticky("audit:q", "");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((d) => groupOf(d) === group && (!needle || d.name.includes(needle)));
  }, [rows, group, q, issues]); // eslint-disable-line react-hooks/exhaustive-deps
  const rowIds = useMemo(() => shown.map((r) => r.id), [shown]);
  const pick = useRangeSelect(rowIds, setSelected);
  const selectedRows = shown.filter((d) => selected.has(d.id));
  const archivable = selectedRows.filter((d) => !d.inUse && !d.archivedAt);
  const allShown = shown.length > 0 && shown.every((r) => selected.has(r.id));
  const someShown = shown.some((r) => selected.has(r.id));
  const toDecide = ISSUE_ORDER.filter((k) => ISSUES[k].archive).reduce((a, k) => a + (counts.get(k) ?? 0), 0);
  const toCheck = ISSUE_ORDER.filter((k) => !ISSUES[k].archive).reduce((a, k) => a + (counts.get(k) ?? 0), 0);
  const choose = (g: Group) => { setGroup(g); setSelected(new Set()); };

  const archive = () => start(async () => {
    const r = await archiveDomains({ ids: archivable.map((d) => d.id), reason: reason || (group === "archived" ? "" : ISSUES[group].label) });
    if (!r.ok) return void toast.error(r.error);
    setConfirm(false);
    setSelected(new Set());
    const refused = r.data.refused;
    toast.success(`Archived ${plural(r.data.archived, "domain")}`, refused.length ? {
      description: `${plural(refused.length, "domain")} kept, still in use: ${refused.slice(0, 5).map((x) => `${x.name} (${x.why})`).join(", ")}${refused.length > 5 ? "…" : ""}`,
    } : undefined);
  });
  const restore = () => start(async () => {
    const r = await restoreDomains({ ids: selectedRows.map((d) => d.id) });
    if (!r.ok) return void toast.error(r.error);
    setSelected(new Set());
    toast.success(`Restored ${plural(r.data.restored, "domain")}`, { description: "They're back in Inventory." });
  });
  const exportCsv = () => {
    const list = selectedRows.length ? selectedRows : shown;
    const esc = (v: unknown) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const day = (v: Date | null) => (v ? new Date(v).toISOString().slice(0, 10) : "");
    const head = ["domain", "problem", "status", "client", "registrar", "account", "expires", "registry_found", "registry_registrar", "registry_expires", "registry_status", "in_use", "archived_reason"];
    const lines = list.map((d) => {
      const k = issues.get(d.id)?.[0];
      return [d.name, k ? issueText(k, d) : "", d.status, d.clientName, d.registrar, d.registrarAccount, day(d.expiresAt), d.registryFound, d.registryRegistrar, day(d.registryExpiresAt), d.registryStatus.join(" "), d.inUse, d.archivedReason].map(esc).join(",");
    });
    const url = URL.createObjectURL(new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" }));
    Object.assign(document.createElement("a"), { href: url, download: `domain-audit-${group}-${today}.csv` }).click();
    URL.revokeObjectURL(url);
  };

  const meta = group === "archived" ? null : ISSUES[group];
  const unchecked = progress.total - progress.checked;

  return (
    <>
      <section className="stats" aria-label="Audit numbers">
        <div className="stat">
          <span className="stat-label"><Dot tone="danger" />Not wanted</span>
          <span className={`stat-value${toDecide ? " text-danger-ink" : ""}`}>{int(toDecide)}</span>
          <span className="stat-foot">not registered, gone, dropped or expired</span>
        </div>
        <div className="stat">
          <span className="stat-label"><Dot tone="warning" />Expired, still in use</span>
          <span className={`stat-value${counts.get("expired_in_use") ? " text-warning-ink" : ""}`}>{int(counts.get("expired_in_use") ?? 0)}</span>
          <span className="stat-foot">renew or replace</span>
        </div>
        <div className="stat">
          <span className="stat-label"><Dot tone="info" />To check</span>
          <span className="stat-value">{int(toCheck - (counts.get("expired_in_use") ?? 0))}</span>
          <span className="stat-foot">registrar or expiry differs</span>
        </div>
        <div className="stat">
          <span className="stat-label"><Dot tone="success" />Registry checked</span>
          <span className="stat-value">{int(progress.checked)}<span className="text-muted" style={{ fontSize: "var(--fs-13)", fontWeight: 400 }}> / {int(progress.total)}</span></span>
          <span className="stat-foot" title="Each domain is asked again every week">
            {unchecked ? `${int(unchecked)} still to ask, about ${Math.max(1, Math.ceil(unchecked / 540))}h` : progress.lastCheckedAt ? `last ${ago(progress.lastCheckedAt)}` : "not started"}
            {progress.failed ? ` · ${int(progress.failed)} couldn't be asked` : ""}
          </span>
        </div>
      </section>

      <section className="card" aria-labelledby="audit-accounts">
        <div className="card-head">
          <h2 id="audit-accounts" className="card-title">Registrar accounts</h2>
          <span className="card-sub">what each account lists against what the app has</span>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>Account</th><th className="is-num">Listed there</th><th className="is-num">In the app</th><th className="is-num" title="On the account in the app, but not on its last full list">Not on its list</th><th>Last full list</th><th>Sync</th></tr></thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td className="strong">{a.vendor}<span className="text-muted" style={{ fontWeight: 400 }}> · {a.label}</span></td>
                  <td className="is-num">{a.listed == null ? <span className="zero">—</span> : int(a.listed)}</td>
                  <td className="is-num">{int(a.inApp)}</td>
                  <td className="is-num">{a.gone ? <span className="text-danger-ink">{int(a.gone)}</span> : <span className="zero">0</span>}</td>
                  <td className="text-muted">{a.listedAt ? ago(a.listedAt) : "not read in full yet"}</td>
                  <td>{a.lastOk === false ? <span className="text-danger-ink" title={a.lastError ?? undefined}>Failing: {a.lastError?.slice(0, 60)}</span> : a.lastSyncedAt ? <span className="text-muted">OK {ago(a.lastSyncedAt)}</span> : <span className="zero">never</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="flex flex-col gap-3">
        <div className="free-bar">
          <div className="tld-chips" role="group" aria-label="What's wrong">
            {ISSUE_ORDER.filter((k) => counts.get(k) || group === k).map((k) => (
              <button key={k} type="button" className={`tld-chip${ISSUES[k].tone === "danger" ? " is-danger" : ""}`} aria-pressed={group === k} title={ISSUES[k].hint} onClick={() => choose(k)}>
                {ISSUES[k].label} <span>{int(counts.get(k) ?? 0)}</span>
              </button>
            ))}
            <button type="button" className="tld-chip" aria-pressed={group === "archived"} title="Archived domains: left out of every list and count. Select them to restore" onClick={() => choose("archived")}>
              Archived <span>{int(counts.get("archived") ?? 0)}</span>
            </button>
          </div>
          <div className="table-bar">
            <label className="search-input">
              <Search size={14} strokeWidth={1.5} />
              <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search audited domains" />
            </label>
            <span className="spacer-auto" />
            <button type="button" className="btn btn-sm" onClick={exportCsv}><Download size={14} /> Export</button>
          </div>
          {meta ? <p className="cfg-note">{meta.hint}</p> : <p className="cfg-note">Left out of every list and count. The registrar sync keeps them up to date without bringing them back.</p>}
        </div>

        <div className="table-wrap">
          <div className="table-scroll" style={{ maxHeight: "calc(100dvh - 300px)", minHeight: 280 }}>
            <table className="data-table is-main is-fixed" style={{ minWidth: 1240 }}>
              <colgroup>
                <col style={{ width: 40 }} /><col style={{ width: 200 }} /><col /><col style={{ width: 100 }} /><col style={{ width: 100 }} />
                <col style={{ width: 190 }} /><col style={{ width: 220 }} /><col style={{ width: 64 }} />
              </colgroup>
              <thead>
                <tr>
                  <th className="col-check">
                    <input type="checkbox" className="checkbox" aria-label="Select all shown" checked={allShown}
                      ref={(el) => { if (el) el.indeterminate = !allShown && someShown; }}
                      onChange={() => setSelected((s) => { const n = new Set(s); shown.forEach((r) => (allShown ? n.delete(r.id) : n.add(r.id))); return n; })} />
                  </th>
                  <th className="col-first">Domain</th>
                  <th>{group === "archived" ? "Why archived" : "What's wrong"}</th>
                  <th>In the app</th>
                  <th>Client</th>
                  <th>Registrar</th>
                  <th title="What the registry (RDAP) says: registrar of record, expiry, and any status beyond the usual locks">Registry</th>
                  <th className="is-num">Inboxes</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((d) => {
                  const isSel = selected.has(d.id);
                  const all = issues.get(d.id) ?? [];
                  return (
                    <tr key={d.id} data-selected={isSel} className="is-clickable" onMouseDown={keepTextUnselected} onClick={(e) => pick(d.id, e)}>
                      <td className="col-check"><input type="checkbox" className="checkbox" checked={isSel} onChange={() => {}} aria-label={`Select ${d.name}`} tabIndex={-1} /></td>
                      <td className="col-first"><span className="inv-name"><DomainLink id={d.id} className="strong hover:underline" title={d.name}>{d.name}</DomainLink></span></td>
                      <td>
                        {d.archivedAt ? (
                          <span className="text-muted" title={`Archived by ${d.archivedBy ?? "?"} ${ago(d.archivedAt)}`}>{d.archivedReason ?? "—"} · {ago(d.archivedAt)}</span>
                        ) : (
                          <span className="flex flex-col" title={all.map((k) => issueText(k, d)).join("\n")}>
                            {all.map((k, i) => <span key={k} className={`truncate${i ? " text-muted" : ""}`}>{issueText(k, d)}</span>)}
                            {d.inUse && ISSUES[all[0]]?.archive ? <span className="text-warning-ink">Can&apos;t archive: {d.inUse}</span> : null}
                          </span>
                        )}
                      </td>
                      <td><StatusDot status={d.status} /></td>
                      <td><ClientCell name={d.clientName} hue={d.clientHue} /></td>
                      <td className="text-muted" title={[d.registrar, d.registrarAccount].filter(Boolean).join(" · ") || undefined}>
                        {d.registrar ? <>{d.registrar.replace(/ Domains$/, "")}{d.registrarAccount ? ` · ${d.registrarAccount}` : ""}</> : <span className="zero">None</span>}
                        {d.expiresAt ? <span className="tabular-nums"> · {fixedDate(d.expiresAt)}</span> : d.unregistered ? <span className="text-danger-ink"> · no date</span> : null}
                      </td>
                      <td>{registryCell(d)}</td>
                      <td className="is-num">{d.inboxCount ? int(d.inboxCount) : <span className="zero">0</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {shown.length === 0 ? (
              <Empty icon={ShieldCheck} title={q ? "No domains match" : group === "archived" ? "Nothing archived" : "Nothing here"}>
                {q ? "Clear the search." : progress.checked < progress.total ? "The registry check is still going; more may turn up." : "Every domain checks out."}
              </Empty>
            ) : null}
          </div>
          <div className="table-footer">
            <span><b>{int(shown.length)}</b> domain{shown.length === 1 ? "" : "s"}</span>
            <span className="table-footer-hint hidden md:inline-flex"><span>Registrar lists refresh every 6 hours; the registry is asked about each domain every week.</span></span>
          </div>
        </div>
      </div>

      {selected.size > 0 ? (
        <div className="bulk-bar" role="toolbar" aria-label="Selected domains">
          <span className="bulk-count">{selectedRows.length} selected</span>
          {group === "archived" ? (
            <button type="button" className="btn btn-sm btn-primary" disabled={pending} onClick={restore}><ArchiveRestore size={14} /> Restore</button>
          ) : meta?.archive ? (
            <button type="button" className="btn btn-sm btn-primary" disabled={!archivable.length || pending}
              title={archivable.length < selectedRows.length ? `${plural(selectedRows.length - archivable.length, "domain")} still in use can't be archived` : "Leave them out of every list and count"}
              onClick={() => { setReason(meta.label); setConfirm(true); }}>
              <Archive size={14} /> Archive{archivable.length !== selectedRows.length ? ` (${int(archivable.length)})` : ""}
            </button>
          ) : null}
          <button type="button" className="btn btn-sm" title="Copy the selected domains, one per line" onClick={() => copyDomains(selectedRows.map((d) => d.name))}><Copy size={14} /> Copy</button>
          <button type="button" className="btn btn-sm" onClick={exportCsv}><Download size={14} /> Export</button>
          <span className="sep" />
          <button type="button" className="btn btn-sm" aria-label="Clear selection" onClick={() => setSelected(new Set())}><X size={14} /></button>
        </div>
      ) : null}

      <Dialog.Root open={confirm} onOpenChange={setConfirm}>
        <Dialog.Portal>
          <Dialog.Overlay className="overlay" />
          <Dialog.Content className="dialog">
            <div className="dialog-head cfg-top">
              <div>
                <Dialog.Title className="dialog-title">Archive {plural(archivable.length, "domain")}</Dialog.Title>
                <Dialog.Description className="dialog-desc">
                  They leave Inventory, the counts and the free pool, and keep their history. Nothing changes at the registrar. You can restore them from Archived.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild><button type="button" className="btn btn-sm btn-icon" aria-label="Close"><X size={15} /></button></Dialog.Close>
            </div>
            <div className="dialog-body">
              <label className="field">
                <span className="field-label">Reason</span>
                <input className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
              </label>
              <p className="cfg-note">{archivable.slice(0, 12).map((d) => d.name).join(", ")}{archivable.length > 12 ? ` and ${int(archivable.length - 12)} more` : ""}</p>
            </div>
            <div className="dialog-foot">
              <span className="spacer" />
              <button type="button" className="btn" onClick={() => setConfirm(false)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={pending || !archivable.length} onClick={archive}><Archive size={14} /> Archive {plural(archivable.length, "domain")}</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
