"use client";

import { Dialog } from "radix-ui";
import { Megaphone, TriangleAlert } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { addReplacementToCampaigns } from "@/app/actions";

// Puts a replacement's warmed-up inboxes into the old domain's campaigns.
// It changes live campaigns, so it confirms first and says if they look unready.
export function AddToCampaigns({ itemId, domain, campaigns, inboxes, warmupOn, reputation }: {
  itemId: string; domain: string; campaigns: string[]; inboxes: number; warmupOn: number; reputation: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const concerns = [
    warmupOn < inboxes ? `Warmup is off on ${inboxes - warmupOn} of ${inboxes} inboxes.` : null,
    reputation == null ? "No warmup reputation yet." : reputation < 95 ? `Warmup reputation is ${reputation}%.` : null,
  ].filter(Boolean) as string[];

  const confirm = () =>
    start(async () => {
      const r = await addReplacementToCampaigns(itemId);
      if (!r.ok) return void toast.error(r.error);
      setOpen(false);
      toast.success(`${domain} is in ${r.data.campaigns} campaign${r.data.campaigns === 1 ? "" : "s"}`, { description: `${r.data.inboxes} inboxes added. The domain is now Active.` });
    });

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className="btn btn-sm"><Megaphone size={12} /> Add to campaigns</button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog">
          <div className="dialog-head">
            <Dialog.Title className="dialog-title">Add {domain} to campaigns</Dialog.Title>
            <Dialog.Description className="dialog-desc">
              Its {inboxes} inboxes join {campaigns.length === 1 ? "this campaign" : `these ${campaigns.length} campaigns`} in Smartlead and start sending.
            </Dialog.Description>
          </div>
          <div className="dialog-body">
            <ul className="flex flex-col gap-1 text-[13px]">
              {campaigns.map((c) => <li key={c} className="truncate">{c}</li>)}
            </ul>
            {concerns.length ? (
              <div className="callout tone-warning">
                <TriangleAlert size={15} strokeWidth={1.75} />
                <span>{concerns.join(" ")} New inboxes usually need about two weeks of warmup first.</span>
              </div>
            ) : null}
          </div>
          <div className="dialog-foot">
            <span className="spacer" />
            <Dialog.Close asChild><button type="button" className="btn">Cancel</button></Dialog.Close>
            <button type="button" className="btn btn-primary" disabled={pending} onClick={confirm}>
              {pending ? "Adding…" : "Add to campaigns"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
