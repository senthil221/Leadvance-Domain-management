"use client";

import { DomainLink } from "@/components/domains/DomainLink";
import { BellOff, Check, CircleCheck } from "lucide-react";
import { useOptimistic, useState, useTransition } from "react";
import { toast } from "sonner";
import { updateAlert } from "@/app/actions";
import { ReplaceDialog, type ReplaceTarget } from "@/components/domains/ReplaceDialog";
import { ClientCell, Dot, Empty } from "@/components/ui";
import { ago, int } from "@/lib/format";
import type { AttentionRow } from "@/lib/queries";
import type { ReplacementReason } from "@/lib/status";

const reasonFor = (metric: string): ReplacementReason =>
  metric === "bounce_rate" || metric === "bounces" ? "high_bounce" : metric === "warmup_reputation" ? "low_reputation" : "low_replies";

function describe(r: AttentionRow) {
  if (r.value == null) return r.ruleName;
  if (r.metric.endsWith("_rate")) return `${r.ruleName} · ${r.value.toFixed(1)}%`;
  if (r.metric === "warmup_reputation") return `${r.ruleName} · ${r.value.toFixed(0)}`;
  return `${r.ruleName} · ${int(r.sent)} sent`;
}

export function AttentionList({ rows }: { rows: AttentionRow[] }) {
  const [hidden, hide] = useOptimistic(new Set<string>(), (s, id: string) => new Set(s).add(id));
  const [, startTransition] = useTransition();
  const [target, setTarget] = useState<{ t: ReplaceTarget; reason: ReplacementReason } | null>(null);
  const visible = rows.filter((r) => !hidden.has(r.alertId));

  const act = (r: AttentionRow, status: "resolved" | "snoozed") =>
    startTransition(async () => {
      hide(r.alertId);
      const res = await updateAlert(r.alertId, status);
      if (!res.ok) toast.error(res.error);
      else toast(status === "snoozed" ? `Snoozed ${r.domain} for 3 days` : `Dismissed alert on ${r.domain}`);
    });

  if (visible.length === 0) {
    return <Empty icon={CircleCheck} title="All clear">No sending domain is breaking a health rule right now.</Empty>;
  }

  return (
    <>
      <div className="list">
        {visible.map((r) => (
          <div key={r.alertId} className="list-row">
            <Dot tone={r.severity === "critical" ? "danger" : "warning"} />
            <div className="list-main">
              <DomainLink id={r.domainId} className="list-title hover:underline">{r.domain}</DomainLink>
              <span className="list-meta">{describe(r)} · {ago(r.openedAt)}</span>
            </div>
            <span className="hidden sm:inline-flex"><ClientCell name={r.clientName} hue={r.clientHue} /></span>
            <div className="row-actions">
              <button type="button" className="icon-btn" title="Snooze 3 days" aria-label={`Snooze ${r.domain}`} onClick={() => act(r, "snoozed")}>
                <BellOff size={15} strokeWidth={1.5} />
              </button>
              <button type="button" className="icon-btn" title="Dismiss" aria-label={`Dismiss alert on ${r.domain}`} onClick={() => act(r, "resolved")}>
                <Check size={15} strokeWidth={1.5} />
              </button>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                setTarget({
                  t: { id: r.domainId, name: r.domain, tld: r.domain.split(".").pop() ?? null, clientName: r.clientName, clientHue: r.clientHue },
                  reason: reasonFor(r.metric),
                })
              }
            >
              Replace
            </button>
          </div>
        ))}
      </div>
      <ReplaceDialog
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        targets={target ? [target.t] : []}
        defaultReason={target?.reason}
      />
    </>
  );
}
