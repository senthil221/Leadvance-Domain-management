"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  ArrowLeftRight, ArrowRight, Check, CircleAlert, Flame, Hourglass, Inbox, Loader, Megaphone, Search, ShieldCheck, TriangleAlert,
} from "lucide-react";
import { AddToCampaigns } from "@/components/replacements/AddToCampaigns";
import { ApprovePayment } from "@/components/replacements/ApprovePayment";
import { StepActions } from "@/components/replacements/StepActions";
import { Badge, ClientCell, Empty } from "@/components/ui";
import type { ReplacementRow } from "@/lib/queries";
import { REPLACEMENT_REASONS, STATUS_META, type StepStatus, type Tone } from "@/lib/status";

type StepName = "nameservers" | "inboxes" | "smartlead" | "campaigns";
const STEP_COL = { nameservers: "stepNameservers", inboxes: "stepInboxes", smartlead: "stepSmartlead", campaigns: "stepCampaigns" } as const;
const STEPS = Object.keys(STEP_COL) as StepName[];
const finished = (s: StepStatus) => s === "done" || s === "skipped";

type State = "attention" | "progress" | "warming" | "live";
const STATE_META: Record<State, { label: string; tone: Tone }> = {
  attention: { label: "Needs you", tone: "warning" },
  progress: { label: "In progress", tone: "info" },
  warming: { label: "Warming", tone: "violet" },
  live: { label: "In campaigns", tone: "success" },
};

function stateOf(r: ReplacementRow): State {
  if (!r.completedAt && STEPS.some((s) => ["manual", "failed"].includes(r[STEP_COL[s]]))) return "attention";
  if (!r.completedAt) return "progress";
  return r.stepCampaigns === "done" ? "live" : "warming";
}
const currentStep = (r: ReplacementRow) => STEPS.find((s) => !finished(r[STEP_COL[s]])) ?? null;

type View = "open" | "warming" | "grace" | "live" | "all";

