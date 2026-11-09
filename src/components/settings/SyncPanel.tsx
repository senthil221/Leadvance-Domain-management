"use client";

import { Check, Copy, Play, PlayCircle, RotateCcw } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { runJobNow } from "@/app/actions";
import { ago, summarize } from "@/lib/format";

export type SyncJob = { name: string; label: string; everyMinutes: number; lastFinishedAt: Date | null; lastOk: boolean | null; lastError: string | null; summary: string | null };

// The jobs in sections, in the order Run all goes through them: Smartlead
// first (inboxes and numbers), then the inbox providers, then registrars and
// DNS, and the daily stats last so they count what the others brought in.
const SECTIONS: { key: string; title: string; sub: string; jobs: string[] }[] = [
  { key: "smartlead", title: "Smartlead", sub: "Inboxes, campaigns, numbers, blacklists and the settings waiting to go out",
    jobs: ["smartlead-accounts", "smartlead-campaigns", "smartlead-domain-stats", "smartlead-blacklists", "inbox-settings", "warmup-new-domains", "untracked-replies"] },
  { key: "providers", title: "Hypertide and Icemail", sub: "Orders, mailboxes and replacements in progress",
    jobs: ["hypertide-orders", "icemail", "replacement-steps"] },
  { key: "domains", title: "Domains and registrars", sub: "Registrar accounts, nameserver changes and lookups, drained domains",
    jobs: ["registrar-domains", "nameserver-requests", "nameserver-check", "retire-drained"] },
  { key: "stats", title: "Stats", sub: "Bounce reasons, daily numbers and health rules",
    jobs: ["bounce-causes", "rollup"] },
];

type Outcome = { ok: boolean; text: string | null };

export function SyncPanel({ jobs }: { jobs: SyncJob[] }) {
  const [running, setRunning] = useState<string | null>(null);
  const [queue, setQueue] = useState<{ done: number; total: number; label: string } | null>(null);
  // What each job did when run from here, shown until the page reloads.
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [, start] = useTransition();
  const byName = new Map(jobs.map((j) => [j.name, j]));
  const listed = new Set(SECTIONS.flatMap((x) => x.jobs));
  const sections = [
    ...SECTIONS.map((x) => ({ ...x, list: x.jobs.flatMap((n) => byName.get(n) ?? []) })),
    { key: "other", title: "Other", sub: "", jobs: [], list: jobs.filter((j) => !listed.has(j.name)) },
  ].filter((x) => x.list.length);
  const busy = running !== null || queue !== null;

  const runOne = async (job: SyncJob) => {
    setRunning(job.name);
    const r = await runJobNow(job.name);
    setRunning(null);
    const o = r.ok ? { ok: true, text: summarize(r.data) ?? null } : { ok: false, text: r.error };
    setOutcomes((m) => ({ ...m, [job.name]: o }));
    return o;
  };
  const single = (job: SyncJob) => start(async () => {
    const o = await runOne(job);
    if (o.ok) toast.success(`${job.label} done`, { description: o.text ?? undefined });
    else toast.error(`${job.label} failed`, { description: o.text ?? undefined });
  });
  // One after another, so each sees what the one before brought in.
  const runMany = (list: SyncJob[], what: string) => start(async () => {
    const failed: string[] = [];
    for (let i = 0; i < list.length; i++) {
      setQueue({ done: i, total: list.length, label: list[i].label });
      const o = await runOne(list[i]);
      if (!o.ok) failed.push(list[i].label);
    }
    setQueue(null);
    if (failed.length) toast.error(`${what}: ${list.length - failed.length} of ${list.length} done`, { description: `Failed: ${failed.join(", ")}` });
    else toast.success(`${what}: all ${list.length} jobs done`);
  });
  const failing = jobs.filter((j) => (outcomes[j.name] ? !outcomes[j.name].ok : j.lastOk === false));

  return (
    <div className="sync">
      <div className="sync-head">
        <div className="sync-head-text">
          {queue ? (
            <>
              <span className="list-title">Running {queue.done + 1} of {queue.total}: {queue.label}</span>
              <span className="sync-progress" aria-hidden><i style={{ width: `${(100 * queue.done) / queue.total}%` }} /></span>
            </>
          ) : (
            <>
              <span className="list-title">{jobs.length} jobs in {sections.length} sections</span>
              <span className="list-meta">{failing.length ? <span className="text-danger-ink">{failing.length} failed last time: {failing.map((j) => j.label).join(", ")}</span> : "All ran fine last time"}</span>
            </>
          )}
        </div>
        {failing.length && !busy ? <button type="button" className="btn btn-sm" onClick={() => runMany(failing, "Failed jobs")}><RotateCcw size={12} /> Retry failed</button> : null}
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => runMany(sections.flatMap((x) => x.list), "Run all")}
          title="Every job, one after another, Smartlead first and the daily stats last">
          <PlayCircle size={13} /> {queue ? "Running…" : "Run all"}
        </button>
      </div>
      {sections.map((x) => (
        <section key={x.key} className="sync-section" aria-labelledby={`sync-${x.key}`}>
          <div className="sync-section-head">
            <div className="list-main">
              <span id={`sync-${x.key}`} className="sync-section-title">{x.title} <span className="text-faint">{x.list.length}</span></span>
              {x.sub ? <span className="list-meta">{x.sub}</span> : null}
            </div>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => runMany(x.list, x.title)}><Play size={12} /> Run {x.list.length === 1 ? "" : "all "}{x.title === "Other" ? "" : x.title}</button>
          </div>
          <div className="list">
            {x.list.map((j) => <JobRow key={j.name} job={j} running={running === j.name} disabled={busy} outcome={outcomes[j.name]} onRun={() => single(j)} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function JobRow({ job, running, disabled, outcome, onRun }: { job: SyncJob; running: boolean; disabled: boolean; outcome?: Outcome; onRun: () => void }) {
  const ok = outcome ? outcome.ok : job.lastOk;
  const tone = running ? "info" : ok == null ? "faint" : ok ? "success" : "danger";
  const said = outcome ? outcome.text : ok === false ? job.lastError : job.summary;
  return (
    <div className="list-row" style={{ alignItems: "flex-start", paddingTop: 10, paddingBottom: 10 }}>
      <span className={`dot tone-${tone}${running ? " is-pulse" : ""}`} style={{ marginTop: 6 }} />
      <div className="list-main">
        <span className="list-title">{job.label}</span>
        <span className="list-meta" style={{ whiteSpace: "normal" }} suppressHydrationWarning>
          {running ? "Running…" : outcome ? "Just now · " : job.lastFinishedAt ? `${ago(job.lastFinishedAt)} · ` : "Not run yet · "}
          {running ? null : <>every {job.everyMinutes} min</>}
          {!running && said ? (ok === false ? <span className="text-danger-ink"> · {said}</span> : ` · ${said}`) : null}
        </span>
      </div>
      <button type="button" className="btn btn-sm" disabled={disabled} onClick={onRun}>
        <Play size={12} /> {running ? "Running…" : "Run now"}
      </button>
    </div>
  );
}

export function CopyUrl({ url, where = "Smartlead → Settings → Webhooks" }: { url: string; where?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          toast("Webhook URL copied", { description: `Paste it into ${where}.` });
          setTimeout(() => setCopied(false), 2000);
        } catch {
          toast.error("Couldn't copy. Your browser blocked clipboard access.");
        }
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy URL"}
    </button>
  );
}
