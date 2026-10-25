"use client";

import { DomainLink } from "@/components/domains/DomainLink";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Fragment, useMemo, useState } from "react";
import { ArrowLeftRight, ChevronRight, CircleAlert, Search, TriangleAlert } from "lucide-react";
import { AddToCampaigns } from "@/components/replacements/AddToCampaigns";
import { ApprovePayment } from "@/components/replacements/ApprovePayment";
import { StepActions } from "@/components/replacements/StepActions";
import { ClientCell, Empty } from "@/components/ui";
import type { ReplacementRow } from "@/lib/queries";
import { REPLACEMENT_REASONS, STATUS_META, type StepStatus } from "@/lib/status";

type StepName = "nameservers" | "inboxes" | "smartlead" | "campaigns";
const STEP_COL = { nameservers: "stepNameservers", inboxes: "stepInboxes", smartlead: "stepSmartlead", campaigns: "stepCampaigns" } as const;
const STEPS = Object.keys(STEP_COL) as StepName[];
const finished = (s: StepStatus) => s === "done" || s === "skipped";

type State = "attention" | "progress" | "warming" | "live";
function stateOf(r: ReplacementRow): State {
  if (!r.completedAt && STEPS.some((s) => ["manual", "failed"].includes(r[STEP_COL[s]]))) return "attention";
  if (!r.completedAt) return "progress";
  return r.stepCampaigns === "done" ? "live" : "warming";
}
const currentStep = (r: ReplacementRow) => STEPS.find((s) => !finished(r[STEP_COL[s]])) ?? null;
const stepName = (r: ReplacementRow, s: StepName) =>
  ({ nameservers: "Nameservers", inboxes: r.hypertideReplace ? "Hypertide" : "Inboxes", smartlead: "Smartlead", campaigns: "Campaigns" })[s];

// What the row is doing right now, in a few words.
function statusText(r: ReplacementRow): { text: string; tone: "warning" | "danger" | "info" | "violet" | "success" } {
  const state = stateOf(r);
  const step = currentStep(r);
  if (state === "live") return { text: "In campaigns", tone: "success" };
  if (state === "warming") {
    if (r.ready) return { text: "Ready for campaigns", tone: "success" };
    const days = r.warmDays ?? 0;
    return { text: days < r.minDays ? `Warming · day ${days} of ${r.minDays}` : `Warming · rep under ${r.minRep}%`, tone: "violet" };
  }
  if (!step) return { text: "Finishing", tone: "info" };
  const s = r[STEP_COL[step]];
  if (s === "failed") return { text: `${stepName(r, step)} failed`, tone: "danger" };
  if (s === "manual") return { text: `${stepName(r, step)}: your turn`, tone: "warning" };
  if (step === "inboxes" && r.htOperation) return { text: `Hypertide ${r.htOperation.replace(/_/g, " ")}`, tone: "info" };
  if (step === "smartlead") return { text: r.newInboxes ? `${r.newInboxes}/${r.oldInboxes} in Smartlead` : "Waiting for Smartlead", tone: "info" };
  return { text: s === "running" ? `${stepName(r, step)}…` : `Waiting: ${stepName(r, step).toLowerCase()}`, tone: "info" };
}

type View = "open" | "ready" | "warming" | "grace";
const VIEWS: { key: View; label: string; match: (r: ReplacementRow) => boolean }[] = [
  { key: "open", label: "In progress", match: (r) => !r.completedAt },
  { key: "ready", label: "Ready", match: (r) => stateOf(r) === "warming" && r.ready },
  { key: "warming", label: "Warming", match: (r) => stateOf(r) === "warming" },
  { key: "grace", label: "Old in grace", match: (r) => r.graceEndsAt != null },
];

const dayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
function ago(d: Date | string, now: number) {
  const m = Math.max(0, Math.round((now - +new Date(d)) / 60_000));
  if (m < 60) return m <= 1 ? "just now" : `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
const daysLeft = (d: Date | string, now: number) => Math.max(0, Math.ceil((+new Date(d) - now) / 86_400_000));

export function ReplacementsView({ rows, now, smartleadLive, graceDays }: { rows: ReplacementRow[]; now: number; smartleadLive: boolean; graceDays: number }) {
  const params = useSearchParams();
  const [view, setView] = useState<View | null>(() => (VIEWS.some((v) => v.key === params.get("view")) ? (params.get("view") as View) : null));
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  const counts = useMemo(() => Object.fromEntries(VIEWS.map((v) => [v.key, rows.filter(v.match).length])) as Record<View, number>, [rows]);
  const attention = useMemo(() => rows.filter((r) => stateOf(r) === "attention").length, [rows]);
  const active = view ?? (counts.open ? "open" : counts.ready ? "ready" : counts.warming ? "warming" : "grace");

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = VIEWS.find((v) => v.key === active)!.match;
    return rows
      .filter((r) => match(r) && (!needle || [r.oldDomain, r.newDomain, r.clientName ?? ""].some((v) => v.toLowerCase().includes(needle))))
      .sort((a, b) => Number(stateOf(b) === "attention") - Number(stateOf(a) === "attention") || Number(b.ready) - Number(a.ready) || +new Date(b.createdAt) - +new Date(a.createdAt));
  }, [rows, active, q]);

  if (!rows.length) {
    return (
      <div className="card">
        <Empty icon={ArrowLeftRight} title="No replacements yet" action={<Link href="/inboxes?view=attention" className="btn">Domains that need attention</Link>}>
          Pick domains in Smartlead (Needs attention) or Domains and press Replace. Each swap is followed here from Hypertide to Smartlead.
        </Empty>
      </div>
    );
  }

  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <>
      <div className="table-bar">
        <nav className="view-tabs" aria-label="Replacement views">
          {VIEWS.map((v) => (
            <button key={v.key} type="button" className={active === v.key ? "is-on" : undefined} onClick={() => setView(v.key)}>
              {v.label} <span>{counts[v.key]}</span>
            </button>
          ))}
        </nav>
        {attention ? (
          <button type="button" className="badge tone-warning rpl-attn" onClick={() => setView("open")}>
            <TriangleAlert size={11} strokeWidth={2} /> {attention} need{attention === 1 ? "s" : ""} you
          </button>
        ) : null}
        <label className="search-input" style={{ marginLeft: "auto" }}>
          <Search size={14} strokeWidth={1.5} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search replacements" />
        </label>
      </div>

      <div className="table-wrap">
        <div style={{ overflowX: "auto" }}>
          <table className="data-table is-main rpl-table">
            <thead>
              <tr>
                <th className="col-first">New domain</th>
                <th>Replaced domain</th>
                <th>Client</th>
                <th>Progress</th>
                <th className="is-num">Inboxes</th>
                <th>Warmup</th>
                <th className="is-num">Rep.</th>
                <th>Started</th>
                <th className="rpl-actions-h"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.length ? shown.map((r) => (
                <Row key={r.id} r={r} now={now} graceDays={graceDays} smartleadLive={smartleadLive} isOpen={open.has(r.id)} onToggle={() => toggle(r.id)} />
              )) : (
                <tr><td colSpan={9} className="text-center text-muted" style={{ height: 80 }}>No replacements in this view.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Row({ r, now, graceDays, smartleadLive, isOpen, onToggle }: {
  r: ReplacementRow; now: number; graceDays: number; smartleadLive: boolean; isOpen: boolean; onToggle: () => void;
}) {
  const state = stateOf(r);
  const step = currentStep(r);
  const stepStatus = step ? r[STEP_COL[step]] : null;
  const status = statusText(r);
  const warmOff = r.newInboxes > 0 && r.newWarmupOn < r.newInboxes;
  const canAdd = r.completedAt && finished(r.stepSmartlead) && r.stepCampaigns !== "done" && r.oldCampaigns.length > 0 && smartleadLive;
  const note = r.lastError ?? r.note;

  return (
    <Fragment>
      <tr className={`is-clickable ${state === "attention" ? "rpl-attn-row" : ""}`} aria-expanded={isOpen} onClick={onToggle}>
        <td className="col-first">
          <span className="flex items-center gap-1.5">
            <ChevronRight size={13} className="flex-none text-faint transition-transform" style={{ transform: isOpen ? "rotate(90deg)" : undefined }} />
            <DomainLink id={r.newDomainId} tab="inboxes" className="strong hover:underline">{r.newDomain}</DomainLink>
            {state === "live" ? null : r.ready ? <span className="rpl-tag is-ready" title="Warmed up: ready to add to campaigns">Ready</span> : <span className="rpl-tag is-new">New</span>}
          </span>
        </td>
        <td>
          <span className="flex items-center gap-2">
            <DomainLink id={r.oldDomainId} className="text-muted hover:text-ink hover:underline">{r.oldDomain}</DomainLink>
            <Grace r={r} now={now} graceDays={graceDays} />
          </span>
        </td>
        <td><ClientCell name={r.clientName} hue={r.clientHue} /></td>
        <td>
          <span className="flex items-center gap-2.5">
            <span className="rpl-steps" aria-hidden="true">
              {STEPS.map((s) => {
                const v = r[STEP_COL[s]];
                const cls = s === "campaigns" && v === "skipped" ? "is-warm" : finished(v) ? "is-done" : `is-${v}`;
                return <span key={s} className={`rpl-seg ${cls}`} title={`${stepName(r, s)}: ${s === "campaigns" && v === "skipped" ? "warming, not in campaigns" : v}`} />;
              })}
            </span>
            <span className={`rpl-status tone-${status.tone}`} title={note ?? undefined}>
              {state === "attention" ? (stepStatus === "failed" ? <CircleAlert size={12} strokeWidth={2} /> : <TriangleAlert size={12} strokeWidth={2} />) : null}
              {status.text}
            </span>
          </span>
        </td>
        <td className="is-num">
          {r.newInboxes ? <><span className="strong">{r.newInboxes}</span><span className="text-faint">/{r.oldInboxes}</span></> : <span className="zero">—</span>}
        </td>
        <td>
          {!r.newInboxes ? <span className="zero">—</span>
            : warmOff ? <span className="text-warning-ink">{r.newWarmupOn}/{r.newInboxes} on</span>
            : <span className="text-success-ink">On</span>}
        </td>
        <td className="is-num">
          {r.newReputation == null ? <span className="zero">—</span>
            : <span className={r.newReputation >= 95 ? "text-success-ink" : r.newReputation < 85 && state === "live" ? "text-danger-ink" : undefined}>{r.newReputation}%</span>}
        </td>
        <td title={dayFmt.format(new Date(r.createdAt))}>{ago(r.createdAt, now)}</td>
        <td className="rpl-actions" onClick={(e) => e.stopPropagation()}>
          {state === "attention" && step && stepStatus ? <StepActions itemId={r.id} step={step} status={stepStatus} compact /> : null}
          {canAdd ? <AddToCampaigns itemId={r.id} domain={r.newDomain} campaigns={r.oldCampaigns} inboxes={r.newInboxes} warmupOn={r.newWarmupOn} reputation={r.newReputation} ready={r.ready} warmDays={r.warmDays} /> : null}
        </td>
      </tr>
      {isOpen ? (
        <tr className="rpl-detail">
          <td colSpan={9}>
            {note && !r.completedAt ? (
              <p className={`rpl-note ${r.lastError ? "is-error" : stepStatus === "manual" ? "is-warn" : ""}`}>{note}</p>
            ) : null}
            <dl className="rpl-facts">
              <div><dt>Reason</dt><dd>{REPLACEMENT_REASONS[r.reason]}{r.batchNote ? ` · ${r.batchNote}` : ""}</dd></div>
              <div><dt>Started by</dt><dd>{r.actor}</dd></div>
              {r.htNameservers?.length ? <div><dt>Nameservers</dt><dd>{r.htNameservers.join(", ")}</dd></div> : null}
              {r.hypertideReplace ? <div><dt>Hypertide</dt><dd>{r.htOperation ? r.htOperation.replace(/_/g, " ") : "not sent yet"}</dd></div> : null}
              <div><dt>Old domain</dt><dd>{STATUS_META[r.oldStatus]?.label ?? r.oldStatus}{r.stopOldSending ? ", stops sending once the new inboxes are in" : ", keeps sending"}</dd></div>
              <div><dt>Campaigns</dt><dd>{r.oldCampaigns.length ? r.oldCampaigns.join("; ") : "none"}</dd></div>
            </dl>
            {step === "inboxes" && r.htOrderId && !r.htPaidAt ? <div className="mt-2"><ApprovePayment itemIds={[r.id]} domains={[r.newDomain]} /></div> : null}
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

// "Replaced · 14d left" with a bar that empties over the grace period.
function Grace({ r, now, graceDays }: { r: ReplacementRow; now: number; graceDays: number }) {
  if (r.oldStatus === "burned") return <span className="rpl-tag is-gone">Replaced</span>;
  if (!r.graceEndsAt) return null;
  const left = daysLeft(r.graceEndsAt, now);
  const pct = Math.max(0, Math.min(100, (100 * left) / Math.max(1, graceDays)));
  return (
    <span className={`rpl-tag is-replaced ${left <= 3 ? "is-ending" : ""}`} title={`Hypertide keeps its inboxes up for replies until ${dayFmt.format(new Date(r.graceEndsAt))}`}>
      Replaced · {left ? `${left}d left` : "ends today"}
      <span className="rpl-grace"><span style={{ width: `${pct}%` }} /></span>
    </span>
  );
}
