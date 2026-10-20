"use client";

import { Plus } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createClient, saveHypertideTemplate, saveSettings } from "@/app/actions";
import { ClientCell } from "@/components/ui";
import type { ClientRow } from "@/lib/queries";

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
