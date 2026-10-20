"use client";

import { Dialog } from "radix-ui";
import { CreditCard } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { approveHypertidePayment } from "@/app/actions";

// Paying Hypertide is the one step that spends money, so it only ever happens
// from this button, after a confirmation that says exactly what is charged.
export function ApprovePayment({ itemIds, domains }: { itemIds: string[]; domains: string[] }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const n = itemIds.length;

  const confirm = () =>
    start(async () => {
      const r = await approveHypertidePayment(itemIds);
      setOpen(false);
      if (!r.ok) return void toast.error(r.error);
      if (r.data.dryRun) toast("Dry run: Hypertide checked the payment, nothing was charged", { description: "Turn dry run off to pay for real." });
      else toast.success(`Paid for ${r.data.charged} order${r.data.charged === 1 ? "" : "s"}`, { description: "Hypertide will set up the inboxes once it sees the new nameservers." });
    });

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className="btn btn-sm btn-primary"><CreditCard size={12} /> Approve payment{n > 1 ? ` (${n})` : ""}</button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog">
          <div className="dialog-head">
            <Dialog.Title className="dialog-title">Pay for {n} Hypertide order{n === 1 ? "" : "s"}?</Dialog.Title>
            <Dialog.Description className="dialog-desc">
              This charges the card saved in your Hypertide account, at your Hypertide price, for:
            </Dialog.Description>
          </div>
          <div className="dialog-body">
            <ul className="mono flex flex-col gap-1 text-ink" style={{ maxHeight: 200, overflowY: "auto" }}>
              {domains.map((d) => <li key={d}>{d}</li>)}
            </ul>
            <p className="field-hint">The charge is a monthly subscription per domain at Hypertide. Cancel it there if a domain is retired.</p>
          </div>
          <div className="dialog-foot">
            <span className="spacer" />
            <Dialog.Close asChild><button type="button" className="btn">Cancel</button></Dialog.Close>
            <button type="button" className="btn btn-primary" disabled={pending} onClick={confirm}>
              {pending ? "Charging…" : `Charge for ${n} order${n === 1 ? "" : "s"}`}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