// Fixed-format dates so the server and browser render the same text.
const dayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
function ago(d: Date | string, now: number) {
  const m = Math.max(0, Math.round((now - +new Date(d)) / 60_000));
  if (m < 60) return m <= 1 ? "just now" : `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
const daysLeft = (d: Date | string, now: number) => Math.max(0, Math.ceil((+new Date(d) - now) / 86_400_000));
const shortNs = (ns: string[] | null) => (ns?.length ? ns.map((n) => n.split(".")[0]).join(" · ") : null);

export function ReplacementsView({ rows, now, smartleadLive }: { rows: ReplacementRow[]; now: number; smartleadLive: boolean }) {
  const [view, setView] = useState<View | null>(null);
  const [q, setQ] = useState("");

  const counts = useMemo(() => {
    const c = { open: 0, attention: 0, warming: 0, grace: 0, live: 0 };
    for (const r of rows) {
      const s = stateOf(r);
      if (s === "attention" || s === "progress") c.open++;
      if (s === "attention") c.attention++;
      if (s === "warming") c.warming++;
      if (s === "live") c.live++;
      if (r.graceEndsAt) c.grace++;
    }
    return c;
  }, [rows]);
  const active = view ?? (counts.open ? "open" : counts.warming ? "warming" : "all");

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows
      .filter((r) => {
        const s = stateOf(r);
        if (active === "open" && s !== "attention" && s !== "progress") return false;
        if (active === "warming" && s !== "warming") return false;
        if (active === "live" && s !== "live") return false;
        if (active === "grace" && !r.graceEndsAt) return false;
        return !needle || [r.oldDomain, r.newDomain, r.clientName ?? ""].some((v) => v.toLowerCase().includes(needle));
      })
      // Needing a person first, then newest.
      .sort((a, b) => Number(stateOf(b) === "attention") - Number(stateOf(a) === "attention") || +new Date(b.createdAt) - +new Date(a.createdAt));
  }, [rows, active, q]);

  if (!rows.length) {
    return (
      <div className="card">
        <Empty icon={ArrowLeftRight} title="No replacements yet" action={<Link href="/domains?view=flagged" className="btn">Review flagged domains</Link>}>
          Select domains in Domains and press Replace. Each swap is followed here from Hypertide to Smartlead.
        </Empty>
      </div>
    );
  }

  const cards: { key: View; label: string; value: number; foot: string; icon: typeof Loader }[] = [
    { key: "open", label: "In progress", value: counts.open, foot: counts.attention ? `${counts.attention} need${counts.attention === 1 ? "s" : ""} you` : "Running on their own", icon: Loader },
    { key: "warming", label: "Warming", value: counts.warming, foot: "Not in campaigns yet", icon: Flame },
    { key: "grace", label: "Old domains in grace", value: counts.grace, foot: "Still receiving replies", icon: Hourglass },
    { key: "live", label: "In campaigns", value: counts.live, foot: "Fully swapped", icon: Megaphone },
    { key: "all", label: "All", value: rows.length, foot: "Every replacement", icon: ArrowLeftRight },
  ];

  return (
    <>
      <div className="ev-cards is-5">
        {cards.map((c) => (
          <button key={c.key} type="button" className="ev-card" aria-pressed={active === c.key} onClick={() => setView(c.key)}>
            <span className="ev-card-label"><c.icon size={13} strokeWidth={1.75} />{c.label}</span>
            <span className="ev-card-value">{c.value}</span>
            <span className={`ev-card-foot ${c.key === "open" && counts.attention ? "text-warning-ink" : ""}`}>{c.foot}</span>
          </button>
        ))}
      </div>

      <div className="table-bar">
        <label className="search-input">
          <Search size={14} strokeWidth={1.5} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search domain or client" aria-label="Search replacements" />
        </label>
        <span className="view-tabs-summary"><b>{shown.length}</b> of {rows.length}</span>
      </div>

      {shown.length ? (
        <div className="rp-list">
          {shown.map((r) => <ReplacementCard key={r.id} r={r} now={now} smartleadLive={smartleadLive} />)}
        </div>
      ) : (
        <div className="card"><Empty icon={Search} title="Nothing here">No replacements match this view.</Empty></div>
      )}
    </>
  );
}

function ReplacementCard({ r, now, smartleadLive }: { r: ReplacementRow; now: number; smartleadLive: boolean }) {
  const state = stateOf(r);
  const step = currentStep(r);
  const stepStatus = step ? r[STEP_COL[step]] : null;
  const failed = stepStatus === "failed";
  const warmupOff = r.newInboxes > 0 && r.newWarmupOn < r.newInboxes;
  const canAddCampaigns = finished(r.stepSmartlead) && r.stepCampaigns !== "done";

  return (
    <article className={`rp-item ${state === "attention" ? (failed ? "is-error" : "is-attn") : ""}`} aria-label={`${r.oldDomain} replaced by ${r.newDomain}`}>
      <div className="rp-head">
        <div className="rp-swap">
          <Link href={`/domains?d=${r.oldDomainId}`} className="rp-old" title="Old domain">{r.oldDomain}</Link>
          <ArrowRight size={14} strokeWidth={1.75} className="rp-arrow" />
          <Link href={`/domains?d=${r.newDomainId}`} className="rp-new" title="New domain">{r.newDomain}</Link>
          {r.hypertideReplace ? <Badge tone="info">Hypertide</Badge> : null}
        </div>
        <div className="rp-meta">
          <ClientCell name={r.clientName} hue={r.clientHue} />
          <Badge tone={STATE_META[state].tone}>{STATE_META[state].label}</Badge>
        </div>
        <div className="rp-sub">
          <span>{REPLACEMENT_REASONS[r.reason]}{r.batchNote ? ` · ${r.batchNote}` : ""}</span>
          <span>· {dayFmt.format(new Date(r.createdAt))}, {ago(r.createdAt, now)} · {r.actor.split("@")[0]}</span>
        </div>
      </div>

      <div className="rp-track">
        {STEPS.map((s, i) => <Node key={s} r={r} step={s} index={i} />)}
      </div>

      {!r.completedAt && step && (r.lastError || r.note) ? (
        <div className={`rp-action ${failed ? "is-error" : stepStatus === "manual" ? "" : "is-info"}`}>
          {failed ? <CircleAlert size={15} className="flex-none text-danger-ink" /> : stepStatus === "manual" ? <TriangleAlert size={15} className="flex-none text-warning-ink" /> : <Loader size={14} className="flex-none animate-spin text-muted" />}
          <p>{r.lastError ?? r.note}</p>
          <span className="rp-action-btns">
            {step === "inboxes" && r.htOrderId && !r.htPaidAt ? <ApprovePayment itemIds={[r.id]} domains={[r.newDomain]} /> : null}
            {stepStatus === "manual" || stepStatus === "failed" || stepStatus === "running" ? <StepActions itemId={r.id} step={step} status={stepStatus} /> : null}
          </span>
        </div>
      ) : null}

      {r.completedAt && canAddCampaigns ? (
        <div className="rp-action is-info">
          <Flame size={15} className="flex-none" style={{ color: "var(--violet-ink)" }} />
          <p>
            {r.newDomain} is warming and not in any campaign yet.
            {warmupOff ? <b className="font-medium text-warning-ink"> Warmup is off on {r.newInboxes - r.newWarmupOn} of {r.newInboxes} inboxes; turn it on in Inboxes.</b> : null}
            {r.oldCampaigns.length ? ` When it's ready, add its inboxes to ${r.oldDomain}'s ${r.oldCampaigns.length} campaign${r.oldCampaigns.length === 1 ? "" : "s"}.` : ""}
          </p>
          <span className="rp-action-btns">
            {r.oldCampaigns.length && smartleadLive ? (
              <AddToCampaigns itemId={r.id} domain={r.newDomain} campaigns={r.oldCampaigns} inboxes={r.newInboxes} warmupOn={r.newWarmupOn} reputation={r.newReputation} />
            ) : null}
          </span>
        </div>
      ) : null}

      <div className="rp-foot">
        <span className={`rp-fact ${r.newInboxes && r.newInboxes >= r.oldInboxes ? "is-good" : ""}`} title="Connected inboxes on the new domain, of the old domain's count">
          <Inbox size={13} strokeWidth={1.75} /><b>{r.newInboxes}</b>{r.oldInboxes ? ` of ${r.oldInboxes}` : ""} inboxes
        </span>
        {r.newInboxes ? (
          <span className={`rp-fact ${warmupOff ? "is-warn" : ""}`} title="New inboxes with warmup on">
            <Flame size={13} strokeWidth={1.75} />Warmup <b>{r.newWarmupOn === r.newInboxes ? "on" : `${r.newWarmupOn}/${r.newInboxes} on`}</b>
          </span>
        ) : null}
        {r.newReputation != null ? (
          <span className={`rp-fact ${r.newReputation >= 95 ? "is-good" : r.newReputation < 85 ? "is-warn" : ""}`}>
            <ShieldCheck size={13} strokeWidth={1.75} />Reputation <b>{r.newReputation}%</b>
          </span>
        ) : null}
        <span className="rp-fact" title={r.stopOldSending ? "The old domain's daily limit goes to 0 when the new one is ready" : undefined}>
          <Hourglass size={13} strokeWidth={1.75} />
          {r.oldDomain}:{" "}
          {r.graceEndsAt
            ? <b>{daysLeft(r.graceEndsAt, now)}d of grace left</b>
            : <b>{STATUS_META[r.oldStatus]?.label ?? r.oldStatus}</b>}
          {r.stopOldSending && r.completedAt ? <span className="text-faint">· not sending</span> : null}
        </span>
        <Link href={`/domains?d=${r.newDomainId}`} className="btn btn-sm btn-ghost rp-foot-link">Open {r.newDomain}</Link>
      </div>
    </article>
  );
}

function Node({ r, step, index }: { r: ReplacementRow; step: StepName; index: number }) {
  const s = r[STEP_COL[step]];
  const warming = step === "campaigns" && s === "skipped";
  const cls = warming ? "is-warm" : s === "done" || s === "skipped" ? "is-done" : `is-${s}`;
  const label = { nameservers: "Nameservers", inboxes: r.hypertideReplace ? "Hypertide" : "Inboxes", smartlead: "Smartlead", campaigns: warming ? "Warming up" : "Campaigns" }[step];
  const sub = (() => {
    if (s === "failed") return "Needs you";
    if (s === "manual") return "Your turn";
    switch (step) {
      case "nameservers": return s === "done" ? (shortNs(r.htNameservers) ?? "Set") : s === "running" ? "Setting at Porkbun" : "Waiting";
      case "inboxes": return s === "done" ? "Order done" : r.htOperation ? r.htOperation.replace(/_/g, " ") : s === "running" ? "Setting up" : "Waiting";
      case "smartlead": return s === "done" ? `${r.newInboxes} inboxes in` : s === "running" ? (r.newInboxes ? `${r.newInboxes} of ${r.oldInboxes} in` : "Waiting for sync") : "Waiting";
      case "campaigns": return warming ? "Not in campaigns" : s === "done" ? `${r.oldCampaigns.length || ""} added`.trim() : "Waiting";
    }
  })();
  return (
    <div className={`rp-node ${cls}`}>
      <div className="rp-node-top">
        <span className="rp-dot">
          {warming ? <Flame size={12} strokeWidth={2} /> : finished(s) ? <Check size={12} strokeWidth={2.5} /> : s === "running" ? <Loader size={12} className="animate-spin" /> : s === "failed" || s === "manual" ? "!" : index + 1}
        </span>
        <span className="rp-bar" />
      </div>
      <span className="rp-node-label">{label}</span>
      <span className="rp-node-sub" title={sub}>{sub}</span>
    </div>
  );
}
