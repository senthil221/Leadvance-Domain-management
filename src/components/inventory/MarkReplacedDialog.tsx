"use client";

import { Dialog } from "radix-ui";
import { Info, TriangleAlert } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { markReplaced } from "@/app/actions";

// For old data: records domains as replaced without running a replacement.
export function MarkReplacedDialog({ open, onOpenChange, targets, onDone }: {
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
      const r = await markReplaced({ ids: targets.map((t) => t.id), note });
      if (!r.ok) return void setError(r.error);
      onOpenChange(false);
      setNote("");
      onDone?.();
      toast.success(`Marked ${r.data.changed} domain${r.data.changed === 1 ? "" : "s"} as replaced`);
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog">
          <div className="dialog-head">
            <Dialog.Title className="dialog-title">Mark {n} domain{n === 1 ? "" : "s"} as replaced</Dialog.Title>
            <Dialog.Description className="dialog-desc">
              {targets.slice(0, 4).map((t) => t.name).join(", ")}{n > 4 ? ` and ${n - 4} more` : ""}
            </Dialog.Description>
          </div>
          <div className="dialog-body">
            <label className="field" htmlFor="replaced-note">
              <span className="field-label">Note (optional)</span>
              <input id="replaced-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. replaced in March, before this app" maxLength={300} />
            </label>
            <div className="callout tone-info">
              <Info size={15} strokeWidth={1.75} />
              <span>They move to Replaced and stop counting as active or free. Nothing changes in Smartlead, Hypertide or the registrar, and each move is kept in the domain&apos;s history.</span>
            </div>
            {error ? <div className="callout tone-danger" role="alert"><TriangleAlert size={15} strokeWidth={1.75} /><span>{error}</span></div> : null}
          </div>
          <div className="dialog-foot">
            <span className="spacer" />
            <Dialog.Close asChild><button type="button" className="btn">Cancel</button></Dialog.Close>
            <button type="button" className="btn btn-primary" disabled={pending || n === 0} onClick={submit}>{pending ? "Saving…" : "Mark as replaced"}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
