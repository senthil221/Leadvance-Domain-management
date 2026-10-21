"use client";

import { Dialog } from "radix-ui";
import { Info, TriangleAlert } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { markReplaced } from "@/app/actions";

// Records domains as replaced (old data) or moves them to recovery, without
// touching Smartlead, Hypertide or the registrar.
export function MarkReplacedDialog({ to, open, onOpenChange, targets, onDone }: {
  to: "replaced" | "recovery";
  open: boolean;
  onOpenChange: (o: boolean) => void;
  targets: { id: string; name: string }[];
  onDone?: () => void;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const n = targets.length;

  const submit = () => {
    setError(null);
    start(async () => {
      const r = await markReplaced({ ids: targets.map((t) => t.id), note, to });
      if (!r.ok) return void setError(r.error);
      onOpenChange(false);
      setNote("");
      onDone?.();
      toast.success(`${to === "recovery" ? "Moved" : "Marked"} ${r.data.changed} domain${r.data.changed === 1 ? "" : "s"} ${to === "recovery" ? "to recovery" : "as replaced"}`);
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog">
          <div className="dialog-head">
            <Dialog.Title className="dialog-title">{to === "recovery" ? "Move" : "Mark"} {n} domain{n === 1 ? "" : "s"} {to === "recovery" ? "to recovery" : "as replaced"}</Dialog.Title>
            <Dialog.Description className="dialog-desc">
              {targets.slice(0, 4).map((t) => t.name).join(", ")}{n > 4 ? ` and ${n - 4} more` : ""}
            </Dialog.Description>
          </div>
          <div className="dialog-body">
            <label className="field" htmlFor="replaced-note">
              <span className="field-label">Note (optional)</span>
              <input id="replaced-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={to === "recovery" ? "e.g. resting until reputation recovers" : "e.g. replaced in March, before this app"} maxLength={300} />
            </label>
            <div className="callout tone-info">
              <Info size={15} strokeWidth={1.75} />
              <span>{to === "recovery" ? "They move to Recovery: resting, and not counted as active, free or replaced." : "They move to Replaced and stop counting as active or free."} Nothing changes in Smartlead, Hypertide or the registrar, and each move is kept in the domain&apos;s history.</span>
            </div>
            {error ? <div className="callout tone-danger" role="alert"><TriangleAlert size={15} strokeWidth={1.75} /><span>{error}</span></div> : null}
          </div>
          <div className="dialog-foot">
            <span className="spacer" />
            <Dialog.Close asChild><button type="button" className="btn">Cancel</button></Dialog.Close>
            <button type="button" className="btn btn-primary" disabled={pending || n === 0} onClick={submit}>{pending ? "Saving…" : to === "recovery" ? "Move to recovery" : "Mark as replaced"}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
