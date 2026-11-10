"use client";

import { ExternalLink, FlaskConical, Plus, RefreshCw } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { cancelPlacementTest, runJobNow } from "@/app/actions";
import { Empty } from "@/components/ui";
import { ago, int, summarize } from "@/lib/format";
import { VERDICT_META, WAIT_HOURS, emptyTally, placementVerdict, rate, type Tally } from "@/lib/placement-tests";
import type { BatchRow } from "@/lib/placement-tests-db";

type Domain = BatchRow["domains"][number];
type Campaign = Domain["campaigns"][number];

const STEP_LABEL: Record<string, string> = {
  create: "Creating", settings: "Settings", schedule: "Schedule", sequence: "Copy", accounts: "Inboxes", leads: "Seeds", start: "Starting",
};

const tallyOf = (c: Campaign | undefined): Tally => (c ? { total: c.total, sent: c.sent, replied: c.replied, bounced: c.bounced } : emptyTally());
const pct = (r: number | null) => (r == null ? "—" : `${Math.round(r * 100)}%`);
const when = (d: string) => new Date(d).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function CampaignCell({ c, now }: { c: Campaign | undefined; now: number }) {
  if (!c) return <span className="zero">—</span>;
  if (c.step === "failed") return <span className="pt-err" title={c.lastError ?? undefined}>Failed: {c.lastError ?? "unknown error"}</span>;
  if (c.step === "cancelled") return <span className="zero">Cancelled</span>;
  if (STEP_LABEL[c.step]) {
    return (
      <div className="ur-two">
        <span className="zero">Setting up: {STEP_LABEL[c.step]}</span>
        {c.lastError ? <span className="pt-err ur-clip" title={c.lastError}>Retrying: {c.lastError}</span> : null}
      </div>
    );
  }
  const delivered = c.sent - c.bounced;
  const waitingFor = c.lastSentAt ? Math.max(0, WAIT_HOURS - (now - new Date(c.lastSentAt).getTime()) / 3_600_000) : null;
  return (
    <div className="ur-two">
      <span className="num"><b>{int(c.replied)}</b> / {int(delivered)} <span className="zero">· {pct(rate(tallyOf(c)))}</span></span>
      <span className="ur-sub">
        {c.sent < (c.leadsAdded ?? c.total) ? `${int(c.sent)} of ${int(c.leadsAdded ?? c.total)} sent` : c.closedAt ? "Final" : waitingFor != null ? `Final in ${Math.ceil(waitingFor)}h` : "Sent"}
        {c.bounced ? ` · ${int(c.bounced)} bounced` : ""}
      </span>
    </div>
  );
}

