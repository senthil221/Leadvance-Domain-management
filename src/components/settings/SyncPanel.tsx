"use client";

import { Check, Copy, Play, PlayCircle, RotateCcw, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { runJobNow } from "@/app/actions";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ago, summarize, took } from "@/lib/format";
import { unfinishedRunText } from "@/lib/job-queue";

export type SyncJob = { name: string; label: string; everyMinutes: number; lastStartedAt: Date | null; lastFinishedAt: Date | null; lastOk: boolean | null; lastError: string | null; summary: string | null };

// The jobs in sections, in the order Run all goes through them: Smartlead
// first (inboxes and numbers), then the inbox providers, then registrars and
// DNS, and the daily stats last so they count what the others brought in.
const SECTIONS: { key: string; title: string; sub: string; jobs: string[] }[] = [
  { key: "smartlead", title: "Smartlead", sub: "Inboxes, campaigns, numbers, blacklists and the settings waiting to go out",
    jobs: ["smartlead-accounts", "smartlead-campaigns", "smartlead-domain-stats", "smartlead-blacklists", "inbox-settings", "warmup-new-domains", "untracked-replies", "placement-tests"] },
  { key: "providers", title: "Hypertide and Icemail", sub: "Orders, mailboxes and replacements in progress",
    jobs: ["hypertide-orders", "icemail", "replacement-steps"] },
  { key: "domains", title: "Domains and registrars", sub: "Registrar accounts, nameserver changes and lookups, drained domains",
    jobs: ["registrar-domains", "registry-check", "nameserver-requests", "nameserver-check", "retire-drained"] },
  { key: "stats", title: "Stats", sub: "Bounce reasons, daily numbers and health rules",
    jobs: ["bounce-causes", "placement-seeds", "rollup"] },
];

/** unfinished: still queued or running on the server when the wait ran out. */
type Outcome = { ok: boolean; text: string | null; unfinished?: boolean };
type Current = { job: SyncJob; startedAt: number; done: number; total: number };
type RowState = "here" | "queued" | "server" | "server-queued" | "idle";

const ms = (d: Date | string) => new Date(d).getTime();
/** Ran before, then asked for (here, another tab or a webhook) and waiting for the worker, which runs one job at a time. */
const queuedOnServer = (j: SyncJob) => j.lastStartedAt == null && j.lastFinishedAt != null;
/** When the worker last started or finished anything, if it isn't in the middle of a job. */
function workerIdleSince(jobs: SyncJob[], now: number) {
  if (jobs.some((j) => onServer(j, now))) return null;
  const last = Math.max(...jobs.flatMap((j) => [j.lastStartedAt, j.lastFinishedAt].flatMap((d) => (d ? [ms(d)] : []))));
  return Number.isFinite(last) ? last : null;
}
/** Started by the background worker and not finished yet (a start over 3 hours old is a crash, not a run). */
const onServer = (j: SyncJob, now: number) =>
  j.lastStartedAt != null && (!j.lastFinishedAt || ms(j.lastStartedAt) > ms(j.lastFinishedAt)) && now - ms(j.lastStartedAt) < 3 * 3600_000;
/** How long the last finished run took. */
const lastTook = (j: SyncJob) =>
  j.lastStartedAt && j.lastFinishedAt && ms(j.lastFinishedAt) >= ms(j.lastStartedAt) ? ms(j.lastFinishedAt) - ms(j.lastStartedAt) : null;
/** Hasn't started in over twice its interval and five minutes: the worker, which runs one job at a time, is behind. */
const isBehind = (j: SyncJob, now: number) =>
  j.lastStartedAt != null && !onServer(j, now) && now - ms(j.lastStartedAt) > (2 * j.everyMinutes + 5) * 60_000;

