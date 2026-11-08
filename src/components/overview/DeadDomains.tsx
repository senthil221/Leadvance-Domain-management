"use client";

import { DomainLink } from "@/components/domains/DomainLink";
import { useMemo, useState } from "react";
import { ReplaceDialog } from "@/components/domains/ReplaceDialog";
import { keepTextUnselected, useRangeSelect } from "@/components/table-tools";
import { ClientCell, Dot } from "@/components/ui";
import { DEAD_CAUSES, type DeadCause } from "@/lib/dead";
import { int, shortDate } from "@/lib/format";
import type { DeadDomainRow } from "@/lib/queries";

const ORDER: DeadCause[] = ["dns_gone", "tenant_deleted", "signin_expired", "mail_off", "disconnected", "deleted"];

function detail(r: DeadDomainRow) {
  const n = r.cause === "dns_gone" ? r.connected : r.disconnected + r.removed;
  const what = r.cause === "dns_gone" ? "still connected" : r.removed && !r.disconnected ? "gone from Smartlead" : r.disconnected && !r.removed ? "disconnected" : "lost";
  const kind = r.providerType === "OUTLOOK" ? "Outlook" : r.providerType === "GMAIL" ? "Gmail" : null;
  return `${int(n)} ${kind ? `${kind} ` : ""}inbox${n === 1 ? "" : "es"} ${what} · ${r.lastSendDay ? `last sent ${shortDate(r.lastSendDay)}` : "never sent"}`;
}

/** Active domains nothing can send from, by cause, to replace in one go. */
export function DeadDomains({ rows }: { rows: DeadDomainRow[] }) {
  const [cause, setCause] = useState<DeadCause | "all">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const counts = useMemo(() => {
    const m = new Map<DeadCause, number>();
    for (const r of rows) m.set(r.cause, (m.get(r.cause) ?? 0) + 1);
    return ORDER.filter((c) => m.has(c)).map((c) => ({ c, n: m.get(c)! }));
  }, [rows]);
  const shown = cause === "all" ? rows : rows.filter((r) => r.cause === cause);
  const picked = rows.filter((r) => selected.has(r.domainId));
  const targets = (picked.length ? picked : shown).map((r) => ({ id: r.domainId, name: r.name, tld: r.tld, clientName: r.clientName, clientHue: r.clientHue }));
  const allShown = shown.length > 0 && shown.every((r) => selected.has(r.domainId));
  const shownIds = useMemo(() => shown.map((r) => r.domainId), [shown]);
  const pick = useRangeSelect(shownIds, setSelected);

  return (
    <>
      <div className="card-body flex flex-wrap items-center gap-2" style={{ borderBottom: "1px solid var(--line)", paddingTop: 10, paddingBottom: 10 }}>
        <button type="button" className={`btn btn-sm${cause === "all" ? " btn-primary" : ""}`} aria-pressed={cause === "all"} onClick={() => setCause("all")}>All · {rows.length}</button>
        {counts.map(({ c, n }) => (
          <button key={c} type="button" className={`btn btn-sm${cause === c ? " btn-primary" : ""}`} aria-pressed={cause === c} title={DEAD_CAUSES[c].hint} onClick={() => setCause(c)}>
            {DEAD_CAUSES[c].label} · {n}
          </button>
        ))}
        <span className="flex-1" />
        <button type="button" className="btn btn-sm" onClick={() => setOpen(true)} disabled={!targets.length}>
          {picked.length ? `Replace ${picked.length} selected` : `Replace ${shown.length === rows.length ? "all" : "these"} ${shown.length}`}
        </button>
      </div>
      <div className="list" style={{ maxHeight: 440, overflowY: "auto" }}>
        <label className="list-row" style={{ minHeight: 32 }}>
          <input type="checkbox" className="checkbox" checked={allShown} aria-label="Select all shown"
            onChange={() => setSelected((s) => { const n = new Set(s); shown.forEach((r) => (allShown ? n.delete(r.domainId) : n.add(r.domainId))); return n; })} />
          <span className="list-meta">{shown.length} domain{shown.length === 1 ? "" : "s"}{picked.length ? ` · ${picked.length} selected` : ""}</span>
        </label>
        {shown.map((r) => (
          <div key={r.domainId} className="list-row">
            <input type="checkbox" className="checkbox" checked={selected.has(r.domainId)} onMouseDown={keepTextUnselected} onClick={(e) => pick(r.domainId, e)} onChange={() => {}} aria-label={`Select ${r.name}`} />
            <Dot tone={r.cause === "dns_gone" ? "danger" : "warning"} />
            <div className="list-main">
              <DomainLink id={r.domainId} className="list-title hover:underline">{r.name}</DomainLink>
              <span className="list-meta" title={DEAD_CAUSES[r.cause].hint} suppressHydrationWarning>
                <span className={r.cause === "dns_gone" ? "text-danger-ink" : undefined}>{DEAD_CAUSES[r.cause].label}</span> · {detail(r)}
              </span>
            </div>
            <span className="hidden sm:inline-flex"><ClientCell name={r.clientName} hue={r.clientHue} /></span>
          </div>
        ))}
      </div>
      <ReplaceDialog open={open} onOpenChange={setOpen} targets={targets} defaultReason="other" />
    </>
  );
}
