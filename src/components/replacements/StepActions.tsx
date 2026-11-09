"use client";

import { Check, RotateCw, Shuffle } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { actOnReplacementStep, swapReplacementDomain } from "@/app/actions";
import type { StepStatus } from "@/lib/status";

const LABEL = { nameservers: "Nameservers", inboxes: "Inboxes", smartlead: "Smartlead", campaigns: "Campaigns" } as const;
type Step = keyof typeof LABEL;

// Buttons for the step a replacement is waiting on.
export function StepActions({ itemId, step, status, compact = false, canSwap = false }: { itemId: string; step: Step; status: StepStatus; compact?: boolean; canSwap?: boolean }) {
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
      toast.success(`Swapped ${r.data.from} for ${r.data.to}`, { description: `${r.data.from} is back in storage. The replacement starts again with ${r.data.to}.` });
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
          title="Hypertide won't take this domain: put it back in storage and start again with the next free domain">
          <Shuffle size={12} /> {compact ? "Swap" : "Swap domain"}
        </button>
      ) : null}
      <button type="button" className="btn btn-sm" disabled={pending} onClick={() => act("done")} title={`Mark ${LABEL[step].toLowerCase()} done`}>
        <Check size={12} /> {compact ? "Done" : `Mark ${LABEL[step].toLowerCase()} done`}
      </button>
    </span>
  );
}
