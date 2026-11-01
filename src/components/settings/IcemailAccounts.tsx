"use client";

import { KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { removeIcemailAccount, saveIcemailAccount, syncIcemailNow } from "@/app/actions";
import { ago, int } from "@/lib/format";
import type { IcemailAccountRow } from "@/lib/queries";
import { CopyUrl } from "./SyncPanel";

type Editing = { id?: string; label: string };

const usd = (n: number, currency?: string | null) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD", maximumFractionDigits: n >= 1000 ? 0 : 2 }).format(n);

const EVENTS: Record<string, { label: string; tone: "success" | "danger" | "info" | "warning" }> = {
  "order.mailbox.active": { label: "Mailboxes active", tone: "success" },
  "order.mailbox.failed": { label: "Mailboxes failed", tone: "danger" },
  "order.domain.active": { label: "Domains active", tone: "success" },
  "order.domain.failed": { label: "Domains failed", tone: "danger" },
  "order.export.completed": { label: "Export finished", tone: "info" },
  "order.mailbox.deleted": { label: "Mailboxes deleted", tone: "warning" },
  "order.mailbox.renewed": { label: "Mailboxes renewed", tone: "info" },
  "mailbox.renewal.reminder": { label: "Mailbox renewal soon", tone: "warning" },
  "domain.renewal.reminder": { label: "Domain renewal soon", tone: "warning" },
  "mailbox.app_password.updated": { label: "App password set", tone: "info" },
  "order.client_id.completed": { label: "OAuth client ID added", tone: "success" },
  "order.client_id.failed": { label: "OAuth client ID failed", tone: "danger" },
};

/** One line on what an event was about; keys arrive camelCased from the database. */
function eventDetail(data: Record<string, unknown> | null) {
  if (!data) return "";
  const list = (k: string) => (Array.isArray(data[k]) ? (data[k] as Record<string, unknown>[]) : []);
  const failed = [...list("failedMailboxes"), ...list("failedDomains")];
  if (failed.length) {
    const first = failed[0];
    const name = String(first.username ?? first.domain ?? "");
    return `${name}${failed.length > 1 ? ` and ${failed.length - 1} more` : ""}${first.errorMessage ? `: ${String(first.errorMessage)}` : ""}`;
  }
  if (typeof data.total === "number") return `${data.total - Number(data.failedCount ?? 0)} of ${data.total} exported`;
  const boxes = list("mailboxes").length, domains = list("domains").length;
  if (boxes) return `${boxes} mailbox${boxes === 1 ? "" : "es"}`;
  if (domains) return `${domains} domain${domains === 1 ? "" : "s"}`;
  return String(data.domain ?? data.username ?? "");
}

/** Every Icemail workspace: add one per API key, tested before it's saved. */
export function IcemailAccounts({ accounts, webhookBase }: { accounts: IcemailAccountRow[]; webhookBase: string }) {
  const [editing, setEditing] = useState<Editing | null>(null);
  return (
    <div className="flex flex-col">
      <div className="list">
        {accounts.map((a) => <AccountRow key={a.id} account={a} webhookBase={webhookBase} onEdit={() => setEditing({ id: a.id, label: a.label })} />)}
        {!accounts.length ? (
          <div className="list-row"><span className="list-meta" style={{ whiteSpace: "normal" }}>No Icemail workspace connected yet. Add one below; its mailboxes are matched to the inboxes Smartlead already shows.</span></div>
        ) : null}
      </div>
      {editing ? (
        <AccountForm key={editing.id ?? "new"} editing={editing} onDone={() => setEditing(null)} />
      ) : (
        <div className="card-body flex flex-wrap items-center gap-2" style={{ borderTop: "1px solid var(--line)" }}>
          <button type="button" className="btn btn-sm" onClick={() => setEditing({ label: accounts.length ? `Workspace ${accounts.length + 1}` : "Main" })}>
            <Plus size={14} strokeWidth={1.5} aria-hidden="true" />Add Icemail workspace
          </button>
        </div>
      )}
    </div>
  );
}

function AccountRow({ account: a, webhookBase, onEdit }: { account: IcemailAccountRow; webhookBase: string; onEdit: () => void }) {
  const [pending, start] = useTransition();
  const tone = a.lastOk == null ? "faint" : a.lastOk ? "success" : "danger";
  const unmatched = a.mailboxes - a.linked;
  return (
    <div className="list-row" style={{ alignItems: "flex-start", paddingTop: 10, paddingBottom: 10 }}>
      <span className={`dot tone-${tone}`} style={{ marginTop: 6 }} />
      <div className="list-main" style={{ gap: 4 }}>
        <span className="list-title">Icemail · {a.label}{a.workspaceName && a.workspaceName !== a.label ? <span className="text-muted"> ({a.workspaceName})</span> : null}</span>
        <span className="list-meta" style={{ whiteSpace: "normal" }} suppressHydrationWarning>
          {a.keyHint ? <>Key …<span className="mono">{a.keyHint}</span> · </> : null}
          {int(a.domains)} domain{a.domains === 1 ? "" : "s"} · {int(a.mailboxes)} mailbox{a.mailboxes === 1 ? "" : "es"}
          {a.mailboxes ? ` (${unmatched ? `${int(unmatched)} not in Smartlead` : "all in Smartlead"})` : ""}
          {a.monthly ? ` · ${usd(a.monthly)}/month` : ""}
          {a.walletBalance != null ? ` · wallet ${usd(a.walletBalance, a.walletCurrency)}` : ""}
          {a.lastSyncedAt ? ` · synced ${ago(a.lastSyncedAt)}` : ""}
          {a.lastOk === false && a.lastError ? <span className="text-danger-ink"> · {a.lastError}</span> : null}
        </span>
        {a.renewing ? (
          <span className="list-meta text-warning-ink" style={{ whiteSpace: "normal" }}>
            {int(a.renewing)} mailbox{a.renewing === 1 ? "" : "es"} bill in the next 7 days ({usd(a.renewingCost)})
          </span>
        ) : null}
        {a.events.length ? (
          <span className="flex flex-col" style={{ gap: 2, marginTop: 2 }}>
            {a.events.map((e) => {
              const info = EVENTS[e.event] ?? { label: e.event, tone: "info" as const };
              const detail = eventDetail(e.data);
              return (
                <span key={e.id} className="list-meta flex items-center gap-2" style={{ whiteSpace: "normal" }} suppressHydrationWarning>
                  <span className={`dot tone-${info.tone}`} />
                  <span className={info.tone === "danger" ? "text-danger-ink" : undefined}>{info.label}</span>
                  {detail ? <span>· {detail}</span> : null}
                  <span>· {ago(e.receivedAt)}</span>
                </span>
              );
            })}
          </span>
        ) : (
          <span className="list-meta" style={{ whiteSpace: "normal" }}>No events yet. Copy the webhook address and add it in Icemail → Settings → Notification → Add Webhook URL.</span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <CopyUrl url={`${webhookBase}${a.webhookToken}`} where="Icemail → Settings → Notification → Add Webhook URL" />
        <button type="button" className="icon-btn" aria-label={`Sync Icemail ${a.label} now`} title="Read this workspace's domains and mailboxes now" disabled={pending}
          onClick={() => start(async () => {
            const r = await syncIcemailNow(a.id);
            if (r.ok) toast.success(`Icemail · ${a.label}`, { description: r.data.message });
            else toast.error(`Icemail · ${a.label} failed`, { description: r.error });
          })}>
          <RefreshCw size={15} strokeWidth={1.5} aria-hidden="true" className={pending ? "animate-spin" : undefined} />
        </button>
        <button type="button" className="icon-btn" aria-label={`Change key for Icemail ${a.label}`} title="Rename or change the key" onClick={onEdit}>
          <KeyRound size={15} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <button type="button" className="icon-btn" aria-label={`Remove Icemail ${a.label}`} title="Remove" disabled={pending}
          onClick={() => {
            if (!confirm(`Remove Icemail · ${a.label}? Its saved key, synced mailbox details and events are deleted, and its webhook address stops working. Domains and Smartlead inboxes stay.`)) return;
            start(async () => {
              const r = await removeIcemailAccount(a.id);
              if (r.ok) toast.success(`Icemail · ${a.label} removed`);
              else toast.error(r.error);
            });
          }}>
          <Trash2 size={15} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function AccountForm({ editing, onDone }: { editing: Editing; onDone: () => void }) {
  const [label, setLabel] = useState(editing.label);
  const [apiKey, setApiKey] = useState("");
  const [pending, start] = useTransition();
  const rekey = Boolean(editing.id);
  const ready = label.trim() && (rekey || apiKey.trim());
  return (
    <form
      className="card-body flex flex-col gap-4"
      style={{ borderTop: "1px solid var(--line)" }}
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveIcemailAccount({ id: editing.id, label, apiKey });
          if (!r.ok) return void toast.error(r.error);
          toast.success(`Icemail · ${label.trim()}`, { description: r.data.message });
          setApiKey("");
          onDone();
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="field">
          <span className="field-label">Workspace name</span>
          <input className="input" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder="Main" />
          <span className="field-hint">Only for you, to tell workspaces apart.</span>
        </label>
        <label className="field">
          <span className="field-label">API key</span>
          <input className="input mono" type="password" autoComplete="new-password" spellCheck={false} value={apiKey}
            placeholder={rekey ? "Leave empty to keep the saved one" : ""} onChange={(e) => setApiKey(e.target.value)} />
        </label>
      </div>
      <span className="field-hint" style={{ whiteSpace: "normal" }}>
        Where to find it: Icemail → Settings → API Keys → Generate New Key. The app only reads domains, mailboxes and the wallet; it changes nothing at Icemail.
        The key is tested, then stored encrypted on this server and never shown again. The first sync reads every mailbox, so it can take a minute.
      </span>
      <div className="flex items-center gap-2">
        <button type="submit" className="btn btn-primary" disabled={!ready || pending}>{pending ? "Checking with Icemail…" : rekey ? "Test and save" : "Test and connect"}</button>
        <button type="button" className="btn btn-ghost" disabled={pending} onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
