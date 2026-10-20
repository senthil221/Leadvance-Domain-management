"use client";

import { Dialog } from "radix-ui";
import { TriangleAlert } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { changeStatus } from "@/app/actions";
import { DOMAIN_STATUSES, NEXT_STATUSES, STATUS_META, type DomainStatus } from "@/lib/status";

export function ChangeStatusDialog({
  open,
  onOpenChange,
  targets,
  initialTo,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targets: { id: string; status: DomainStatus }[];
  initialTo?: DomainStatus;
  onDone?: () => void;
}) {
  const [to, setTo] = useState<DomainStatus | "">(initialTo ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Reset when reopened with a different target status.
  const [lastOpen, setLastOpen] = useState(open);
  if (lastOpen !== open) {
    setLastOpen(open);
    if (open) {
      setTo(initialTo ?? "");
      setReason("");
      setError(null);
    }
  }

  const blocked = useMemo(
    () => (to ? targets.filter((t) => t.status !== to && !NEXT_STATUSES[t.status].includes(to)) : []),
    [targets, to],
  );
  const force = blocked.length > 0;
  const canSubmit = to !== "" && (!force || reason.trim().length > 0);

  const submit = () =>
    startTransition(async () => {
      if (!to) return;
      const res = await changeStatus({ ids: targets.map((t) => t.id), to, reason: reason || undefined, force });
      if (!res.ok) return setError(res.error);
      onOpenChange(false);
      onDone?.();
      toast.success(`Moved ${res.data.changed} domain${res.data.changed === 1 ? "" : "s"} to ${STATUS_META[to].label}`);
    });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog">
          <div className="dialog-head">
            <Dialog.Title className="dialog-title">Change status</Dialog.Title>
            <Dialog.Description className="dialog-desc">
              {targets.length} domain{targets.length === 1 ? "" : "s"}. Every change is logged in the domain&apos;s history.
            </Dialog.Description>
          </div>
          <div className="dialog-body">
            <label className="field">
              <span className="field-label">Move to</span>
              <select className="select" value={to} onChange={(e) => setTo(e.target.value as DomainStatus)}>
                <option value="" disabled>Choose a status</option>
                {DOMAIN_STATUSES.map((s) => (
                  <option key={s} value={s}>{STATUS_META[s].label} — {STATUS_META[s].hint}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Reason {force ? null : <span className="zero">(optional)</span>}</span>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Blacklisted on Spamhaus" maxLength={500} />
            </label>
            {force ? (
              <div className="callout tone-warning">
                <TriangleAlert size={15} strokeWidth={1.75} />
                <span>
                  {blocked.length} of these skip the normal lifecycle (for example {STATUS_META[blocked[0].status].label} → {STATUS_META[to as DomainStatus].label}).
                  This is saved as an override and needs a reason.
                </span>
              </div>
            ) : null}
            {error ? <div className="callout tone-danger" role="alert"><TriangleAlert size={15} strokeWidth={1.75} /><span>{error}</span></div> : null}
          </div>
          <div className="dialog-foot">
            <span className="spacer" />
            <Dialog.Close asChild><button type="button" className="btn">Cancel</button></Dialog.Close>
            <button type="button" className="btn btn-primary" disabled={!canSubmit || pending} onClick={submit}>
              {pending ? "Saving…" : force ? "Override and move" : "Move"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
