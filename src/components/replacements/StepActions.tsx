"use client";

import { Check, RotateCw } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { actOnReplacementStep } from "@/app/actions";
import type { StepStatus } from "@/lib/status";

const LABEL = { nameservers: "Nameservers", inboxes: "Inboxes", smartlead: "Smartlead", campaigns: "Campaigns" } as const;
type Step = keyof typeof LABEL;

// Buttons for the step a replacement is waiting on.
export function StepActions({ itemId, step, status, compact = false }: { itemId: string; step: Step; status: StepStatus; compact?: boolean }) {
  const [pending, start] = useTransition();
  const act = (action: "done" | "retry") =>
    start(async () => {
      const r = await actOnReplacementStep({ itemId, step, action });
      if (!r.ok) return void toast.error(r.error);
      if (r.data.completed) toast.success("Replacement finished", { description: "The new domain is live and the old one is draining." });
      else if (action === "done") toast.success(`${LABEL[step]} marked done`);
      else toast(`Retrying ${LABEL[step].toLowerCase()}`);
    });

  const canRetry = status === "failed" || (status === "manual" && step === "nameservers");
  return (
    <span className="flex items-center gap-1.5">
      {canRetry ? (
        <button type="button" className="btn btn-sm" disabled={pending} onClick={() => act("retry")}>
          <RotateCw size={12} className={pending ? "animate-spin" : undefined} /> Retry
        </button>
      ) : null}
      <button type="button" className="btn btn-sm" disabled={pending} onClick={() => act("done")} title={`Mark ${LABEL[step].toLowerCase()} done`}>
        <Check size={12} /> {compact ? "Done" : `Mark ${LABEL[step].toLowerCase()} done`}
      </button>
    </span>
  );
}
