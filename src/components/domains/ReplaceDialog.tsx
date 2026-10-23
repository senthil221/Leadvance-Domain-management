"use client";

import { Dialog } from "radix-ui";
import { ArrowRight, Info, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { loadReplaceOptions, startReplacement } from "@/app/actions";
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

// "John Smith" per line → { firstName, lastName }; a single word is used for both.
function parseNames(text: string) {
  const seen = new Set<string>();
  const out: { firstName: string; lastName: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [first, ...rest] = line.trim().split(/\s+/).filter(Boolean);
    if (!first) continue;
    const key = line.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ firstName: first, lastName: rest.join(" ") || first });
  }
  return out;
}

function Check({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <label className="flex items-start gap-2">
      <input type="checkbox" className="checkbox mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        <span className="field-hint block">{hint}</span>
      </span>
    </label>
  );
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
  // Old domains whose Hypertide order is Done: the only ones Hypertide replaces.
  const [htDone, setHtDone] = useState<Set<string> | null>(null);
  const [assign, setAssign] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<ReplacementReason>(defaultReason);
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<"hypertide" | "manual">("hypertide");
  const [copyTagsAndWarmup, setCopyTagsAndWarmup] = useState(true);
  const [changeNames, setChangeNames] = useState(false);
  const [namesText, setNamesText] = useState("");
  const [stopOldSending, setStopOldSending] = useState(true);
  const [addToCampaigns, setAddToCampaigns] = useState(false);
  const [autoWarmup, setAutoWarmup] = useState(true);
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
    loadReplaceOptions(targets.map((t) => t.id)).then(({ candidates: c, hypertideDone }) => {
      if (!live) return;
      const done = new Set(hypertideDone);
      setCandidates(c);
      setHtDone(done);
      // Domains Hypertide can replace get first pick of the free domains.
      setAssign(autoAssign([...targets].sort((a, b) => Number(done.has(b.id)) - Number(done.has(a.id))), c));
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetKey]);

  const used = useMemo(() => new Set(Object.values(assign)), [assign]);
  // In a Hypertide replacement, domains without a Done order are left out.
  const skipped = useMemo(() => new Set(mode === "hypertide" && htDone ? targets.filter((t) => !htDone.has(t.id)).map((t) => t.id) : []), [mode, htDone, targets]);
  const going = targets.filter((t) => !skipped.has(t.id));
  const short = candidates ? Math.max(0, going.length - candidates.length) : 0;
  const names = useMemo(() => parseNames(namesText), [namesText]);
  const namesOk = !changeNames || (names.length >= 1 && names.length <= 25);
  const refused = mode === "hypertide" && candidates
    ? going.filter((t) => assign[t.id] && !hypertideAcceptsDomain(candidates.find((c) => c.id === assign[t.id])?.name ?? "")).length
    : 0;
  const ready = candidates !== null && going.length > 0 && short === 0 && going.every((t) => assign[t.id]) && namesOk && refused === 0;

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const hypertide = mode === "hypertide";
      const res = await startReplacement({
        oldIds: going.map((t) => t.id),
        newIds: going.map((t) => assign[t.id]),
        reason,
        note: note || undefined,
        manualInboxes: !hypertide,
        hypertideReplace: hypertide,
        copyTagsAndWarmup,
        usernames: hypertide && changeNames ? names : undefined,
        stopOldSending,
        addToCampaigns,
        autoWarmup,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onOpenChange(false);
      onDone?.();
      toast.success(`Replacing ${going.length} domain${going.length === 1 ? "" : "s"}`, {
        description: skipped.size
          ? `${skipped.size} skipped: no finished Hypertide order. Follow the rest in Replacements.`
          : "Setup has started. You can follow each step in Replacements.",
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
                <span className="card-sub">{candidates ? `${candidates.length} in storage${skipped.size ? ` · ${skipped.size} skipped` : ""}` : "Checking storage…"}</span>
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
                    ) : skipped.has(t.id) ? (
                      <span className="text-[12.5px] text-warning-ink" title="Hypertide only replaces domains whose order is Done. Replace this one by hand, or with I'll do it in Hypertide.">
                        Skipped: Hypertide order isn&apos;t Done
                      </span>
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

            <div className="field">
              <span className="field-label">Inboxes</span>
              <div className="seg cfg-seg" role="group" aria-label="How the inboxes move">
                <button type="button" aria-pressed={mode === "hypertide"} onClick={() => setMode("hypertide")}>Replace on Hypertide</button>
                <button type="button" aria-pressed={mode === "manual"} onClick={() => setMode("manual")}>I&apos;ll do it in Hypertide</button>
              </div>
              <span className="field-hint">
                {mode === "hypertide"
                  ? "The app sends the swap to Hypertide (no new order, no payment), sets the nameservers it returns at Porkbun and follows it until the inboxes are in Smartlead."
                  : "The app sets the nameservers and ticks the inbox step off when the new domain's Hypertide order shows Done."}
              </span>
            </div>

            <div className="grid gap-2">
              {mode === "hypertide" ? (
                <>
                  <Check checked={copyTagsAndWarmup} onChange={setCopyTagsAndWarmup} label="Copy tags and warmup to the new inboxes" hint="Hypertide copies them from the old inboxes; paused warmup stays paused." />
                  <Check checked={changeNames} onChange={setChangeNames} label="Change the sender names" hint="Off keeps the old domain's names." />
                  {changeNames ? (
                    <label className="field" style={{ marginLeft: 24 }}>
                      <span className="field-label">One name per line, first and last <span className="zero">({names.length}/25)</span></span>
                      <textarea className="textarea" rows={4} value={namesText} onChange={(e) => setNamesText(e.target.value)} placeholder={"John Smith\nSarah Jones"} />
                      <span className="field-hint">Hypertide spreads 25 inboxes across these names. Names you leave out are removed.</span>
                    </label>
                  ) : null}
                </>
              ) : null}
              <Check checked={autoWarmup} onChange={setAutoWarmup} label="Turn warmup on for the new inboxes" hint="As soon as they're in Smartlead, using the old domain's warmup numbers. The new domain is tagged New until it joins campaigns." />
              <Check checked={addToCampaigns} onChange={setAddToCampaigns} label="Add the new inboxes to campaigns straight away" hint="Only for domains that are already warmed up. Otherwise they warm first and you add them from Replacements when they're ready." />
              <Check checked={stopOldSending} onChange={setStopOldSending} label="Stop sending from the old domain when the new one is live" hint="Its daily limit goes to 0 once the new inboxes are in Smartlead. Either way it's tagged Replaced with an 18-day countdown from the swap, while Hypertide keeps its inboxes up for replies." />
            </div>

            {short > 0 ? (
              <div className="callout tone-warning">
                <TriangleAlert size={15} strokeWidth={1.75} />
                <span>Storage has {candidates?.length ?? 0} free domains, {short} short. Add domains in Inventory first, or replace fewer.</span>
              </div>
            ) : refused > 0 ? (
              <div className="callout tone-warning">
                <TriangleAlert size={15} strokeWidth={1.75} />
                <span>Hypertide won&apos;t take {refused === 1 ? "one of the new domains" : `${refused} of the new domains`} (no hyphens, 35 characters at most). Pick another.</span>
              </div>
            ) : (
              <div className="callout tone-info">
                <Info size={15} strokeWidth={1.75} />
                <span>
                  Nothing goes to Hypertide until you press Replace. Only domains whose Hypertide order is Done can be replaced there.
                  Follow each step in Replacements.
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
              {pending ? "Starting…" : `Replace ${going.length} domain${going.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
