"use client";

import { Plus } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createClient, saveHypertideTemplate, saveSettings, saveWarmupProgram } from "@/app/actions";
import { ClientCell } from "@/components/ui";
import type { ClientRow } from "@/lib/queries";
import type { WarmupProgram } from "@/lib/warmup-program";

export function LifecycleForm({ drainDays, storageLowThreshold, hypertideNameservers }: { drainDays: number; storageLowThreshold: number; hypertideNameservers: string[] }) {
  const [drain, setDrain] = useState(String(drainDays));
  const [low, setLow] = useState(String(storageLowThreshold));
  const [ns, setNs] = useState(hypertideNameservers.join("\n"));
  const [pending, startTransition] = useTransition();
  const nsList = ns.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  const dirty = drain !== String(drainDays) || low !== String(storageLowThreshold) || nsList.join(",") !== hypertideNameservers.join(",");

  return (
    <form
      className="card-body flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const r = await saveSettings({ drainDays: Number(drain), storageLowThreshold: Number(low), hypertideNameservers: nsList });
          if (!r.ok) toast.error(r.error);
          else toast.success("Settings saved");
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="field">
          <span className="field-label">Drain period</span>
          <div className="flex items-center gap-2">
            <input className="input num" style={{ width: 90 }} inputMode="numeric" value={drain} onChange={(e) => setDrain(e.target.value)} />
            <span className="text-muted">days</span>
          </div>
          <span className="field-hint">How long a replaced domain finishes its sequences before it is retired.</span>
        </label>
        <label className="field">
          <span className="field-label">Low storage warning</span>
          <div className="flex items-center gap-2">
            <input className="input num" style={{ width: 90 }} inputMode="numeric" value={low} onChange={(e) => setLow(e.target.value)} />
            <span className="text-muted">domains</span>
          </div>
          <span className="field-hint">Overview turns amber when free domains drop to this.</span>
        </label>
      </div>
      <label className="field">
        <span className="field-label">Hypertide nameservers</span>
        <textarea className="textarea mono" rows={2} style={{ minHeight: 60, maxWidth: 420 }} value={ns} onChange={(e) => setNs(e.target.value)} placeholder={"ns1.example.com\nns2.example.com"} />
        <span className="field-hint">Only used when Hypertide isn&apos;t connected; with it, each domain gets its own pair. One per line.</span>
      </label>
      <div><button type="submit" className="btn" disabled={!dirty || pending}>{pending ? "Saving…" : "Save"}</button></div>
    </form>
  );
}

/** Warm-up for new domains: switched on automatically when a young domain connects to Smartlead. */
export function WarmupProgramForm({ program }: { program: WarmupProgram }) {
  const [on, setOn] = useState(program.enabled);
  const [v, setV] = useState({ days: String(program.days), maxAgeDays: String(program.maxAgeDays), perDay: String(program.perDay), rampup: String(program.rampup), replyRate: String(program.replyRate) });
  const [pending, startTransition] = useTransition();
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((x) => ({ ...x, [k]: e.target.value }));
  const num = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Number(x)])) as Record<keyof typeof v, number>;
  const dirty = on !== program.enabled || (Object.keys(v) as (keyof typeof v)[]).some((k) => v[k] !== String(program[k]));
  const field = (k: keyof typeof v, label: string, unit: string, hint: string) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <div className="flex items-center gap-2">
        <input className="input num" style={{ width: 90 }} inputMode="numeric" value={v[k]} onChange={set(k)} />
        <span className="text-muted">{unit}</span>
      </div>
      <span className="field-hint">{hint}</span>
    </label>
  );
  return (
    <form
      className="card-body flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const r = await saveWarmupProgram({ enabled: on, ...num });
          if (!r.ok) toast.error(r.error);
          else toast.success(on ? "Saved. New domains are warmed up automatically" : "Saved. Automatic warm-up is off");
        });
      }}
    >
      <label className="flex cursor-pointer items-start gap-2.5">
        <input type="checkbox" className="checkbox mt-1" checked={on} onChange={(e) => setOn(e.target.checked)} />
        <span className="flex flex-col">
          <span className="strong">Start warm-up automatically once DNS is valid</span>
          <span className="field-hint">New domains show under Smartlead → Warming up as soon as they connect. When SPF, DKIM, DMARC and MX are all found, warmup is switched on with the values below and the inboxes are tagged New. Off: you start them with Start warm-up.</span>
        </span>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="field">
          <span className="field-label">Warm up for</span>
          <div className="seg" role="group" aria-label="Warm-up days" style={{ width: "fit-content" }}>
            {["12", "13", "14"].map((d) => (
              <button key={d} type="button" aria-pressed={v.days === d} onClick={() => setV((x) => ({ ...x, days: d }))}>{d} days</button>
            ))}
          </div>
          <span className="field-hint">Days counted from the start of warm-up, shown as a day-by-day track.</span>
        </div>
        {field("maxAgeDays", "New means at most", "days old", "Age counts from the first inbox added to Smartlead. 0 is only today's.")}
        {field("perDay", "Warmup emails a day", "per inbox", "Smartlead's total warmup per day.")}
        {field("rampup", "Ramp-up", "per day", "How much the daily warmup grows each day.")}
        {field("replyRate", "Reply rate", "%", "Share of warmup emails that get a reply.")}
      </div>
      <div><button type="submit" className="btn" disabled={!dirty || pending}>{pending ? "Saving…" : "Save"}</button></div>
    </form>
  );
}