export function SyncPanel({ jobs }: { jobs: SyncJob[] }) {
  // Jobs run from here go one after another through this queue. Run now and a
  // section's Run all add to it while it runs, so no button is locked meanwhile.
  const waiting = useRef<SyncJob[]>([]);
  const draining = useRef(false);
  const stop = useRef(false);
  const [queued, setQueued] = useState<string[]>([]);
  const [current, setCurrent] = useState<Current | null>(null);
  const [stopping, setStopping] = useState(false);
  // What each job did when run from here, shown until the page reloads.
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const byName = new Map(jobs.map((j) => [j.name, j]));
  const listed = new Set(SECTIONS.flatMap((x) => x.jobs));
  const sections = [
    ...SECTIONS.map((x) => ({ ...x, list: x.jobs.flatMap((n) => byName.get(n) ?? []) })),
    { key: "other", title: "Other", sub: "", jobs: [], list: jobs.filter((j) => !listed.has(j.name)) },
  ].filter((x) => x.list.length);

  const runOne = async (job: SyncJob): Promise<Outcome> => {
    let o: Outcome;
    try {
      const r = await runJobNow(job.name);
      o = !r.ok ? { ok: false, text: r.error }
        : r.data.finished ? { ok: true, text: summarize(r.data.detail) ?? null }
        : { ok: true, text: unfinishedRunText(r.data), unfinished: true };
    } catch (e) {
      o = { ok: false, text: e instanceof Error ? e.message : "The server didn't answer" };
    }
    setOutcomes((m) => ({ ...m, [job.name]: o }));
    return o;
  };

  // One after another, so each sees what the one before brought in.
  const drain = async () => {
    draining.current = true;
    stop.current = false;
    const results: { job: SyncJob; o: Outcome }[] = [];
    while (waiting.current.length && !stop.current) {
      const job = waiting.current.shift()!;
      setQueued(waiting.current.map((j) => j.name));
      setCurrent({ job, startedAt: Date.now(), done: results.length, total: results.length + 1 + waiting.current.length });
      results.push({ job, o: await runOne(job) });
    }
    const left = waiting.current.length;
    waiting.current = [];
    draining.current = false;
    setQueued([]);
    setCurrent(null);
    setStopping(false);
    const note = left ? `Stopped; ${left} not run.` : null;
    const failed = results.filter((r) => !r.o.ok);
    const unfinished = results.filter((r) => r.o.unfinished);
    const done = results.length - failed.length - unfinished.length;
    if (results.length === 1) {
      const [{ job, o }] = results;
      const description = [o.text, note].filter(Boolean).join(" ") || undefined;
      if (o.unfinished) toast(job.label, { description });
      else if (o.ok) toast.success(`${job.label} done`, { description });
      else toast.error(`${job.label} failed`, { description });
    } else if (failed.length || unfinished.length) {
      const description = [
        failed.length ? `Failed: ${failed.map((r) => r.job.label).join(", ")}.` : null,
        unfinished.length ? `Still on the server: ${unfinished.map((r) => r.job.label).join(", ")}.` : null,
        note,
      ].filter(Boolean).join(" ");
      (failed.length ? toast.error : toast)(`${done} of ${results.length} jobs done`, { description });
    } else {
      toast.success(`All ${results.length} jobs done`, { description: note ?? undefined });
    }
  };

  const enqueue = (list: SyncJob[]) => {
    const have = new Set([...waiting.current.map((j) => j.name), ...(current ? [current.job.name] : [])]);
    const add = list.filter((j) => !have.has(j.name) && !onServer(j, Date.now()) && !queuedOnServer(j));
    if (!add.length) return;
    waiting.current.push(...add);
    setQueued(waiting.current.map((j) => j.name));
    if (draining.current) toast(`${add.length === 1 ? add[0].label : `${add.length} jobs`} added to the queue`);
    else void drain();
  };

  const failing = jobs.filter((j) => (outcomes[j.name] ? !outcomes[j.name].ok : j.lastOk === false));
  const serverNow = jobs.filter((j) => onServer(j, now) && current?.job.name !== j.name);
  const behind = jobs.filter((j) => !outcomes[j.name] && isBehind(j, now));
  // Three jobs run every minute, so three quiet minutes means the worker is down.
  const idleSince = workerIdleSince(jobs, now);
  const workerDown = idleSince != null && now - idleSince > 3 * 60_000;
  const usual = current ? lastTook(current.job) : null;
  const rowState = (j: SyncJob): RowState =>
    current?.job.name === j.name ? "here" : queued.includes(j.name) ? "queued" : onServer(j, now) ? "server" : queuedOnServer(j) ? "server-queued" : "idle";

  return (
    <div className="sync">
      <AutoRefresh seconds={15} />
      <div className="sync-head">
        <div className="sync-head-text">
          {current ? (
            <>
              <span className="list-title" suppressHydrationWarning>
                Asked the server for {current.done + 1} of {current.total}: {current.job.label} · {took(now - current.startedAt)}
                {usual != null ? <span className="text-faint"> (took {took(usual)} last time)</span> : null}
              </span>
              <span className="sync-progress" aria-hidden><i style={{ width: `${(100 * current.done) / current.total}%` }} /></span>
              <span className="list-meta">The other buttons still work: they add to this queue.</span>
            </>
          ) : (
            <>
              <span className="list-title">{jobs.length} jobs in {sections.length} sections</span>
              <span className="list-meta">{failing.length ? <span className="text-danger-ink">{failing.length} failed last time: {failing.map((j) => j.label).join(", ")}</span> : "All ran fine last time"}</span>
            </>
          )}
          {serverNow.length ? (
            <span className="list-meta" suppressHydrationWarning>
              <span className="dot tone-info is-pulse" style={{ marginRight: 6, verticalAlign: "middle" }} />
              Running on the server now: {serverNow.map((j) => `${j.label} (started ${ago(j.lastStartedAt, now)})`).join(", ")}
            </span>
          ) : null}
          {workerDown ? (
            <span className="list-meta text-warning-ink" style={{ whiteSpace: "normal" }} suppressHydrationWarning>
              The background worker last ran a job {ago(new Date(idleSince ?? now), now)}. Jobs only run there, so anything asked for here waits until it&apos;s back.
            </span>
          ) : behind.length ? (
            <span className="list-meta text-warning-ink" style={{ whiteSpace: "normal" }} suppressHydrationWarning>
              {behind.length} {behind.length === 1 ? "job is" : "jobs are"} behind schedule: {behind.map((j) => j.label).join(", ")}. The server runs one job at a time, so a slow one holds up the rest.
            </span>
          ) : null}
        </div>
        {failing.length && !current ? <button type="button" className="btn btn-sm" onClick={() => enqueue(failing)}><RotateCcw size={12} /> Retry failed</button> : null}
        {current ? (
          <button type="button" className="btn btn-sm" disabled={stopping} onClick={() => { stop.current = true; setStopping(true); }}
            title="Lets the job that's running finish, then runs no more">
            <Square size={12} /> {stopping ? "Stopping after this one…" : "Stop"}
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => enqueue(sections.flatMap((x) => x.list))}
            title="Every job, one after another, Smartlead first and the daily stats last">
            <PlayCircle size={13} /> Run all
          </button>
        )}
      </div>
      {sections.map((x) => (
        <section key={x.key} className="sync-section" aria-labelledby={`sync-${x.key}`}>
          <div className="sync-section-head">
            <div className="list-main">
              <span id={`sync-${x.key}`} className="sync-section-title">{x.title} <span className="text-faint">{x.list.length}</span></span>
              {x.sub ? <span className="list-meta">{x.sub}</span> : null}
            </div>
            <button type="button" className="btn btn-sm" disabled={x.list.every((j) => rowState(j) !== "idle")} onClick={() => enqueue(x.list)}>
              <Play size={12} /> Run {x.list.length === 1 ? "" : "all "}{x.title === "Other" ? "" : x.title}
            </button>
          </div>
          <div className="list">
            {x.list.map((j) => (
              <JobRow key={j.name} job={j} now={now} outcome={outcomes[j.name]} onRun={() => enqueue([j])}
                state={rowState(j)} startedHere={current?.job.name === j.name ? current.startedAt : null} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function JobRow({ job, now, state, startedHere, outcome, onRun }: { job: SyncJob; now: number; state: RowState; startedHere: number | null; outcome?: Outcome; onRun: () => void }) {
  const ok = outcome ? outcome.ok : job.lastOk;
  const active = state === "here" || state === "server";
  const waiting = state === "queued" || state === "server-queued";
  const late = state === "idle" && !outcome && isBehind(job, now);
  const tone = active ? "info" : waiting || ok == null ? "faint" : !ok ? "danger" : late ? "warning" : "success";
  const said = outcome ? outcome.text : ok === false ? job.lastError : job.summary;
  const length = lastTook(job);
  const usual = length != null ? ` · took ${took(length)} last time` : "";
  return (
    <div className="list-row" style={{ alignItems: "flex-start", paddingTop: 10, paddingBottom: 10 }}>
      <span className={`dot tone-${tone}${active ? " is-pulse" : ""}`} style={{ marginTop: 6 }} />
      <div className="list-main">
        <span className="list-title">{job.label}</span>
        <span className="list-meta" style={{ whiteSpace: "normal" }} suppressHydrationWarning>
          {state === "here" ? <>Asked for from here · {took(now - (startedHere ?? now))}{usual}</>
            : state === "server" ? <>Running on the server · started {ago(job.lastStartedAt, now)}{usual}</>
            : state === "server-queued" ? <>Waiting for the server: it runs one job at a time</>
            : state === "queued" ? <>Waiting in the queue</>
            : (
              <>
                {outcome ? "Just now · " : job.lastFinishedAt ? `${ago(job.lastFinishedAt, now)} · ` : "Not run yet · "}
                every {job.everyMinutes} min
                {!outcome && length != null ? ` · took ${took(length)}` : ""}
                {late ? <span className="text-warning-ink"> · behind schedule</span> : null}
                {said ? (ok === false ? <span className="text-danger-ink"> · {said}</span> : ` · ${said}`) : null}
              </>
            )}
        </span>
      </div>
      <button type="button" className="btn btn-sm" disabled={state !== "idle"} onClick={onRun}
        title={state === "server" ? "The server is running it now" : waiting ? "Waiting its turn in the queue" : undefined}>
        <Play size={12} /> {active ? "Running…" : waiting ? "Queued" : "Run now"}
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
