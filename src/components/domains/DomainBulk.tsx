"use client";

import { Dialog } from "radix-ui";
import { ClipboardPaste, SlidersHorizontal, X } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { type DomainConfig, loadDomainConfig } from "@/app/actions";
import { InboxSettingsDialog } from "@/components/inboxes/InboxSettingsDialog";
import { int } from "@/lib/format";
import { matchPasted } from "@/lib/paste-select";

const plural = (n: number, one: string, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;

/**
 * Paste to select: domains or email addresses, any separator. Shows what
 * matched the page, what isn't on it and what isn't a domain, then adds the
 * matches to the selection or takes them out of it.
 */
export function PasteSelect<T extends { id: string; name: string }>({ rows, selected, onSelect, where = "on this page" }: {
  rows: readonly T[];
  selected: ReadonlySet<string>;
  onSelect: (ids: Set<string>) => void;
  /** How the rows are described: "on this page", "in this tab". */
  where?: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"add" | "remove" | "only">("only");
  const m = text.trim() ? matchPasted(text, rows) : null;
  const apply = () => {
    if (!m?.matched.length) return;
    const ids = m.matched.map((r) => r.id);
    const next = mode === "only" ? new Set(ids) : new Set(selected);
    if (mode === "add") for (const id of ids) next.add(id);
    if (mode === "remove") for (const id of ids) next.delete(id);
    onSelect(next);
    toast.success(mode === "remove" ? `Took ${plural(ids.length, "domain")} out of the selection` : `Selected ${plural(ids.length, "domain")}`);
    setOpen(false);
    setText("");
  };
  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)} title="Paste a list of domains or email addresses to select them"><ClipboardPaste size={14} /> Paste to select</button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="overlay" />
          <Dialog.Content className="dialog">
            <div className="dialog-head cfg-top">
              <div>
                <Dialog.Title className="dialog-title">Paste to select</Dialog.Title>
                <Dialog.Description className="dialog-desc">Domains or email addresses, one per line or separated by commas or spaces. An address selects its domain.</Dialog.Description>
              </div>
              <Dialog.Close asChild><button type="button" className="btn btn-sm btn-icon" aria-label="Close"><X size={15} /></button></Dialog.Close>
            </div>
            <div className="dialog-body">
              <textarea className="input" rows={9} value={text} onChange={(e) => setText(e.target.value)} autoFocus spellCheck={false}
                placeholder={"acme-mail.com\njohn@acmehq.co\nhttps://acme-team.com"} aria-label="Domains or email addresses" style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12.5 }}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) apply(); }} />
              <div className="seg cfg-seg" role="group" aria-label="What to do with the matches">
                {([["only", "Select only these"], ["add", "Add to selection"], ["remove", "Remove from selection"]] as const).map(([k, label]) => (
                  <button key={k} type="button" aria-pressed={mode === k} onClick={() => setMode(k)} disabled={k !== "only" && !selected.size}>{label}</button>
                ))}
              </div>
              {m ? (
                <div className="paste-result">
                  <p className="paste-counts">
                    <span className="text-success-ink"><b>{int(m.matched.length)}</b> matched</span>
                    <span className={m.notFound.length ? "text-warning-ink" : "text-faint"}><b>{int(m.notFound.length)}</b> not {where}</span>
                    <span className={m.invalid.length ? "text-danger-ink" : "text-faint"}><b>{int(m.invalid.length)}</b> not a domain</span>
                  </p>
                  {m.notFound.length ? <p className="cfg-note"><b>Not {where}:</b> {m.notFound.slice(0, 40).join(", ")}{m.notFound.length > 40 ? ` and ${int(m.notFound.length - 40)} more` : ""}</p> : null}
                  {m.invalid.length ? <p className="cfg-note is-warn"><b>Not a domain:</b> {m.invalid.slice(0, 20).join(", ")}{m.invalid.length > 20 ? "…" : ""}</p> : null}
                </div>
              ) : null}
            </div>
            <div className="dialog-foot">
              <span className="field-hint">Ctrl+Enter to apply</span>
              <span className="spacer" />
              <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={!m?.matched.length} onClick={apply}>
                {mode === "remove" ? "Remove" : "Select"} {m?.matched.length ? plural(m.matched.length, "domain") : ""}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

/**
 * Configure settings for whole domains: Smartlead tags (add, remove, replace),
 * daily limit and wait, and warmup, on every Smartlead inbox of the domains.
 */
export function ConfigureDomains({ domainIds, onDone, label = "Configure settings" }: { domainIds: string[]; onDone?: () => void; label?: string }) {
  const [cfg, setCfg] = useState<DomainConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const load = () => start(async () => {
    const r = await loadDomainConfig(domainIds);
    if (!r.ok) return void toast.error(r.error);
    if (!r.data.inboxIds.length) return void toast.error(`None of these ${plural(domainIds.length, "domain")} has an inbox in Smartlead`);
    setCfg(r.data);
    setOpen(true);
  });
  const note = cfg ? [
    cfg.unlinked ? `${plural(cfg.unlinked, "inbox", "inboxes")} not in Smartlead left out.` : "",
    cfg.disconnected ? `${plural(cfg.disconnected, "inbox", "inboxes")} disconnected, changed too.` : "",
  ].filter(Boolean).join(" ") : null;
  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" disabled={!domainIds.length || pending} onClick={load}
        title="Smartlead tags, daily limit and wait, and warmup, for every inbox of the selected domains">
        <SlidersHorizontal size={14} /> {pending ? "Loading…" : label}
      </button>
      {cfg ? (
        <InboxSettingsDialog open={open} onOpenChange={setOpen} inboxIds={cfg.inboxIds} domains={cfg.domains} current={cfg.current}
          selectedTags={cfg.selectedTags} knownTags={cfg.knownTags} dryRun={cfg.dryRun} appProblem={cfg.appProblem} note={note} onDone={onDone} />
      ) : null}
    </>
  );
}
