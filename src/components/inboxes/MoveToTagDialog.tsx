"use client";

import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { moveDomainsToTag } from "@/app/actions";
import { int } from "@/lib/format";
import { isMark, normTag } from "@/lib/tag-map";
import type { InboxListRow } from "@/lib/queries";

/** The most common value, or null when there are none. */
function mostCommon(xs: (number | null)[]) {
  const counts = new Map<number, number>();
  for (const x of xs) if (x != null && x > 0) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
}

// Moves the selected domains onto a Smartlead tag. The inboxes already on that
// tag show what the moved ones will run on: the same sending limit and warmup.
export function MoveToTagDialog({ open, onOpenChange, domainIds, inboxes, dryRun, appProblem, onDone }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  domainIds: string[];
  inboxes: InboxListRow[];
  dryRun: boolean;
  appProblem: string | null;
  onDone: () => void;
}) {
  const [tag, setTag] = useState("");
  const [pending, start] = useTransition();
  const moving = useMemo(() => new Set(domainIds), [domainIds]);

  // Tags in use by inboxes that aren't moving and aren't still warming up.
  const tags = useMemo(() => {
    const byTag = new Map<string, { shown: string; inboxes: InboxListRow[] }>();
    for (const i of inboxes) {
      if (i.status !== "connected" || moving.has(i.domainId) || (i.domainWarmupStartedAt && !i.domainWarmupDoneAt)) continue;
      for (const t of i.smartleadTags) {
        if (!t.trim() || isMark(t)) continue;
        const e = byTag.get(normTag(t)) ?? { shown: t.trim(), inboxes: [] };
        e.inboxes.push(i);
        byTag.set(normTag(t), e);
      }
    }
    return [...byTag.entries()].map(([key, e]) => ({
      key, name: e.shown, inboxes: e.inboxes.length, domains: new Set(e.inboxes.map((i) => i.domainId)).size,
      limit: mostCommon(e.inboxes.map((i) => i.dailyLimit)), warmup: mostCommon(e.inboxes.map((i) => i.warmupPerDay)),
    })).sort((a, b) => b.inboxes - a.inboxes || a.name.localeCompare(b.name));
  }, [inboxes, moving]);

  const needle = normTag(tag);
  const shown = tags.filter((t) => !needle || t.key.includes(needle));
  const picked = tags.find((t) => t.key === needle) ?? null;
  const count = domainIds.length;

  const submit = () => start(async () => {
    const r = await moveDomainsToTag({ domainIds, tag });
    if (!r.ok) return void toast.error(r.error);
    toast.success(r.data.message);
    setTag("");
    onOpenChange(false);
    onDone();
  });

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!pending) onOpenChange(o); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog">
          <div className="dialog-head cfg-top">
            <div>
              <Dialog.Title className="dialog-title">Move to a tag</Dialog.Title>
              <Dialog.Description className="dialog-desc">
                {int(count)} domain{count === 1 ? "" : "s"}. Their inboxes take the tag and run on the same sending limit and warmup as the inboxes already on it.
                {dryRun ? " Dry run is on: Smartlead isn't changed." : ""}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild><button type="button" className="btn btn-sm btn-icon" aria-label="Close"><X size={15} /></button></Dialog.Close>
          </div>
          <div className="dialog-body">
            <label className="field" htmlFor="move-tag">
              <span className="cfg-label">Tag</span>
              <input id="move-tag" className="input" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Search a tag, or type a new one" autoComplete="off"
                onKeyDown={(e) => { if (e.key === "Enter" && tag.trim() && !pending && !appProblem) submit(); }} />
            </label>
            <div className="cfg-chips" style={{ maxHeight: 220, overflowY: "auto" }}>
              {shown.length ? shown.map((t) => (
                <button key={t.key} type="button" className="cfg-chip" aria-pressed={picked?.key === t.key} onClick={() => setTag(t.name)} title={`${t.inboxes} inboxes on ${t.domains} domains`}>
                  {t.name} <span className="text-faint">{int(t.domains)}</span>
                </button>
              )) : <span className="field-hint">No tag matches. A new tag is created when you move.</span>}
            </div>
            {tag.trim() ? (
              <p className="cfg-note">
                {picked
                  ? <>Moved inboxes will run on <b>{picked.limit ?? "their current"}</b> sending a day and <b>{picked.warmup ?? "their current"}</b> warmup a day, like the {int(picked.inboxes)} inboxes on {int(picked.domains)} domain{picked.domains === 1 ? "" : "s"} already there.</>
                  : <>No inbox uses &ldquo;{tag.trim()}&rdquo; yet, so the tag is created and sending limits stay as they are.</>}
              </p>
            ) : null}
            {appProblem ? <p className="cfg-note is-warn">{appProblem.replace("Reconnecting", "Moving to a tag")}</p> : null}
          </div>
          <div className="dialog-foot">
            <span className="spacer" />
            <button type="button" className="btn" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={pending || !tag.trim() || Boolean(appProblem)} onClick={submit}>
              {pending ? "Moving…" : `Move ${int(count)} domain${count === 1 ? "" : "s"}`}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
