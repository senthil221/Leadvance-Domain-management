"use client";

import { Dialog } from "radix-ui";
import { CircleCheck, CircleX, ClipboardPaste, Hand, Loader2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { loadNameserverStatus, pasteNameservers } from "@/app/actions";
import { parseNameserverSheet } from "@/lib/paste-nameservers";
import { int } from "@/lib/format";

type Status = { status: string; message: string | null };
const plural = (n: number, one: string, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;

/**
 * Paste a sheet of domains and the nameservers each should point to (Hypertide
 * sends one per batch, a different pair for every domain), and they're all set
 * at their registrars in one go, with the outcome shown for each.
 */
export function PasteNameservers({ className = "btn btn-sm" }: { className?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sent, setSent] = useState<{ queued: { domainId: string; domain: string }[]; notFound: string[]; skipped: string[] } | null>(null);
  const [status, setStatus] = useState<Map<string, Status>>(new Map());
  const [busy, start] = useTransition();
  const parsed = useMemo(() => parseNameserverSheet(text), [text]);

  // Follow the queued changes until each has an outcome (about a minute at most).
  useEffect(() => {
    if (!sent?.queued.length) return;
    const ids = sent.queued.map((q) => q.domainId);
    let stop = false, tries = 0;
    const tick = async () => {
      const rows = await loadNameserverStatus(ids).catch(() => []);
      if (stop) return;
      const next = new Map(rows.map((r) => [r.domainId, { status: r.status, message: r.message }]));
      setStatus(next);
      const waiting = ids.some((id) => ["pending", "running"].includes(next.get(id)?.status ?? "pending"));
      if (waiting && ++tries < 30) setTimeout(tick, 2000);
      else router.refresh();
    };
    tick();
    return () => { stop = true; };
  }, [sent, router]);

  const reset = () => { setText(""); setSent(null); setStatus(new Map()); };
  const submit = () => start(async () => {
    const r = await pasteNameservers({ rows: parsed.rows });
    if (!r.ok) { toast.error(r.error); return; }
    setSent(r.data);
    if (!r.data.queued.length) toast.error("None of these domains are in Domain Engine");
  });

  const counts = { done: 0, manual: 0, failed: 0, waiting: 0 };
  for (const q of sent?.queued ?? []) {
    const s = status.get(q.domainId)?.status ?? "pending";
    if (s === "done" || s === "dry_run") counts.done++;
    else if (s === "manual") counts.manual++;
    else if (s === "failed") counts.failed++;
    else counts.waiting++;
  }

  return (
    <>
      <button type="button" className={className} title="Paste a sheet of domains and the nameservers each should point to" onClick={() => setOpen(true)}>
        <ClipboardPaste size={14} strokeWidth={1.75} aria-hidden="true" />Paste nameservers
      </button>
      <Dialog.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="overlay" />
          <Dialog.Content className="dialog is-wide pns">
            <div className="dialog-head">
              <Dialog.Title className="dialog-title">Paste nameservers</Dialog.Title>
              <Dialog.Description className="dialog-desc">
                Copy the rows from Hypertide&apos;s sheet (domain, then its nameservers) and paste them here. Each domain is set to its own pair at its registrar.
              </Dialog.Description>
            </div>

            <div className="dialog-body">
              {!sent ? (
                <>
                  <textarea className="input pns-text" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} autoFocus
                    placeholder={"bluelaneco.info\tcarl.ns.cloudflare.com\ttani.ns.cloudflare.com\nblueoakbase.info\tjasmine.ns.cloudflare.com\tsean.ns.cloudflare.com"} aria-label="Domains and nameservers" />
                  {parsed.rows.length || parsed.problems.length ? (
                    <div className="pns-preview">
                      <div className="pns-sum">
                        <b>{plural(parsed.rows.length, "domain")}</b> ready
                        {parsed.problems.length ? <span className="pns-bad"> · {plural(parsed.problems.length, "line")} can&apos;t be read</span> : null}
                      </div>
                      <div className="pns-scroll">
                        <table className="data-table pns-table">
                          <thead><tr><th>Domain</th><th>Nameservers</th></tr></thead>
                          <tbody>
                            {parsed.problems.map((p) => (
                              <tr key={`p${p.line}`} className="is-bad"><td title={p.text}>Line {p.line}: {p.text}</td><td>{p.why}</td></tr>
                            ))}
                            {parsed.rows.map((r) => (
                              <tr key={r.domain}><td className="pns-domain">{r.domain}</td><td className="pns-ns">{r.nameservers.join("  ·  ")}</td></tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="pns-preview">
                  <div className="pns-sum">
                    {[
                      counts.waiting ? <span key="w"><Loader2 size={13} className="pns-spin" aria-hidden="true" /> Setting {plural(counts.waiting, "domain")}…</span> : null,
                      counts.done ? <span key="d" className="pns-ok">{int(counts.done)} set</span> : null,
                      counts.manual ? <span key="m" className="pns-warn">{int(counts.manual)} to set by hand</span> : null,
                      counts.failed ? <span key="f" className="pns-bad">{int(counts.failed)} failed</span> : null,
                      sent.notFound.length ? <span key="n" className="pns-bad">{int(sent.notFound.length)} not in Domain Engine</span> : null,
                      sent.skipped.length ? <span key="s" className="pns-warn">{int(sent.skipped.length)} burned or resting, left alone</span> : null,
                    ].filter(Boolean).map((el, i) => <span key={i} className="pns-part">{el}</span>)}
                  </div>
                  <div className="pns-scroll">
                    <table className="data-table pns-table">
                      <thead><tr><th>Domain</th><th>Result</th></tr></thead>
                      <tbody>
                        {sent.queued.map((q) => {
                          const s = status.get(q.domainId) ?? { status: "pending", message: null };
                          const done = s.status === "done" || s.status === "dry_run";
                          return (
                            <tr key={q.domainId}>
                              <td className="pns-domain">{q.domain}</td>
                              <td className="pns-result" title={s.message ?? undefined}>
                                {done ? <CircleCheck size={14} className="pns-ok" aria-hidden="true" />
                                  : s.status === "failed" ? <CircleX size={14} className="pns-bad" aria-hidden="true" />
                                  : s.status === "manual" ? <Hand size={14} className="pns-warn" aria-hidden="true" />
                                  : <Loader2 size={14} className="pns-spin" aria-hidden="true" />}
                                <span>{done ? s.message ?? "Set" : s.status === "pending" || s.status === "running" ? "Setting…" : s.message ?? s.status}</span>
                              </td>
                            </tr>
                          );
                        })}
                        {sent.notFound.map((d) => <tr key={`n${d}`} className="is-bad"><td className="pns-domain">{d}</td><td>Not in Domain Engine: check the spelling, or sync the registrar</td></tr>)}
                        {sent.skipped.map((d) => <tr key={`s${d}`}><td className="pns-domain">{d}</td><td className="zero">Burned or resting, left alone</td></tr>)}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            <div className="dialog-foot">
              <span className="spacer" />
              {!sent ? (
                <>
                  <Dialog.Close asChild><button type="button" className="btn">Cancel</button></Dialog.Close>
                  <button type="button" className="btn btn-primary" disabled={busy || !parsed.rows.length} onClick={submit}>
                    {busy ? "Sending…" : `Set nameservers for ${plural(parsed.rows.length, "domain")}`}
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="btn" onClick={reset}>Paste more</button>
                  <Dialog.Close asChild><button type="button" className="btn btn-primary">Done</button></Dialog.Close>
                </>
              )}
            </div>
            <Dialog.Close asChild>
              <button type="button" className="icon-btn pns-x" aria-label="Close"><X size={16} strokeWidth={1.5} /></button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