function Batch({ b, now }: { b: BatchRow; now: number }) {
  const [pending, run] = useTransition();
  const byId = new Map(b.domains.map((d) => [d.id, d]));
  const pick = (d: Domain | undefined, v: "sales" | "neutral") => d?.campaigns.find((c) => c.variant === v);
  const closed = (d: Domain | undefined) => !!d && d.campaigns.length > 0 && d.campaigns.every((c) => c.step === "closed");
  const tested = b.domains.filter((d) => d.role === "test");
  const controls = b.domains.filter((d) => d.role === "control");
  const all = b.domains.flatMap((d) => d.campaigns);
  const sent = all.reduce((n, c) => n + c.sent, 0), total = all.reduce((n, c) => n + c.total, 0);
  const setup = all.filter((c) => STEP_LABEL[c.step]).length;
  const failed = all.filter((c) => c.step === "failed").length;
  const state = b.status === "cancelled" ? "Cancelled" : b.status === "done" ? "Finished" : setup ? `Setting up ${setup} campaign${setup === 1 ? "" : "s"}`
    : new Date(b.startsAt).getTime() > now && !sent ? `Starts ${when(b.startsAt)}` : sent < total ? `Sending: ${int(sent)} of ${int(total)}` : "Waiting for auto-replies";

  const cancel = () => run(async () => {
    const r = await cancelPlacementTest(b.id);
    if (!r.ok) return void toast.error(r.error);
    toast.success("Test cancelled. Its campaigns are being stopped in Smartlead");
  });

  return (
    <section className="table-wrap pt-batch">
      <header className="pt-batch-head">
        <div className="flex min-w-0 flex-col">
          <b>{tested.length} domain{tested.length === 1 ? "" : "s"} tested · {controls.length} control{controls.length === 1 ? "" : "s"}</b>
          <span className="ur-sub">
            {state}{failed ? ` · ${failed} campaign${failed === 1 ? "" : "s"} failed` : ""} · {b.seedsPerCampaign} seeds a campaign · created {ago(b.createdAt, now)}{b.createdBy ? ` by ${b.createdBy}` : ""}
          </span>
        </div>
        <span className="spacer-auto" />
        {b.status === "running" ? <button type="button" className="btn btn-sm btn-ghost" disabled={pending} onClick={cancel}>Cancel test</button> : null}
      </header>
      <div className="table-scroll">
        <table className="data-table pt-table">
          <colgroup><col style={{ width: "28%" }} /><col /><col /><col style={{ width: 120 }} /><col style={{ width: 150 }} /></colgroup>
          <thead><tr><th>Domain</th><th title="Auto-replies out of delivered emails, for the client's real first email">Real copy</th><th title="The same for the short neutral note">Neutral note</th><th title="The real copy's and the note's rates as a share of the control's">Vs control</th><th>Verdict</th></tr></thead>
          <tbody>
            {[...tested, ...controls].map((d) => {
              const control = d.controlId ? byId.get(d.controlId) : undefined;
              const t = { sales: tallyOf(pick(d, "sales")), neutral: tallyOf(pick(d, "neutral")) };
              const ct = control ? { sales: tallyOf(pick(control, "sales")), neutral: tallyOf(pick(control, "neutral")) } : null;
              const verdict = d.role === "control" ? "control" : placementVerdict(t, ct, closed(d) && closed(control));
              const meta = VERDICT_META[verdict];
              const share = (a: Tally, c: Tally | undefined) => { const x = rate(a), y = c ? rate(c) : null; return x != null && y ? `${Math.round((100 * x) / y)}%` : "—"; };
              const smIds = d.campaigns.map((c) => c.smartleadId).filter(Boolean);
              return (
                <tr key={d.id} className={d.role === "control" ? "pt-control" : undefined}>
                  <td>
                    <div className="ur-two">
                      <span className="strong ur-clip">{d.domain}</span>
                      <span className="ur-sub ur-clip">
                        {d.client ?? "No client"}{control ? ` · vs ${control.domain}` : ""}
                        {smIds.length ? <> · <a className="pt-link" href={`https://app.smartlead.ai/app/email-campaign/${smIds[0]}/analytics`} target="_blank" rel="noreferrer">Smartlead <ExternalLink size={11} /></a></> : null}
                      </span>
                    </div>
                  </td>
                  <td><CampaignCell c={pick(d, "sales")} now={now} /></td>
                  <td><CampaignCell c={pick(d, "neutral")} now={now} /></td>
                  <td className="num">
                    {ct ? <div className="ur-two"><span>{share(t.sales, ct.sales)}</span><span className="ur-sub">{share(t.neutral, ct.neutral)} note</span></div> : <span className="zero">—</span>}
                  </td>
                  <td><span className={`badge${meta.tone === "faint" ? "" : ` tone-${meta.tone}`}`} title={meta.hint}>{meta.label}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function TestsView({ batches, readySeeds, onNew, lastRun }: {
  batches: BatchRow[];
  readySeeds: number;
  onNew: () => void;
  lastRun: { finishedAt: string | null; ok: boolean | null; error: string | null } | null;
}) {
  const [now] = useState(() => Date.now());
  const [pending, start] = useTransition();
  const running = batches.filter((b) => b.status === "running").length;

  const checkNow = () => start(async () => {
    const r = await runJobNow("placement-tests");
    if (!r.ok) return void toast.error(r.error);
    toast.success(`Placement tests: ${summarize(r.data) ?? "nothing to do"}`);
  });

  return (
    <div className="ur">
      <div className="ur-bar">
        <dl className="inb-kpis" aria-label="Placement test numbers">
          <div className="inb-kpi"><dt>Running</dt><dd>{int(running)}</dd></div>
          <div className="inb-kpi"><dt>Tests</dt><dd>{int(batches.length)}</dd></div>
          <div className="inb-kpi" title="Google seeds that can be emailed now"><dt>Ready seeds</dt><dd>{int(readySeeds)}</dd></div>
        </dl>
        <span className="spacer-auto" />
        <span className={`ur-sync${lastRun?.ok === false ? " is-bad" : ""}`} title={lastRun?.error ?? "Campaigns are set up and read every 2 minutes"}>
          {lastRun?.finishedAt ? `Checked ${ago(lastRun.finishedAt, now)}` : "Not run yet"}{lastRun?.ok === false ? " · failed" : ""}
        </span>
        <button type="button" className="btn btn-sm" disabled={pending} onClick={checkNow} title="Set up waiting campaigns and read results now">
          <RefreshCw size={13} className={pending ? "spin" : undefined} /> {pending ? "Checking…" : "Check now"}
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={onNew}><Plus size={13} /> New test</button>
      </div>
      {batches.length ? batches.map((b) => <Batch key={b.id} b={b} now={now} />) : (
        <div className="table-wrap">
          <Empty icon={FlaskConical} title="No placement tests yet"
            action={<button type="button" className="btn btn-sm btn-primary" onClick={onNew}><Plus size={13} /> New test</button>}>
            Pick a few domains: each sends its client&apos;s real first email and a neutral note to seeds, next to a control domain.
            Whether the seeds auto-reply shows if the domain lands in the inbox, and whether it&apos;s the copy or the domain.
          </Empty>
        </div>
      )}
    </div>
  );
}
