"use client";

import Papa from "papaparse";
import { Dialog } from "radix-ui";
import { FileUp, Plus, TriangleAlert } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { addDomains } from "@/app/actions";
import type { VendorRow } from "@/lib/queries";

const DOMAIN_RE = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/?$/i;

// Pulls domain names out of pasted text or a CSV: any cell that looks like one.
function extract(text: string) {
  const out: string[] = [];
  const parsed = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true });
  for (const row of parsed.data) {
    for (const cell of row) {
      for (const part of String(cell).split(/[\s;]+/)) {
        const m = part.trim().match(DOMAIN_RE);
        if (m) out.push(m[1].toLowerCase());
      }
    }
  }
  return [...new Set(out)];
}

export function AddDomainsDialog({ registrars }: { registrars: VendorRow[] }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(params.get("add") === "1");
  const [text, setText] = useState("");
  const [registrarId, setRegistrarId] = useState(registrars[0]?.id ?? "");
  const [purchasedAt, setPurchasedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [cost, setCost] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const names = useMemo(() => extract(text), [text]);

  const setOpenAndUrl = (o: boolean) => {
    setOpen(o);
    if (!o && params.get("add")) router.replace(pathname);
    if (o) setError(null);
  };

  const submit = () =>
    startTransition(async () => {
      const purchased = purchasedAt || null;
      const expires = purchased ? new Date(new Date(purchased).getTime() + 365 * 86_400_000).toISOString().slice(0, 10) : null;
      const res = await addDomains({
        names,
        registrarId: registrarId || null,
        purchasedAt: purchased,
        expiresAt: expires,
        costCents: cost ? Math.round(Number(cost) * 100) : null,
      });
      if (!res.ok) return setError(res.error);
      setOpenAndUrl(false);
      setText("");
      const { added, duplicates } = res.data;
      toast.success(`Added ${added} domain${added === 1 ? "" : "s"} to storage`, {
        description: duplicates.length ? `${duplicates.length} already in inventory: ${duplicates.slice(0, 3).join(", ")}${duplicates.length > 3 ? "…" : ""}` : undefined,
      });
    });

  return (
    <Dialog.Root open={open} onOpenChange={setOpenAndUrl}>
      <Dialog.Trigger asChild>
        <button type="button" className="btn btn-primary"><Plus size={14} strokeWidth={1.75} /> Add domains</button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog">
          <div className="dialog-head">
            <Dialog.Title className="dialog-title">Add domains to storage</Dialog.Title>
            <Dialog.Description className="dialog-desc">Paste a list or import a CSV from your registrar or Google Sheet.</Dialog.Description>
          </div>
          <div className="dialog-body">
            <label className="field">
              <span className="field-label flex items-center">
                Domains
                <span className="ml-auto font-normal text-faint">{names.length ? `${names.length} found` : "one per line, or comma separated"}</span>
              </span>
              <textarea
                className="textarea mono"
                rows={7}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={"bluecrestis.com\nriverbendnetwork.com\nclearrelaypro.com"}
                autoFocus
              />
            </label>
            <div className="flex items-center gap-2">
              <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" hidden onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) {
                  const content = await f.text();
                  setText((t) => (t ? t + "\n" : "") + content);
                }
                e.target.value = "";
              }} />
              <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()}><FileUp size={14} /> Import CSV</button>
              <span className="field-hint">Any column with domain names works.</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="field">
                <span className="field-label">Registrar</span>
                <select className="select" value={registrarId} onChange={(e) => setRegistrarId(e.target.value)}>
                  {registrars.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  <option value="">Other</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">Purchased</span>
                <input className="input" type="date" value={purchasedAt} onChange={(e) => setPurchasedAt(e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">Cost per year</span>
                <input className="input" type="number" min="0" step="0.01" inputMode="decimal" placeholder="$10.15" value={cost} onChange={(e) => setCost(e.target.value)} />
              </label>
            </div>
            {error ? <div className="callout tone-danger" role="alert"><TriangleAlert size={15} strokeWidth={1.75} /><span>{error}</span></div> : null}
          </div>
          <div className="dialog-foot">
            <span className="field-hint">Renewal is set to one year after purchase.</span>
            <span className="spacer" />
            <Dialog.Close asChild><button type="button" className="btn">Cancel</button></Dialog.Close>
            <button type="button" className="btn btn-primary" disabled={!names.length || pending} onClick={submit}>
              {pending ? "Adding…" : `Add ${names.length || ""} domain${names.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
