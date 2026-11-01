"use client";

import { KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { removeRegistrarAccount, saveRegistrarAccount, syncRegistrarAccount } from "@/app/actions";
import { Badge } from "@/components/ui";
import { ago } from "@/lib/format";
import type { RegistrarAccountRow } from "@/lib/queries";
import { PROVIDER_ORDER, PROVIDERS, type Provider } from "@/lib/registrar-providers";

type Editing = { id?: string; provider: Provider; label: string };

/** Every registrar login: add one per account, keys are tested before they're saved. */
export function RegistrarAccounts({ accounts, envPorkbun }: { accounts: RegistrarAccountRow[]; envPorkbun: boolean }) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const nextLabel = (p: Provider) => {
    const n = accounts.filter((a) => a.provider === p).length + (p === "porkbun" && envPorkbun ? 1 : 0);
    return n ? `Account ${n + 1}` : "Main";
  };

  return (
    <div className="flex flex-col">
      <div className="list">
        {envPorkbun ? (
          <div className="list-row">
            <span className="dot tone-success" />
            <div className="list-main">
              <span className="list-title">Porkbun</span>
              <span className="list-meta">From the server&apos;s .env file (PORKBUN_API_KEY)</span>
            </div>
            <Badge tone="success">Connected</Badge>
          </div>
        ) : null}
        {accounts.map((a) => <AccountRow key={a.id} account={a} onEdit={() => setEditing({ id: a.id, provider: a.provider, label: a.label })} />)}
        {!accounts.length && !envPorkbun ? (
          <div className="list-row"><span className="list-meta" style={{ whiteSpace: "normal" }}>No registrar connected yet. Add each account below; its domains show up in Inventory.</span></div>
        ) : null}
      </div>

      {editing ? (
        <AccountForm key={`${editing.id ?? "new"}-${editing.provider}`} editing={editing} onDone={() => setEditing(null)}
          onProvider={(p) => setEditing({ provider: p, label: nextLabel(p) })} />
      ) : (
        <div className="card-body flex flex-wrap items-center gap-2" style={{ borderTop: "1px solid var(--line)" }}>
          <span className="text-muted" style={{ marginRight: 4 }}>Add account</span>
          {PROVIDER_ORDER.map((p) => (
            <button key={p} type="button" className="btn btn-sm" onClick={() => setEditing({ provider: p, label: nextLabel(p) })}>
              <Plus size={14} strokeWidth={1.5} aria-hidden="true" />{PROVIDERS[p].label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AccountRow({ account: a, onEdit }: { account: RegistrarAccountRow; onEdit: () => void }) {
  const [pending, start] = useTransition();
  const info = PROVIDERS[a.provider];
  const tone = a.lastOk == null ? "faint" : a.lastOk ? "success" : "danger";
  return (
    <div className="list-row" style={{ alignItems: "flex-start", paddingTop: 10, paddingBottom: 10 }}>
      <span className={`dot tone-${tone}`} style={{ marginTop: 6 }} />
      <div className="list-main">
        <span className="list-title">{info.label} · {a.label}</span>
        <span className="list-meta" style={{ whiteSpace: "normal" }} suppressHydrationWarning>
          {a.keyHint ? <>Key …<span className="mono">{a.keyHint}</span> · </> : null}
          {a.domains} domain{a.domains === 1 ? "" : "s"}
          {a.lastSyncedAt ? ` · synced ${ago(a.lastSyncedAt)}` : ""}
          {a.lastOk === false && a.lastError ? <span className="text-danger-ink"> · {a.lastError}</span> : null}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <button type="button" className="icon-btn" aria-label={`Sync ${info.label} ${a.label} now`} title="Import this account's domains now" disabled={pending}
          onClick={() => start(async () => {
            const r = await syncRegistrarAccount(a.id);
            if (r.ok) toast.success(`${info.label} · ${a.label}`, { description: r.data.message });
            else toast.error(`${info.label} · ${a.label} failed`, { description: r.error });
          })}>
          <RefreshCw size={15} strokeWidth={1.5} aria-hidden="true" className={pending ? "animate-spin" : undefined} />
        </button>
        <button type="button" className="icon-btn" aria-label={`Change keys for ${info.label} ${a.label}`} title="Rename or change keys" onClick={onEdit}>
          <KeyRound size={15} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <button type="button" className="icon-btn" aria-label={`Remove ${info.label} ${a.label}`} title="Remove" disabled={pending}
          onClick={() => {
            if (!confirm(`Remove ${info.label} · ${a.label}? Its saved keys are deleted. Its ${a.domains} domains stay in Inventory, but the app can't change their nameservers until the account is added again.`)) return;
            start(async () => {
              const r = await removeRegistrarAccount(a.id);
              if (r.ok) toast.success(`${info.label} · ${a.label} removed`);
              else toast.error(r.error);
            });
          }}>
          <Trash2 size={15} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function AccountForm({ editing, onDone, onProvider }: { editing: Editing; onDone: () => void; onProvider: (p: Provider) => void }) {
  const info = PROVIDERS[editing.provider];
  const [label, setLabel] = useState(editing.label);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const rekey = Boolean(editing.id);
  const ready = label.trim() && (rekey || info.fields.every((f) => keys[f.key]?.trim()));

  return (
    <form
      className="card-body flex flex-col gap-4"
      style={{ borderTop: "1px solid var(--line)" }}
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveRegistrarAccount({ id: editing.id, provider: editing.provider, label, keys });
          if (!r.ok) return void toast.error(r.error);
          toast.success(`${info.label} · ${label.trim()}`, { description: r.data.message });
          setKeys({});
          onDone();
        });
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        {rekey ? <span className="strong">{info.label}</span> : PROVIDER_ORDER.map((p) => (
          <button key={p} type="button" className={`btn btn-sm${p === editing.provider ? " btn-primary" : ""}`} aria-pressed={p === editing.provider} onClick={() => onProvider(p)}>
            {PROVIDERS[p].label}
          </button>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="field">
          <span className="field-label">Account name</span>
          <input className="input" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder="Main" />
          <span className="field-hint">Only for you, to tell accounts apart (for example the login email&apos;s first part).</span>
        </label>
        {info.fields.map((f) => (
          <label key={f.key} className="field">
            <span className="field-label">{f.label}</span>
            <input className="input mono" type="password" autoComplete="new-password" spellCheck={false} value={keys[f.key] ?? ""}
              placeholder={rekey ? "Leave empty to keep the saved one" : f.placeholder ?? (f.prefix ? `${f.prefix}…` : "")}
              onChange={(e) => setKeys((k) => ({ ...k, [f.key]: e.target.value }))} />
          </label>
        ))}
      </div>
      <span className="field-hint" style={{ whiteSpace: "normal" }}>
        Where to find it: {info.where}.{info.note ? ` ${info.note}` : ""} The app reads the account&apos;s domain list to test the keys, then stores them encrypted on this server. They are never shown again.
      </span>
      <div className="flex items-center gap-2">
        <button type="submit" className="btn btn-primary" disabled={!ready || pending}>{pending ? `Checking with ${info.label}…` : rekey ? "Test and save" : "Test and connect"}</button>
        <button type="button" className="btn btn-ghost" disabled={pending} onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
