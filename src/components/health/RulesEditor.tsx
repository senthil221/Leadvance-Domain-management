"use client";

import { RefreshCw } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { runHealthCheck, updateRule } from "@/app/actions";
import type { RuleRow } from "@/lib/queries";

const METRIC_LABEL: Record<string, { label: string; unit: string }> = {
  bounce_rate: { label: "Bounce rate", unit: "%" },
  reply_rate: { label: "Reply rate", unit: "%" },
  human_reply_rate: { label: "Human reply rate", unit: "%" },
  human_replies: { label: "Human replies", unit: "" },
  bounces: { label: "Bounces", unit: "" },
  warmup_reputation: { label: "Warmup reputation", unit: "" },
};
const CMP: Record<string, string> = { gt: "above", gte: "at or above", lt: "below", lte: "at or below", eq: "equal to" };

export function RulesEditor({ rules }: { rules: RuleRow[] }) {
  const [checking, startCheck] = useTransition();
  return (
    <section className="card" aria-labelledby="rules-title">
      <div className="card-head">
        <h2 id="rules-title" className="card-title">Rules</h2>
        <span className="card-sub">checked after every stats sync</span>
        <button
          type="button"
          className="btn btn-sm ml-auto"
          disabled={checking}
          onClick={() => startCheck(async () => {
            const r = await runHealthCheck();
            if (!r.ok) toast.error(r.error);
            else toast.success("Health check done", { description: `${r.data.opened} new alerts, ${r.data.resolved} resolved` });
          })}
        >
          <RefreshCw size={13} className={checking ? "animate-spin" : undefined} /> {checking ? "Checking…" : "Check now"}
        </button>
      </div>
      <div className="list">
        {rules.map((r) => <RuleRowEditor key={r.id} rule={r} />)}
      </div>
    </section>
  );
}

function RuleRowEditor({ rule }: { rule: RuleRow }) {
  const [threshold, setThreshold] = useState(String(rule.threshold));
  const [minSent, setMinSent] = useState(String(rule.minSent));
  const [windowDays, setWindowDays] = useState(String(rule.windowDays));
  const [enabled, setEnabled] = useState(rule.enabled);
  const [pending, startTransition] = useTransition();
  const m = METRIC_LABEL[rule.metric] ?? { label: rule.metric, unit: "" };
  const dirty = threshold !== String(rule.threshold) || minSent !== String(rule.minSent) || windowDays !== String(rule.windowDays) || enabled !== rule.enabled;

  const save = (nextEnabled = enabled) =>
    startTransition(async () => {
      const r = await updateRule({ id: rule.id, threshold: Number(threshold), minSent: Number(minSent), windowDays: Number(windowDays), severity: rule.severity, enabled: nextEnabled });
      if (!r.ok) toast.error(r.error);
      else toast.success(`Saved “${rule.name}”`);
    });

  return (
    <div className="list-row flex-wrap gap-y-2" style={{ opacity: enabled ? 1 : 0.6 }}>
      <label className="flex items-center gap-2" title={enabled ? "Turn off" : "Turn on"}>
        <input type="checkbox" className="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); save(e.target.checked); }} aria-label={`Enable ${rule.name}`} />
      </label>
      <div className="list-main" style={{ minWidth: 180 }}>
        <span className="list-title flex items-center gap-2">
          {rule.name}
          <span className={`badge tone-${rule.severity === "critical" ? "danger" : "warning"}`}>{rule.severity}</span>
        </span>
        <span className="list-meta">{rule.openCount ? `${rule.openCount} open alert${rule.openCount === 1 ? "" : "s"}` : "No open alerts"}</span>
      </div>
      <div className="flex basis-full flex-wrap items-center gap-1.5 pl-[27px] text-muted">
        <span>{m.label} {CMP[rule.comparison]}</span>
        <input className="input num" style={{ width: 64, height: 28 }} value={threshold} onChange={(e) => setThreshold(e.target.value)} inputMode="decimal" aria-label="Threshold" />
        <span>{m.unit}</span>
        <span className="ml-2">after</span>
        <input className="input num" style={{ width: 72, height: 28 }} value={minSent} onChange={(e) => setMinSent(e.target.value)} inputMode="numeric" aria-label="Minimum sent" />
        <span>sent, over</span>
        <input className="input num" style={{ width: 52, height: 28 }} value={windowDays} onChange={(e) => setWindowDays(e.target.value)} inputMode="numeric" aria-label="Window in days" />
        <span>days</span>
        <button type="button" className="btn btn-sm ml-2" style={{ visibility: dirty ? "visible" : "hidden" }} disabled={pending} onClick={() => save()}>
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
