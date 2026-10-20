"use client";

import { Dialog } from "radix-ui";
import { Info, TriangleAlert, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { setupDomains } from "@/app/actions";
import type { ClientRow } from "@/lib/queries";
import type { DomainStatus } from "@/lib/status";

export type SetupTarget = { id: string; name: string; status: DomainStatus; tags: string[]; registrar: string | null };
type NsMode = "leave" | "hypertide" | "custom";

const splitTags = (s: string) => [...new Set(s.split(/[,\n]/).map((t) => t.trim()).filter(Boolean))];

// The hand-ordering workflow: pick domains, give them a client and tags,
// point them at Hypertide and mark them as being set up, in one go.
export function SetupDialog({
  open,
  onOpenChange,
  targets,
  clients,
  allTags,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targets: SetupTarget[];
  clients: ClientRow[];
  allTags: string[];
  onDone?: () => void;
}) {
  const router = useRouter();
  const inStorage = targets.filter((t) => t.status === "in_storage").length;
  const notPorkbun = targets.filter((t) => t.registrar !== "Porkbun").length;
  const current = useMemo(() => [...new Set(targets.flatMap((t) => t.tags))].sort(), [targets]);

  const [client, setClient] = useState<string>("keep");
  const [tagText, setTagText] = useState("");
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<NsMode>("hypertide");
  const [custom, setCustom] = useState("");
  const [startSetup, setStartSetup] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Start clean each time the dialog opens for a new set of domains.
  const key = open ? targets.map((t) => t.id).join(",") : null;
  const [lastKey, setLastKey] = useState<string | null>(null);
  if (key !== lastKey) {
    setLastKey(key);
    if (key !== null) {
      setClient("keep"); setTagText(""); setRemoving(new Set()); setError(null);
      setMode(inStorage > 0 ? "hypertide" : "leave"); setCustom(""); setStartSetup(true);
    }
  }

  const n = targets.length;
  const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
  const suggestions = allTags.filter((t) => !splitTags(tagText).includes(t)).slice(0, 8);

  const submit = () => {
    setError(null);
    start(async () => {
      const res = await setupDomains({
        ids: targets.map((t) => t.id),
        clientId: client === "keep" ? undefined : client === "none" ? null : client,
        addTags: splitTags(tagText),
        removeTags: [...removing],
        nameservers: mode === "custom" ? { mode, list: custom.split(/[\s,]+/).filter(Boolean) } : { mode },
        startSetup: startSetup && inStorage > 0,
      });
      if (!res.ok) return void setError(res.error);
      onOpenChange(false);
      onDone?.();
      const parts = [
        res.data.provisioning ? `${res.data.provisioning} moved to Provisioning` : null,
        res.data.nameservers ? `nameservers queued for ${res.data.nameservers}` : null,
      ].filter(Boolean);
      toast.success(`Updated ${plural(n, "domain")}`, {
        description: parts.length ? `${parts.join(", ")}. Follow progress in Inventory.` : undefined,
        action: { label: "Inventory", onClick: () => router.push("/inventory?view=setup") },
      });
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog">
          <div className="dialog-head">
            <Dialog.Title className="dialog-title">Set up {plural(n, "domain")}</Dialog.Title>
            <Dialog.Description className="dialog-desc">
              Tag them, give them a client and point them to Hypertide before you order the inboxes.
            </Dialog.Description>
          </div>

          <div className="dialog-body">
            <label className="field">
              <span className="field-label">Client</span>
              <select className="select" value={client} onChange={(e) => setClient(e.target.value)}>
                <option value="keep">Keep as it is</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                <option value="none">No client</option>
              </select>
            </label>

            <div className="field">
              <label className="field-label" htmlFor="setup-tags">Add tags</label>
              <input id="setup-tags" className="input" value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="e.g. Oct batch, Microsoft, Kapable test" />
              {suggestions.length ? (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {suggestions.map((t) => (
                    <button key={t} type="button" className="badge hover:text-ink" onClick={() => setTagText((s) => (s.trim() ? `${s.replace(/,\s*$/, "")}, ${t}` : t))}>+ {t}</button>
                  ))}
                </div>
              ) : null}
              {current.length ? (
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <span className="field-hint">Current:</span>
                  {current.map((t) => {
                    const off = removing.has(t);
                    return (
                      <button key={t} type="button" className={`badge${off ? " tone-danger line-through" : ""}`} aria-pressed={off} title={off ? "Will be removed" : "Remove this tag"}
                        onClick={() => setRemoving((s) => { const x = new Set(s); if (x.has(t)) x.delete(t); else x.add(t); return x; })}>
                        {t} <X size={10} />
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>

            <div className="field">
              <span className="field-label">Nameservers</span>
              <div className="seg" role="group" aria-label="Nameservers">
                {([["hypertide", "Hypertide pair"], ["custom", "Custom"], ["leave", "Leave as they are"]] as const).map(([k, label]) => (
                  <button key={k} type="button" aria-pressed={mode === k} onClick={() => setMode(k)}>{label}</button>
                ))}
              </div>
              {mode === "hypertide" ? (
                <span className="field-hint">Each domain gets the Cloudflare pair Hypertide reserves for it, the same pair its order will ask for.</span>
              ) : mode === "custom" ? (
                <textarea className="textarea mono" rows={2} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="ada.ns.cloudflare.com, bob.ns.cloudflare.com" />
              ) : null}
            </div>

            {inStorage > 0 ? (
              <label className="flex items-center gap-2">
                <input type="checkbox" className="checkbox" checked={startSetup} onChange={(e) => setStartSetup(e.target.checked)} />
                <span>Move {plural(inStorage, "domain")} from storage to <b>Provisioning</b></span>
              </label>
            ) : null}

            {mode !== "leave" ? (
              <div className="callout tone-info">
                <Info size={15} strokeWidth={1.75} />
                <span>
                  Porkbun domains switch within a minute and are read back to confirm.
                  {notPorkbun ? ` ${plural(notPorkbun, "domain")} at other registrars will list the pair to set by hand in Inventory.` : ""}
                  {" "}Once the order shows up on Hypertide and the inboxes connect in Smartlead, the status moves on by itself.
                </span>
              </div>
            ) : null}
            {error ? (
              <div className="callout tone-danger" role="alert">
                <TriangleAlert size={15} strokeWidth={1.75} />
                <span>{error}</span>
              </div>
            ) : null}
          </div>

          <div className="dialog-foot">
            <span className="spacer" />
            <Dialog.Close asChild><button type="button" className="btn">Cancel</button></Dialog.Close>
            <button type="button" className="btn btn-primary" disabled={pending || n === 0} onClick={submit}>
              {pending ? "Saving…" : `Set up ${plural(n, "domain")}`}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
