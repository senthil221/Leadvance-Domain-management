"use client";

import { Check, RotateCw, Shuffle, X } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { actOnReplacementStep, cancelReplacementItem, swapReplacementDomain } from "@/app/actions";

// Calls off a replacement that won't go ahead. A second click within a few
// seconds confirms, so one stray click can't cancel it.
export function CancelReplacement({ itemId, newDomain, oldDomain, compact = false }: { itemId: string; newDomain: string; oldDomain: string; compact?: boolean }) {
  const [pending, start] = useTransition();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  const cancel = () =>
    start(async () => {
      setArmed(false);
      const r = await cancelReplacementItem(itemId);
      if (!r.ok) return void toast.error(r.error);
      toast.success(`Replacement of ${r.data.from} cancelled`, {
        description: `${r.data.to} is back in storage; ${r.data.from} stays as it is.`
          + (r.data.openRequest ? ` Hypertide still holds the swap request: cancel it in Hypertide's dashboard.` : ""),
      });
    });
  return (
    <button type="button" className={`btn btn-sm ${armed ? "btn-danger" : ""}`} disabled={pending}
      onClick={() => (armed ? cancel() : setArmed(true))}
      title={`Call off this replacement: ${newDomain} goes back to storage and ${oldDomain} stays as it is`}>
      <X size={12} /> {armed ? "Sure? Cancel" : compact ? "Cancel" : "Cancel replacement"}
    </button>
  );
}
import type { StepStatus } from "@/lib/status";

const LABEL = { nameservers: "Nameservers", inboxes: "Inboxes", smartlead: "Smartlead", campaigns: "Campaigns" } as const;
type Step = keyof typeof LABEL;

// Buttons for the step a replacement is waiting on.
// openRequest: Hypertide already holds a replacement request for this pair,
// which only Hypertide's dashboard can cancel.
export function StepActions({ itemId, step, status, compact = false, canSwap = false, openRequest = false }: { itemId: string; step: Step; status: StepStatus; compact?: boolean; canSwap?: boolean; openRequest?: boolean }) {
  const [pending, start] = useTransition();
  const act = (action: "done" | "retry") =>
    start(async () => {
      const r = await actOnReplacementStep({ itemId, step, action });
      if (!r.ok) return void toast.error(r.error);
      if (r.data.completed) toast.success("Replacement finished", { description: "The new domain is live and the old one is draining." });
      else if (action === "done") toast.success(`${LABEL[step]} marked done`);
      else toast(`Retrying ${LABEL[step].toLowerCase()}`);
    });

  const swap = () =>
    start(async () => {
      const r = await swapReplacementDomain(itemId);
      if (!r.ok) return void toast.error(r.error);
      toast.success(`Swapped ${r.data.from} for ${r.data.to}`, {
        description: `${r.data.from} is back in storage. The replacement starts again with ${r.data.to}.`
          + (r.data.droppedRequest ? ` If Hypertide still has the request for ${r.data.from}, it will refuse this one until you cancel that.` : ""),
      });
    });

  // A manual inboxes step re-checks the Hypertide order settings on Retry; an
  // order already placed is never placed twice.
  const canRetry = status === "failed" || (status === "manual" && (step === "nameservers" || step === "inboxes"));
  return (
    <span className="flex items-center gap-1.5">
      {canRetry ? (
        <button type="button" className="btn btn-sm" disabled={pending} onClick={() => act("retry")}>
          <RotateCw size={12} className={pending ? "animate-spin" : undefined} /> Retry
        </button>
      ) : null}
      {canSwap && status === "failed" ? (
        <button type="button" className="btn btn-sm" disabled={pending} onClick={swap}
          title={openRequest
            ? "The nameservers can't be set on this domain. Cancel its replacement request in Hypertide first, then swap: it goes back to storage and the replacement starts again with the next free domain"
            : "Hypertide won't take this domain: put it back in storage and start again with the next free domain"}>
          <Shuffle size={12} /> {compact ? "Swap" : "Swap domain"}
        </button>
      ) : null}
      <button type="button" className="btn btn-sm" disabled={pending} onClick={() => act("done")} title={`Mark ${LABEL[step].toLowerCase()} done`}>
        <Check size={12} /> {compact ? "Done" : `Mark ${LABEL[step].toLowerCase()} done`}
      </button>
    </span>
  );
}
