"use client";

import { ClipboardPaste, Copy, Search } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { applyBuiltInTagMap, applyTagClients, archiveEmptyClients, createClientTags, saveSenderPairs, saveTagPairs, setClientSource, setSenderClient, setTagClient } from "@/app/actions";
import { int } from "@/lib/format";
import type { ClientRow, SenderRow, TagRow } from "@/lib/queries";

const plural = (n: number, one: string, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;

/**
 * How this Smartlead account tells its clients apart. Either a tag is a client
 * of the same name, or you list which tags belong to which client (several
 * tags can share one client, for example one tag per sender).
 */
export function ClientSourcePicker({ source }: { source: "tags" | "mapped" }) {
  const [pending, startTransition] = useTransition();
  return (
    <div className="st-choice" role="radiogroup" aria-label="Assign clients from">
      {([
        ["tags", "A tag is a client", "Each Smartlead tag becomes a client with the same name. Best when the tags are client names."],
        ["mapped", "Map tags to clients", "Only the tags you map decide the client. Several tags can belong to one client."],
      ] as const).map(([key, label, hint]) => (
        <label key={key} className="st-choice-item" data-on={source === key}>
          <input type="radio" name="client-source" checked={source === key} disabled={pending}
            onChange={() => startTransition(async () => { const r = await setClientSource(key); if (!r.ok) toast.error(r.error); })} />
          <span className="flex flex-col gap-0.5"><span className="strong">{label}</span><span className="field-hint">{hint}</span></span>
        </label>
      ))}
    </div>
  );
}

type MapRow = { key: string; name: string; domains: number; inboxes: number; clientId: string | null; current?: string[] };

/** A searchable list of names (sender names or tags), each with the client it belongs to, and a box to paste pairs. */
function MapList({ rows, clients, noun, placeholder, onSet, onPaste, empty }: {
  rows: MapRow[]; clients: ClientRow[]; noun: string; placeholder: string; empty: string;
  onSet: (name: string, clientId: string | null) => Promise<string | null>;
  onPaste: (text: string) => Promise<boolean>;
}) {
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<"all" | "unmapped">("all");
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState("");
  const unmapped = rows.filter((r) => !r.clientId).length;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => (only === "all" || !r.clientId) && (!needle || r.name.toLowerCase().includes(needle)));
  }, [rows, q, only]);
  const copy = () => {
    const lines = rows.map((r) => `${r.name}, ${clients.find((c) => c.id === r.clientId)?.name ?? ""}`);
    void navigator.clipboard.writeText(lines.join("\n")).then(() => toast.success(`Copied ${plural(rows.length, noun)}. Fill in the client after each comma and paste it back.`));
  };

  return (
    <div className="st-map">
      <div className="st-map-bar">
        <label className="search-input">
          <Search size={14} strokeWidth={1.5} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${noun}s`} aria-label={`Search ${noun}s`} />
        </label>
        <div className="seg" role="group" aria-label="Show">
          <button type="button" aria-pressed={only === "all"} onClick={() => setOnly("all")}>All {int(rows.length)}</button>
          <button type="button" aria-pressed={only === "unmapped"} onClick={() => setOnly("unmapped")}>No client {int(unmapped)}</button>
        </div>
        <span className="spacer-auto" />
        <button type="button" className="btn btn-sm" disabled={!rows.length} onClick={copy} title={`Copy every ${noun} with its client, one per line`}><Copy size={14} /> Copy list</button>
        <button type="button" className="btn btn-sm" aria-pressed={pasting} onClick={() => setPasting((x) => !x)}><ClipboardPaste size={14} /> Paste pairs</button>
      </div>

      {pasting ? (
        <div className="st-paste">
          <textarea className="textarea mono" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label={`${noun} and client pairs`} />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary btn-sm" disabled={!text.trim() || pending}
              onClick={() => startTransition(async () => { if (await onPaste(text)) { setText(""); setPasting(false); } })}>Save pairs</button>
            <span className="field-hint">One per line: the {noun}, a comma, then the client. A client that doesn&apos;t exist yet is created.</span>
          </div>
        </div>
      ) : null}

      <div className="st-map-list">
        {rows.length === 0 ? <p className="st-map-empty">{empty}</p> : shown.length === 0 ? <p className="st-map-empty">Nothing matches.</p> : null}
        {shown.map((r) => (
          <div key={r.key} className="st-map-row" data-unmapped={!r.clientId}>
            <span className="st-map-name">
              <span className="strong">{r.name}</span>
              <span className="st-map-meta">
                {plural(r.domains, "domain")} · {plural(r.inboxes, "inbox", "inboxes")}
                {r.current?.length ? <> · now under {r.current.join(", ")}</> : null}
              </span>
            </span>
            <select className="select" value={r.clientId ?? ""} disabled={pending} aria-label={`Client for ${r.name}`}
              onChange={(e) => {
                const id = e.target.value || null;
                startTransition(async () => { const err = await onSet(r.name, id); if (err) toast.error(err); });
              }}>
              <option value="">No client</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Sender names (the From name on each inbox) mapped to clients. */
export function SenderMap({ senders, clients }: { senders: SenderRow[]; clients: ClientRow[] }) {
  return (
    <MapList
      rows={senders.map((s) => ({ key: s.key, name: s.tag, domains: s.domains, inboxes: s.inboxes, clientId: s.clientId, current: s.current }))}
      clients={clients} noun="sender name" empty="No sender names yet. They appear after the first Smartlead sync."
      placeholder={"Sophia Lark, Qualifi\nNeil Cornelius, B2bdrive\nPrateek Batra, Beebee"}
      onSet={async (name, id) => {
        const r = await setSenderClient(name, id);
        if (!r.ok) return r.error;
        toast.success(id ? `${name} saved${r.data.moved ? `, ${plural(r.data.moved, "domain")} moved` : ""}` : `${name} has no client now`);
        return null;
      }}
      onPaste={async (text) => {
        const r = await saveSenderPairs(text);
        if (!r.ok) { toast.error(r.error); return false; }
        toast.success(`Saved ${plural(r.data.saved, "sender name")}${r.data.newClients ? `, ${plural(r.data.newClients, "new client")}` : ""}, ${plural(r.data.moved, "domain")} moved`,
          r.data.bad.length ? { description: `Skipped ${plural(r.data.bad.length, "line")} that weren't a pair: ${r.data.bad.slice(0, 3).join(" | ")}` } : undefined);
        return true;
      }}
    />
  );
}

