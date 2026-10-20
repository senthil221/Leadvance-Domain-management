"use client";

import { Dialog } from "radix-ui";
import { CalendarClock, Play, Plus, Shuffle, Trash2, TriangleAlert } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { deleteSendingPlan, runSendingPlanNow, saveSendingPlan, setSendingPlanEnabled } from "@/app/actions";
import { ClientCell } from "@/components/ui";
import { int } from "@/lib/format";
import type { ClientRow, PlanRow } from "@/lib/queries";

const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

// Daily sending plans: every morning each plan gives its inboxes new daily
// limits, either the same total split differently or a new total.
export function PlansCard({ plans, clients, selectedDomainIds, timezone }: { plans: PlanRow[]; clients: ClientRow[]; selectedDomainIds: string[]; timezone: string }) {
  const [editing, setEditing] = useState<PlanRow | "new" | null>(null);
  const [pending, start] = useTransition();

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error((r as { error: string }).error);
      else toast.success(done);
    });

  return (
    <section className="card" aria-labelledby="plans-title">
      <div className="card-head">
        <h2 id="plans-title" className="card-title flex items-center gap-2"><Shuffle size={14} strokeWidth={1.75} /> Daily sending plans</h2>
        <span className="card-sub">new daily limits every morning ({timezone})</span>
        <button type="button" className="btn btn-sm ml-auto" onClick={() => setEditing("new")}><Plus size={13} /> New plan</button>
      </div>
      {plans.length === 0 ? (
        <p className="card-body text-[12.5px] text-muted">
          No plans yet. A plan keeps a client&apos;s (or chosen domains&apos;) total daily sends where you want it, while every inbox gets a different
          limit each day, or picks a new total each day too.
        </p>
      ) : (
        <div className="list">
          {plans.map((p) => (
            <div key={p.id} className="list-row flex-wrap" style={{ alignItems: "center" }}>
              <div className="list-main" style={{ minWidth: 220 }}>
                <span className="list-title flex items-center gap-2">
                  {p.name}
                  {!p.enabled ? <span className="badge">Paused</span> : null}
                </span>
                <span className="list-meta flex items-center gap-1.5">
                  {p.clientId ? <ClientCell name={p.clientName} hue={p.clientHue} /> : `${p.domainIds.length} domains`} · {int(p.inboxes)} inboxes · {hourLabel(p.runHour)}
                </span>
              </div>
              <span className="text-[12.5px] text-muted">
                {p.mode === "shuffle" ? <><b className="num text-ink">{int(p.totalMin)}</b> a day, reshuffled</> : <><b className="num text-ink">{int(p.totalMin)}–{int(p.totalMax)}</b> a day, new total daily</>}
                {" · "}{p.inboxMin}–{p.inboxMax} per inbox
              </span>
              <span className="text-[12px] text-faint" style={{ minWidth: 150 }}>
                {p.lastResult ? <>Last: {int(p.lastResult.total)} over {p.lastResult.inboxes} inboxes{p.lastResult.clamped ? <span className="text-warning-ink"> (capped)</span> : null}{p.lastRunOn ? ` · ${p.lastRunOn}` : ""}</> : "Not run yet"}
              </span>
              <span className="ml-auto flex items-center gap-1">
                <button type="button" className="btn btn-sm" disabled={pending} onClick={() => act(() => runSendingPlanNow(p.id), `${p.name}: new limits queued`)}><Play size={12} /> Run now</button>
                <button type="button" className="btn btn-sm" onClick={() => setEditing(p)}>Edit</button>
                <button type="button" className="btn btn-sm" disabled={pending} onClick={() => act(() => setSendingPlanEnabled(p.id, !p.enabled), p.enabled ? "Plan paused" : "Plan resumed")}>{p.enabled ? "Pause" : "Resume"}</button>
                <button type="button" className="icon-btn" aria-label={`Delete ${p.name}`} disabled={pending}
                  onClick={() => { if (confirm(`Delete the plan "${p.name}"? Inbox limits stay as they are.`)) act(() => deleteSendingPlan(p.id), "Plan deleted"); }}>
                  <Trash2 size={13} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      <PlanDialog plan={editing} onClose={() => setEditing(null)} clients={clients} selectedDomainIds={selectedDomainIds} />
    </section>
  );
}

function PlanDialog({ plan, onClose, clients, selectedDomainIds }: { plan: PlanRow | "new" | null; onClose: () => void; clients: ClientRow[]; selectedDomainIds: string[] }) {
  const existing = plan && plan !== "new" ? plan : null;
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"client" | "domains">("client");
  const [clientId, setClientId] = useState("");
  const [mode, setMode] = useState<"shuffle" | "random_total">("shuffle");
  const [totalMin, setTotalMin] = useState("");
  const [totalMax, setTotalMax] = useState("");
  const [inboxMin, setInboxMin] = useState("12");
  const [inboxMax, setInboxMax] = useState("18");
  const [hour, setHour] = useState(6);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const key = plan === null ? null : existing ? existing.id : "new";
  const [lastKey, setLastKey] = useState<string | null>(null);
  if (key !== lastKey) {
    setLastKey(key);
    if (key !== null) {
      setName(existing?.name ?? "");
      setScope(existing ? (existing.clientId ? "client" : "domains") : selectedDomainIds.length ? "domains" : "client");
      setClientId(existing?.clientId ?? clients[0]?.id ?? "");
      setMode(existing?.mode ?? "shuffle");
      setTotalMin(existing ? String(existing.totalMin) : "");
      setTotalMax(existing ? String(existing.totalMax) : "");
      setInboxMin(String(existing?.inboxMin ?? 12));
      setInboxMax(String(existing?.inboxMax ?? 18));
      setHour(existing?.runHour ?? 6);
      setError(null);
    }
  }
  const domainIds = existing && !existing.clientId ? existing.domainIds : selectedDomainIds;

  const submit = () => {
    setError(null);
    const blank = [totalMin, inboxMin, inboxMax, ...(mode === "random_total" ? [totalMax] : [])].some((x) => x.trim() === "");
    if (blank) return void setError("Fill in the totals and the per-inbox range");
    if (Number(inboxMax) === 0) return void setError("The highest per inbox must be above 0, or the inboxes would stop sending");
    start(async () => {
      const r = await saveSendingPlan({
        id: existing?.id,
        name,
        mode,
        totalMin: Number(totalMin) || 0,
        totalMax: Number(mode === "shuffle" ? totalMin : totalMax) || 0,
        inboxMin: Number(inboxMin) || 0,
        inboxMax: Number(inboxMax) || 0,
        clientId: scope === "client" ? clientId || null : null,
        domainIds: scope === "domains" ? domainIds : [],
        runHour: hour,
        enabled: existing?.enabled ?? true,
      });
      if (!r.ok) return void setError(r.error);
      onClose();
      toast.success(existing ? "Plan saved" : "Plan created", { description: "Press Run now to apply it today, or it runs at its hour." });
    });
  };

  return (
    <Dialog.Root open={plan !== null} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog">
          <div className="dialog-head">
            <Dialog.Title className="dialog-title">{existing ? "Edit plan" : "New daily sending plan"}</Dialog.Title>
            <Dialog.Description className="dialog-desc">Every day at the chosen hour, each inbox gets a new campaign limit.</Dialog.Description>
          </div>
          <div className="dialog-body">
            <label className="field"><span className="field-label">Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kapable daily mix" /></label>
            <div className="field">
              <span className="field-label">Covers</span>
              <div className="seg" role="group" aria-label="Covers">
                <button type="button" aria-pressed={scope === "client"} onClick={() => setScope("client")}>A client&apos;s sending domains</button>
                <button type="button" aria-pressed={scope === "domains"} disabled={!domainIds.length} onClick={() => setScope("domains")}>{domainIds.length} selected domains</button>
              </div>
              {scope === "client" ? (
                <select className="select" value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Client">
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              ) : null}
              {!domainIds.length && !existing ? <span className="field-hint">To cover specific domains, select them in the table first.</span> : null}
            </div>
            <div className="field">
              <span className="field-label">Daily total</span>
              <div className="seg" role="group" aria-label="Daily total">
                <button type="button" aria-pressed={mode === "shuffle"} onClick={() => setMode("shuffle")}>Same total, reshuffled</button>
                <button type="button" aria-pressed={mode === "random_total"} onClick={() => setMode("random_total")}>New total each day</button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="field"><span className="field-label">{mode === "shuffle" ? "Total per day" : "Lowest total"}</span><input className="input num" type="number" min={0} value={totalMin} onChange={(e) => setTotalMin(e.target.value)} /></label>
              {mode === "random_total" ? <label className="field"><span className="field-label">Highest total</span><input className="input num" type="number" min={0} value={totalMax} onChange={(e) => setTotalMax(e.target.value)} /></label> : null}
              <label className="field"><span className="field-label">Lowest per inbox</span><input className="input num" type="number" min={0} max={1000} value={inboxMin} onChange={(e) => setInboxMin(e.target.value)} /></label>
              <label className="field"><span className="field-label">Highest per inbox</span><input className="input num" type="number" min={0} max={1000} value={inboxMax} onChange={(e) => setInboxMax(e.target.value)} /></label>
              <label className="field"><span className="field-label flex items-center gap-1.5"><CalendarClock size={12} /> Runs at</span>
                <select className="select" value={hour} onChange={(e) => setHour(Number(e.target.value))}>
                  {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
                </select>
              </label>
            </div>
            <p className="field-hint">If the total doesn&apos;t fit the per-inbox range, it is raised or capped to what the inboxes can carry.</p>
            {error ? <div className="callout tone-danger" role="alert"><TriangleAlert size={15} strokeWidth={1.75} /><span>{error}</span></div> : null}
          </div>
          <div className="dialog-foot">
            <span className="spacer" />
            <Dialog.Close asChild><button type="button" className="btn">Cancel</button></Dialog.Close>
            <button type="button" className="btn btn-primary" disabled={pending} onClick={submit}>{pending ? "Saving…" : existing ? "Save plan" : "Create plan"}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