export function ClientsList({ clients }: { clients: ClientRow[] }) {
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  return (
    <>
      <div className="list">
        {clients.map((c) => (
          <div key={c.id} className="list-row">
            <ClientCell name={c.name} hue={c.hue} />
            <span className="list-meta ml-auto">{c.activeCount} active domain{c.activeCount === 1 ? "" : "s"}</span>
          </div>
        ))}
      </div>
      <form
        className="flex gap-2 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(async () => {
            const r = await createClient(name);
            if (!r.ok) return void toast.error(r.error);
            toast.success(`Added ${name.trim()}`);
            setName("");
          });
        }}
      >
        <input className="input" placeholder="New client name" value={name} onChange={(e) => setName(e.target.value)} aria-label="New client name" />
        <button type="submit" className="btn" disabled={!name.trim() || pending}><Plus size={14} /> Add</button>
      </form>
    </>
  );
}

type Template = { plan: "entra" | "google"; inbox_quantity: 25 | 50; forwarding_domain: string; client_name: string };

export function HypertideOrderForm({ template }: { template: Template }) {
  const [t, setT] = useState<Template>(template);
  const [pending, startTransition] = useTransition();
  const dirty = JSON.stringify(t) !== JSON.stringify(template);
  return (
    <form
      className="card-body flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const r = await saveHypertideTemplate(t);
          if (!r.ok) toast.error(r.error);
          else toast.success("Hypertide order settings saved");
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="field">
          <span className="field-label">Plan</span>
          <select className="select" value={t.plan} onChange={(e) => setT({ ...t, plan: e.target.value as Template["plan"] })}>
            <option value="entra">Microsoft (Entra)</option>
            <option value="google">Google Workspace (3 inboxes)</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Inboxes per domain</span>
          <select className="select" value={t.inbox_quantity} disabled={t.plan === "google"}
            onChange={(e) => setT({ ...t, inbox_quantity: Number(e.target.value) as Template["inbox_quantity"] })}>
            <option value={50}>50 (+2 spare)</option>
            <option value={25}>25 (+2 spare)</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Forwarding domain</span>
          <input className="input" value={t.forwarding_domain} placeholder="yourcompany.com" onChange={(e) => setT({ ...t, forwarding_domain: e.target.value })} />
          <span className="field-hint">Where replies to the new inboxes are forwarded.</span>
        </label>
        <label className="field">
          <span className="field-label">Default client name</span>
          <input className="input" value={t.client_name} placeholder="Used when a domain has no client" onChange={(e) => setT({ ...t, client_name: e.target.value })} />
        </label>
      </div>
      <p className="field-hint">
        Sender names, warmup and daily limits are copied from the domain being replaced. Orders are placed unpaid; nothing is charged until you approve payment on the Replacements page.
      </p>
      <div><button type="submit" className="btn" disabled={!dirty || pending}>{pending ? "Saving…" : "Save"}</button></div>
    </form>
  );
}