/** Smartlead tags mapped to clients, with the actions that go with them. */
export function TagMap({ source, clients, tags, savedList }: { source: "tags" | "mapped"; clients: ClientRow[]; tags: TagRow[]; savedList: { tag: string; client: string }[] }) {
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<void>) => startTransition(fn);
  return (
    <>
      {source === "mapped" ? (
        <MapList
          rows={tags.map((t) => ({ key: t.key, name: t.tag, domains: t.domains, inboxes: t.inboxes, clientId: t.clientId }))}
          clients={clients} noun="tag" empty="No tags yet. They appear after the first Smartlead sync."
          placeholder={"Prateek Batra, Beebee\nRaghav Bansal, Beebee\nAmelia Wren, Qualifi"}
          onSet={async (name, id) => { const r = await setTagClient(name, id); return r.ok ? null : r.error; }}
          onPaste={async (text) => {
            const r = await saveTagPairs(text);
            if (!r.ok) { toast.error(r.error); return false; }
            toast.success(`Saved ${plural(r.data.saved, "tag")}${r.data.newClients ? `, ${plural(r.data.newClients, "new client")}` : ""}`,
              r.data.bad.length ? { description: `Skipped ${plural(r.data.bad.length, "line")} that weren't a pair: ${r.data.bad.slice(0, 3).join(" | ")}` } : undefined);
            return true;
          }}
        />
      ) : (
        <p className="st-note">Each Smartlead tag is a client of the same name. Switch to <b>Map tags to clients</b> above to choose the client of each tag.</p>
      )}
      <div className="st-actions">
        {savedList.length ? (
          <button type="button" className="btn btn-sm" disabled={pending} title={`${savedList.length} tags to ${new Set(savedList.map((p) => p.client.toLowerCase())).size} clients. Switches to mapped tags and applies it.`}
            onClick={() => run(async () => {
              const r = await applyBuiltInTagMap();
              if (!r.ok) return void toast.error(r.error);
              toast.success(`Saved list applied: ${r.data.saved} tags${r.data.newClients ? `, ${plural(r.data.newClients, "new client")}` : ""}, ${plural(r.data.moved, "domain")} moved`);
            })}>Use the saved list</button>
        ) : null}
        {source === "mapped" ? (
          <button type="button" className="btn btn-sm" disabled={pending}
            onClick={() => run(async () => { const r = await applyTagClients(); if (!r.ok) toast.error(r.error); else toast.success(`${plural(r.data.moved, "domain")} moved to their client`); })}>
            Apply to all domains
          </button>
        ) : null}
        <button type="button" className="btn btn-sm" disabled={pending} title="One tag per client, named after the client. Tags that already exist are skipped."
          onClick={() => run(async () => { const r = await createClientTags(); if (!r.ok) toast.error(r.error); else toast.success(r.data.message); })}>
          Create client tags in Smartlead
        </button>
        <button type="button" className="btn btn-sm btn-ghost" disabled={pending} title="Hide clients with no domains, no tag and no sender name"
          onClick={() => run(async () => { const r = await archiveEmptyClients(); if (!r.ok) toast.error(r.error); else toast.success(`${plural(r.data.archived, "empty client")} hidden`); })}>
          Hide clients with no domains
        </button>
        <span className="field-hint ml-auto">Every Smartlead sync applies the map by itself.</span>
      </div>
    </>
  );
}
