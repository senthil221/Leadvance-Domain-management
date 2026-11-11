"use client";

import { Dialog } from "radix-ui";
import { ArrowRight, Check as CheckIcon, Info, Search, TriangleAlert, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { loadReplaceOptions, startReplacement } from "@/app/actions";
import { ClientCell, Skeleton } from "@/components/ui";
import { hypertideAcceptsDomain } from "@/integrations/hypertide";
import { ageLabel, daysSince } from "@/lib/format";
import { dnsHost } from "@/lib/lifecycle";
import type { StorageCandidate } from "@/lib/queries";
import { REPLACEMENT_REASONS, type ReplacementReason } from "@/lib/status";
import { Select } from "@/components/Select";

export type ReplaceTarget = { id: string; name: string; tld: string | null; clientName: string | null; clientHue: number | null };

// One storage domain per old domain. Free domains (never used, on the
// registrar's nameservers) first, then rested ones used before; within each,
// the same TLD first, otherwise the oldest. A domain whose nameservers still
// point at an earlier setup, or that Hypertide refuses (hyphens, over 35
// characters), is never auto-picked: it can still be picked by hand.
export function autoAssign(targets: ReplaceTarget[], candidates: StorageCandidate[]) {
  const usable = candidates.filter((c) => hypertideAcceptsDomain(c.name) && !c.setUpElsewhere?.length);
  const tiers = [usable.filter((c) => c.free), usable.filter((c) => !c.free)];
  const out: Record<string, string> = {};
  for (const t of targets) {
    const tier = tiers.find((x) => x.length);
    if (!tier) break;
    let i = tier.findIndex((c) => c.tld === t.tld);
    if (i < 0) i = 0;
    out[t.id] = tier[i].id;
    tier.splice(i, 1);
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

const lastUsed = (d: Date | null) => (d ? `used ${new Date(d).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })}` : "never used");

/** Storage's rested domains, searchable by name and TLD: click one to swap it in, click a picked one to put it back. */
function FreeDomains({ candidates, assign, targets, hypertide, onPick }: {
  candidates: StorageCandidate[] | null; assign: Record<string, string>; targets: ReplaceTarget[]; hypertide: boolean; onPick: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [tld, setTld] = useState("");
  const holder = useMemo(() => new Map(Object.entries(assign).map(([t, c]) => [c, targets.find((x) => x.id === t)?.name ?? ""])), [assign, targets]);
  const tlds = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of candidates ?? []) if (c.tld) m.set(c.tld, (m.get(c.tld) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [candidates]);
  const needle = q.trim().toLowerCase();
  const list = (candidates ?? []).filter((c) => (!tld || c.tld === tld) && (!needle || c.name.includes(needle)));
  return (
    <div className="card rp-free">
      <div className="card-head">
        <span className="card-title">Free domains</span>
        <span className="card-sub">{candidates ? `${candidates.filter((c) => c.free).length} free · ${candidates.length} in storage · ${holder.size} picked` : "Loading…"}</span>
      </div>
      <div className="rp-free-tools">
        <label className="search-input">
          <Search size={14} strokeWidth={1.5} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search free domains" aria-label="Search free domains" />
        </label>
        {tlds.length > 1 ? (
          <Select className="select" value={tld} onChange={(e) => setTld(e.target.value)} aria-label="Filter by TLD">
            <option value="">All TLDs</option>
            {tlds.map(([k, n]) => <option key={k} value={k}>.{k} ({n})</option>)}
          </Select>
        ) : null}
      </div>
      <div className="rp-list" role="listbox" aria-label="Free domains" aria-multiselectable>
        {candidates === null ? <div style={{ padding: 12 }}><Skeleton h={22} /></div>
          : !list.length ? <p className="rv-none" style={{ padding: "10px 12px" }}>{candidates.length ? "No free domain matches." : "Storage is empty: add domains in Inventory first."}</p>
          : list.map((c) => {
            const by = holder.get(c.id);
            return (
              <button key={c.id} type="button" role="option" aria-selected={!!by} className="rp-free-row" data-on={by ? true : undefined} onClick={() => onPick(c.id)}
                title={by ? `Picked for ${by}: click to put it back` : "Click to swap it in"}>
                <span className="rp-tick" aria-hidden>{by ? <CheckIcon size={11} strokeWidth={2.5} /> : null}</span>
                <span className="rp-side">
                  <span className="list-title">{c.name}</span>
                  <span className="list-meta">{by ? <>for {by}</> : <>{c.bornAt ? `${ageLabel(daysSince(c.bornAt))} old · ` : null}{c.registrar ?? "no registrar account"} · {lastUsed(c.lastUsedOn)}</>}</span>
                </span>
                {c.setUpElsewhere?.length ? <span className="badge tone-warning" title={`Its nameservers still point at ${dnsHost(c.setUpElsewhere) ?? c.setUpElsewhere.join(", ")} (${c.setUpElsewhere.join(", ")}), left from an earlier setup. Auto-pick passes it by; check it isn't still in use before picking it.`}>Set up elsewhere</span>
                  : !c.free && c.lastUsedOn ? <span className="badge" title="Used before and rested: auto-pick takes never-used domains first">Used before</span> : null}
                {hypertide && !hypertideAcceptsDomain(c.name) ? <span className="badge tone-warning" title="Hypertide takes no hyphens and 35 characters at most">Hypertide won&apos;t accept</span> : null}
              </button>
            );
          })}
      </div>
    </div>
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
  // One or more reasons, in the order picked: the first is the main one.
  const [reasons, setReasons] = useState<ReplacementReason[]>([defaultReason]);
  const toggleReason = (k: ReplacementReason) => setReasons((r) => (r.includes(k) ? r.filter((x) => x !== k) : [...r, k]));
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<"hypertide" | "manual">("hypertide");
  const [copyTagsAndWarmup, setCopyTagsAndWarmup] = useState(true);
  const [changeNames, setChangeNames] = useState(false);
  const [namesText, setNamesText] = useState("");
  // Off: the old domain keeps sending through its grace period, so every last reply counts.
  const [stopOldSending, setStopOldSending] = useState(false);
  const [addToCampaigns, setAddToCampaigns] = useState(false);
  const [autoWarmup, setAutoWarmup] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The old domain the next click in the free list goes to.
  const [active, setActive] = useState<string | null>(null);
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
      setReasons([defaultReason]);
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
      const first = autoAssign([...targets].sort((a, b) => Number(done.has(b.id)) - Number(done.has(a.id))), c);
      setAssign(first);
      setActive(targets.find((t) => !first[t.id])?.id ?? targets[0]?.id ?? null);
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
  const nextOpen = (a: Record<string, string>, after?: string) => {
    const open = going.filter((t) => !a[t.id]);
    const i = after ? going.findIndex((t) => t.id === after) : -1;
    return (open.find((t) => going.indexOf(t) > i) ?? open[0])?.id ?? null;
  };
  const unpick = (tid: string) => {
    setAssign((a) => { const n = { ...a }; delete n[tid]; return n; });
    setActive(tid);
  };
  // A free domain clicked: put it back if it's taken, otherwise give it to the
  // active old domain (or the first one still without a pick) and move on.
  const pickFree = (cid: string) => {
    const holder = Object.keys(assign).find((k) => assign[k] === cid);
    if (holder) { unpick(holder); return; }
    // With every domain picked, the click swaps the active (or first) one's pick.
    const to = active && going.some((t) => t.id === active) ? active : nextOpen(assign) ?? going[0]?.id;
    if (!to) return;
    const next = { ...assign, [to]: cid };
    setAssign(next);
    setActive(nextOpen(next, to) ?? to);
  };
  const autoPick = () => {
    if (!candidates) return;
    const keep = Object.fromEntries(Object.entries(assign).filter(([k]) => going.some((t) => t.id === k)));
    const taken = new Set(Object.values(keep));
    const next = { ...keep, ...autoAssign(going.filter((t) => !keep[t.id]), candidates.filter((c) => !taken.has(c.id))) };
    setAssign(next);
    setActive(nextOpen(next));
  };
  const ready = candidates !== null && going.length > 0 && short === 0 && going.every((t) => assign[t.id]) && namesOk && refused === 0 && reasons.length > 0;

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const hypertide = mode === "hypertide";
      const res = await startReplacement({
        oldIds: going.map((t) => t.id),
        newIds: going.map((t) => assign[t.id]),
        reasons,
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
        <Dialog.Content className="dialog is-xl rp-dialog">
          <div className="dialog-head">
            <Dialog.Title className="dialog-title">
              Replace {targets.length} domain{targets.length === 1 ? "" : "s"}
            </Dialog.Title>
            <Dialog.Description className="dialog-desc">
              Each one gets a free domain from storage, set up for the same client. Click a domain on the left, then a free domain on the right to swap it in.
            </Dialog.Description>
          </div>

          <div className="dialog-body">
            <div className="grid gap-3">
              <div className="field">
                <span className="field-label">Reasons <span className="zero">(pick one or more)</span></span>
                <div className="tld-chips" role="group" aria-label="Reasons for the replacement">
                  {(Object.entries(REPLACEMENT_REASONS) as [ReplacementReason, string][]).map(([k, label]) => (
                    <button key={k} type="button" className="tld-chip" aria-pressed={reasons.includes(k)} onClick={() => toggleReason(k)}>{label}</button>
                  ))}
                </div>
              </div>
              <label className="field">
                <span className="field-label">Note <span className="zero">(optional)</span></span>
                <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Bounce over 4% on the staffing campaign" maxLength={1000} />
              </label>
            </div>

            <div className="rp-pick">
              <div className="card rp-pairs">
                <div className="card-head">
                  <span className="card-title">Replacements</span>
                  <span className="card-sub">{candidates ? `${going.filter((t) => assign[t.id]).length} of ${going.length} picked${skipped.size ? ` · ${skipped.size} skipped` : ""}` : "Checking storage…"}</span>
                  {candidates ? (
                    <span className="rp-head-btns">
                      <button type="button" className="btn btn-sm" onClick={autoPick} title="Fill the empty ones: free domains first (same TLD first), then ones used before; never one still set up elsewhere">Auto-pick</button>
                      <button type="button" className="btn btn-sm" onClick={() => { setAssign({}); setActive(going[0]?.id ?? null); }} disabled={!used.size}>Clear</button>
                    </span>
                  ) : null}
                </div>
                <div className="rp-list">
                  {targets.map((t) => {
                    const c = candidates?.find((x) => x.id === assign[t.id]);
                    const isActive = active === t.id && !skipped.has(t.id);
                    return (
                      <div key={t.id} className="rp-pair" data-active={isActive || undefined}>
                        <button type="button" className="rp-pair-btn" disabled={skipped.has(t.id) || candidates === null} onClick={() => setActive(t.id)}
                          aria-pressed={isActive} aria-label={`Pick the new domain for ${t.name}`}>
                          <span className="rp-side">
                            <span className="list-title">{t.name}</span>
                            <span className="list-meta"><ClientCell name={t.clientName} hue={t.clientHue} /></span>
                          </span>
                          <ArrowRight size={14} strokeWidth={1.5} className="flex-none text-faint" />
                          {candidates === null ? <span className="rp-side"><Skeleton h={22} /></span> : skipped.has(t.id) ? (
                            <span className="rp-side text-[12px] text-warning-ink" title="Hypertide only replaces domains whose order is Done. Replace this one by hand, or with I'll do it in Hypertide.">Skipped: order isn&apos;t Done</span>
                          ) : c ? (
                            <span className="rp-side">
                              <span className="list-title">{c.name}</span>
                              <span className="list-meta">{mode === "hypertide" && !hypertideAcceptsDomain(c.name) ? <span className="text-warning-ink">Hypertide won&apos;t accept</span> : c.registrar ?? "no registrar account"}</span>
                            </span>
                          ) : <span className="rp-side rp-empty">{isActive ? "Pick a free domain" : "Not picked"}</span>}
                        </button>
                        {c ? <button type="button" className="icon-btn rp-x" aria-label={`Clear ${c.name}`} title="Put it back" onClick={() => unpick(t.id)}><X size={13} /></button> : null}
                      </div>
                    );
                  })}
                </div>
              </div>
              <FreeDomains candidates={candidates} assign={assign} targets={targets} hypertide={mode === "hypertide"} onPick={pickFree} />
            </div>

            <div className="field">
              <span className="field-label">Inboxes</span>
              <div className="seg cfg-seg" role="group" aria-label="How the inboxes move">
                <button type="button" aria-pressed={mode === "hypertide"} onClick={() => setMode("hypertide")}>Replace on Hypertide</button>
                <button type="button" aria-pressed={mode === "manual"} onClick={() => setMode("manual")}>I&apos;ll do it in Hypertide</button>
              </div>
              <span className="field-hint">
                {mode === "hypertide"
                  ? "The app sends the swap to Hypertide (no new order, no payment), sets the nameservers it returns at the domain's registrar and follows it until the inboxes are in Smartlead."
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
              <Check checked={stopOldSending} onChange={setStopOldSending} label="Stop sending from the old domain when the new one is live" hint="Off by default: the old domain keeps sending through its grace period, so you still get every reply it can bring in, then retires when the grace period ends. Turn this on to set its daily limit to 0 once the new inboxes are in Smartlead." />
              <p className="field-hint flex items-start gap-1.5">
                <Info size={13} className="mt-0.5 flex-none" aria-hidden />
                <span>Done for you on every replacement: the old domains are tagged Replaced, here and on their Smartlead inboxes, and start their grace period; the new ones are tagged New while they warm up.</span>
              </p>
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
            <button type="button" className="btn btn-primary" disabled={!ready || pending} title={reasons.length ? undefined : "Pick at least one reason"} onClick={submit}>
              {pending ? "Starting…" : `Replace ${going.length} domain${going.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
