"use client";

import { Check, Copy, Play } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { runJobNow } from "@/app/actions";
import { ago, summarize } from "@/lib/format";

export type SyncJob = { name: string; label: string; everyMinutes: number; lastFinishedAt: Date | null; lastOk: boolean | null; lastError: string | null; summary: string | null };

export function SyncPanel({ jobs }: { jobs: SyncJob[] }) {
  return (
    <div className="list">
      {jobs.map((j) => <JobRow key={j.name} job={j} />)}
    </div>
  );
}

function JobRow({ job }: { job: SyncJob }) {
  const [pending, start] = useTransition();
  const tone = job.lastOk == null ? "faint" : job.lastOk ? "success" : "danger";
  return (
    <div className="list-row" style={{ alignItems: "flex-start", paddingTop: 10, paddingBottom: 10 }}>
      <span className={`dot tone-${tone}`} style={{ marginTop: 6 }} />
      <div className="list-main">
        <span className="list-title">{job.label}</span>
        <span className="list-meta" style={{ whiteSpace: "normal" }} suppressHydrationWarning>
          {job.lastFinishedAt ? `${ago(job.lastFinishedAt)} · ` : "Not run yet · "}every {job.everyMinutes} min
          {job.lastOk === false && job.lastError ? <span className="text-danger-ink"> · {job.lastError}</span> : job.summary ? ` · ${job.summary}` : null}
        </span>
      </div>
      <button
        type="button"
        className="btn btn-sm"
        disabled={pending}
        onClick={() => start(async () => {
          const r = await runJobNow(job.name);
          if (r.ok) toast.success(`${job.label} done`, { description: summarize(r.data) ?? undefined });
          else toast.error(`${job.label} failed`, { description: r.error });
        })}
      >
        <Play size={12} /> {pending ? "Running…" : "Run now"}
      </button>
    </div>
  );
}

export function CopyUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          toast("Webhook URL copied", { description: "Paste it into Smartlead → Settings → Webhooks." });
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
