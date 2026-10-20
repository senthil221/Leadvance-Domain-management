"use client";

import { Dialog } from "radix-ui";
import { ArrowRight, Info, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { loadStorageCandidates, startReplacement } from "@/app/actions";
import { ClientCell, Skeleton } from "@/components/ui";
import { hypertideAcceptsDomain } from "@/integrations/hypertide";
import type { StorageCandidate } from "@/lib/queries";
import { REPLACEMENT_REASONS, type ReplacementReason } from "@/lib/status";

export type ReplaceTarget = { id: string; name: string; tld: string | null; clientName: string | null; clientHue: number | null };

// One storage domain per old domain: same TLD first, then the oldest purchase.
// Domains Hypertide refuses (hyphens, over 35 characters) are never auto-picked.
function autoAssign(targets: ReplaceTarget[], candidates: StorageCandidate[]) {
  const free = candidates.filter((c) => hypertideAcceptsDomain(c.name));
  const out: Record<string, string> = {};
  for (const t of targets) {
    let i = free.findIndex((c) => c.tld === t.tld);
    if (i < 0) i = 0;
    if (free[i]) {
      out[t.id] = free[i].id;
      free.splice(i, 1);
    }
  }
  return out;
}

export function ReplaceDialog({
  open,
  onOpenChange,
  targets,
  defaultReason = "high_bounce",
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targets: ReplaceTarget[];
  defaultReason?: ReplacementReason;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [candidates, setCandidates] = useState<StorageCandidate[] | null>(null);
  const [assign, setAssign] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<ReplacementReason>(defaultReason);
  const [note, setNote] = useState("");
  const [manualInboxes, setManualInboxes] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Start clean each time the dialog opens for a new set of domains.
  const targetKey = targets.map((t) => t.id).join(",");
  const openKey = open ? targetKey : null;
  const [lastKey, setLastKey] = useState<string | null>(null);
  if (openKey !== lastKey) {
    setLastKey(openKey);
    if (openKey !== null) {
      setCandidates(null);
      setError(null);
      setReason(defaultReason);
      setNote("");
    }
  }

  // Fresh candidates every time it opens: storage changes under us.
  useEffect(() => {
    if (!open) return;
    let live = true;
    loadStorageCandidates().then((c) => {
      if (!live) return;
      setCandidates(c);
      setAssign(autoAssign(targets, c));
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetKey]);

  const used = useMemo(() => new Set(Object.values(assign)), [assign]);
  const short = candidates ? Math.max(0, targets.length - candidates.length) : 0;
  const ready = candidates !== null && short === 0 && targets.every((t) => assign[t.id]);

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const res = await startReplacement({
        oldIds: targets.map((t) => t.id),
        newIds: targets.map((t) => assign[t.id]),
        reason,
        note: note || undefined,
        manualInboxes,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onOpenChange(false);
      onDone?.();
      toast.success(`Replacing ${targets.length} domain${targets.length === 1 ? "" : "s"}`, {
        description: "Setup has started. You can follow each step in Replacements.",
        action: { label: "View", onClick: () => router.push("/replacements") },
      });
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog is-wide">
          <div className="dialog-head">
            <Dialog.Title className="dialog-title">
              Replace {targets.length} domain{targets.length === 1 ? "" : "s"}
            </Dialog.Title>
            <Dialog.Description className="dialog-desc">
              Each one gets a free domain from storage, set up for the same client.
            </Dialog.Description>
          </div>

          <div className="dialog-body">
            <div className="grid gap-3 sm:grid-cols-[220px_1fr]">
              <label className="field">
                <span className="field-label">Reason</span>
                <select className="select" value={reason} onChange={(e) => setReason(e.target.value as ReplacementReason)}>
                  {Object.entries(REPLACEMENT_REASONS).map(([k, label]) => (
                    <option key={k} value={k}>{label}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Note <span className="zero">(optional)</span></span>
                <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Bounce over 4% on the staffing campaign" maxLength={1000} />
              </label>
            </div>

            <div className="card">
              <div className="card-head">
                <span className="card-title">Replacements</span>
                <span className="card-sub">{candidates ? `${candidates.length} in storage` : "Checking storage…"}</span>
              </div>
              <div className="card-body" style={{ paddingTop: 4, paddingBottom: 4, maxHeight: 300, overflowY: "auto" }}>
                {targets.map((t) => (
                  <div key={t.id} className="pair-row">
                    <div className="pair-side">
                      <span className="list-title">{t.name}</span>
                      <span className="list-meta"><ClientCell name={t.clientName} hue={t.clientHue} /></span>
                    </div>
                    <ArrowRight size={14} strokeWidth={1.5} />
                    {candidates === null ? (
                      <Skeleton h={30} />
                    ) : (
                      <select
                        className="select"
                        aria-label={`New domain for ${t.name}`}
                        value={assign[t.id] ?? ""}
                        onChange={(e) => setAssign((a) => ({ ...a, [t.id]: e.target.value }))}
                      >
                        {!assign[t.id] && <option value="">No domain available</option>}
                        {candidates
                          .filter((c) => c.id === assign[t.id] || !used.has(c.id))
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}{c.registrar ? ` · ${c.registrar}` : ""}{hypertideAcceptsDomain(c.name) ? "" : " · Hypertide won't accept"}
                            </option>
                          ))}
                      </select>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <label className="flex items-start gap-2">
              <input type="checkbox" className="checkbox mt-0.5" checked={manualInboxes} onChange={(e) => setManualInboxes(e.target.checked)} />
              <span>
                I&apos;ll order the inboxes on Hypertide myself
                <span className="field-hint block">The app still sets the nameservers, and ticks the inbox step off when the Hypertide order shows Done.</span>
              </span>
            </label>

            {short > 0 ? (
              <div className="callout tone-warning">
                <TriangleAlert size={15} strokeWidth={1.75} />
                <span>Storage has {candidates?.length ?? 0} free domains, {short} short. Add domains in Inventory first, or replace fewer.</span>
              </div>
            ) : (
              <div className="callout tone-info">
                <Info size={15} strokeWidth={1.75} />
                <span>
                  Next: nameservers point to Hypertide, inboxes are {manualInboxes ? "ordered by you" : "ordered by the app"} with the same sender names,
                  connected to Smartlead, then added to the old domain&apos;s campaigns. Old domains drain, then retire automatically.
                </span>
              </div>
            )}
            {error ? (
              <div className="callout tone-danger" role="alert">
                <TriangleAlert size={15} strokeWidth={1.75} />
                <span>{error}</span>
              </div>
            ) : null}
          </div>

          <div className="dialog-foot">
            <span className="spacer" />
            <Dialog.Close asChild>
              <button type="button" className="btn">Cancel</button>
            </Dialog.Close>
            <button type="button" className="btn btn-primary" disabled={!ready || pending} onClick={submit}>
              {pending ? "Starting…" : `Replace ${targets.length} domain${targets.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
