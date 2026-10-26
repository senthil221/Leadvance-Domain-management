"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { applyTagClients, archiveEmptyClients, createClientTags, saveTagPairs, setClientSource, setTagClient, applyBuiltInTagMap } from "@/app/actions";
import { int } from "@/lib/format";
import type { ClientRow, TagRow } from "@/lib/queries";

/**
 * How this Smartlead account tells its clients apart. Either a tag is a client
 * of the same name, or you list which tags belong to which client (several
 * tags can share one client, for example one tag per sender).
 */
export function ClientAssignment({ source, clients, tags }: { source: "tags" | "mapped"; clients: ClientRow[]; tags: TagRow[] }) {
  const [pending, startTransition] = useTransition();
  const [text, setText] = useState("");
  const run = (fn: () => Promise<void>) => startTransition(fn);
  const unmapped = tags.filter((t) => !t.clientId).length;

  return (
    <div className="card-body flex flex-col gap-4">
      <div className="flex flex-col gap-2" role="radiogroup" aria-label="Assign clients from">
        {([
          ["tags", "A tag is a client", "Each Smartlead tag becomes a client with the same name. Best when the tags are client names."],
          ["mapped", "Map tags to clients", "Only the tags you map below decide the client. Several tags can belong to one client."],
        ] as const).map(([key, label, hint]) => (
          <label key={key} className="flex cursor-pointer items-start gap-2.5">
            <input type="radio" name="client-source" className="mt-1" checked={source === key} disabled={pending}
              onChange={() => run(async () => { const r = await setClientSource(key); if (!r.ok) toast.error(r.error); })} />
            <span className="flex flex-col"><span className="strong">{label}</span><span className="field-hint">{hint}</span></span>
          </label>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary" disabled={pending}
          onClick={() => run(async () => {
            const r = await applyBuiltInTagMap();
            if (!r.ok) return void toast.error(r.error);
            toast.success(`Built-in list saved: ${r.data.saved} tags${r.data.newClients ? `, ${r.data.newClients} new client${r.data.newClients === 1 ? "" : "s"}` : ""}, ${r.data.moved} domain${r.data.moved === 1 ? "" : "s"} moved`);
          })}>Use the built-in list</button>
        <span className="field-hint">15 tags to 7 clients. Switches to mapped tags and applies it. Existing clients are kept.</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn" disabled={pending}
          onClick={() => run(async () => { const r = await createClientTags(); if (!r.ok) toast.error(r.error); else toast.success(r.data.message); })}>
          Create client tags in Smartlead
        </button>
        <span className="field-hint">One tag per client, named after the client. Tags that already exist are skipped.</span>
      </div>

      {source === "mapped" ? (
        <>
          <label className="field">
            <span className="field-label">Paste tag and client pairs</span>
            <textarea className="textarea mono" rows={6} value={text} onChange={(e) => setText(e.target.value)}
              placeholder={'Prateek Batra, Beebee\nRaghav Bansal, Beebee\nAmelia Wren, Qualifi'} />
            <span className="field-hint">One pair per line: the Smartlead tag, then the client. Quotes and trailing commas are fine. A client that doesn&apos;t exist yet is created.</span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn" disabled={!text.trim() || pending}
              onClick={() => run(async () => {
                const r = await saveTagPairs(text);
                if (!r.ok) return void toast.error(r.error);
                toast.success(`Saved ${r.data.saved} tag${r.data.saved === 1 ? "" : "s"}${r.data.newClients ? `, ${r.data.newClients} new client${r.data.newClients === 1 ? "" : "s"}` : ""}`,
                  r.data.bad.length ? { description: `Skipped ${r.data.bad.length} line${r.data.bad.length === 1 ? "" : "s"} that weren't a pair: ${r.data.bad.slice(0, 3).join(" | ")}` } : undefined);
                setText("");
              })}>Save pairs</button>
            <button type="button" className="btn" disabled={pending}
              onClick={() => run(async () => { const r = await applyTagClients(); if (!r.ok) toast.error(r.error); else toast.success(`${int(r.data.moved)} domain${r.data.moved === 1 ? "" : "s"} moved to their client`); })}>
              Apply to all domains
            </button>
            <button type="button" className="btn btn-ghost" disabled={pending}
              onClick={() => run(async () => { const r = await archiveEmptyClients(); if (!r.ok) toast.error(r.error); else toast.success(`${r.data.archived} empty client${r.data.archived === 1 ? "" : "s"} hidden`); })}>
              Hide clients with no domains
            </button>
            <span className="field-hint ml-auto">New Smartlead syncs apply the map by themselves.</span>
          </div>

          <div>
            <p className="field-label mb-1.5">Tags in Smartlead <span className="text-faint">· {tags.length}{unmapped ? `, ${unmapped} without a client` : ""}</span></p>
            <div className="list" style={{ maxHeight: 360, overflow: "auto" }}>
              {tags.length === 0 ? <p className="card-body zero">No tags yet. They appear after the first Smartlead sync.</p> : null}
              {tags.map((t) => (
                <div key={t.key} className="list-row">
                  <span className="strong">{t.tag}</span>
                  <span className="list-meta">{int(t.domains)} domain{t.domains === 1 ? "" : "s"} · {int(t.inboxes)} inbox{t.inboxes === 1 ? "" : "es"}</span>
                  <select className="select ml-auto" style={{ width: 170 }} value={t.clientId ?? ""} disabled={pending} aria-label={`Client for ${t.tag}`}
                    onChange={(e) => run(async () => { const r = await setTagClient(t.tag, e.target.value || null); if (!r.ok) toast.error(r.error); })}>
                    <option value="">No client</option>
                    {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
