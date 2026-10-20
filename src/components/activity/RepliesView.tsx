"use client";

import { DropdownMenu } from "radix-ui";
import { Check, ChevronDown, MessageSquareText, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useOptimistic, useState, useTransition } from "react";
import { toast } from "sonner";
import { reclassifyReply } from "@/app/actions";
import { ClientCell, Empty } from "@/components/ui";
import { ago, int } from "@/lib/format";
import type { ReplyRow } from "@/lib/queries";
import { REPLY_CLASS_META } from "@/lib/status";

type Cls = keyof typeof REPLY_CLASS_META;
const TABS: { key: Cls | "all"; label: string }[] = [
  { key: "human", label: "Human" },
  { key: "negative", label: "Not interested" },
  { key: "ooo", label: "Out of office" },
  { key: "auto", label: "Auto-reply" },
  { key: "all", label: "All" },
];

const SORTS = {
  newest: { label: "Newest first", fn: (a: ReplyRow, b: ReplyRow) => +new Date(b.occurredAt) - +new Date(a.occurredAt) },
  oldest: { label: "Oldest first", fn: (a: ReplyRow, b: ReplyRow) => +new Date(a.occurredAt) - +new Date(b.occurredAt) },
  client: { label: "Client", fn: (a: ReplyRow, b: ReplyRow) => (a.clientName ?? "~").localeCompare(b.clientName ?? "~") },
  domain: { label: "Domain", fn: (a: ReplyRow, b: ReplyRow) => (a.domain ?? "~").localeCompare(b.domain ?? "~") },
  campaign: { label: "Campaign", fn: (a: ReplyRow, b: ReplyRow) => (a.campaignName ?? "~").localeCompare(b.campaignName ?? "~") },
} as const;

export function RepliesView({ replies }: { replies: ReplyRow[] }) {
  const [tab, setTab] = useState<Cls | "all">("human");
  const [q, setQ] = useState("");
  const [client, setClient] = useState("");
  const [sort, setSort] = useState<keyof typeof SORTS>("newest");
  const clients = useMemo(() => [...new Set(replies.map((r) => r.clientName).filter((x): x is string => Boolean(x)))].sort(), [replies]);
  const [overrides, setOverride] = useOptimistic(new Map<number, Cls>(), (m, [id, c]: [number, Cls]) => new Map(m).set(id, c));
  const [, startTransition] = useTransition();

  const rows = useMemo(() => replies.map((r) => ({ ...r, replyClass: overrides.get(r.id) ?? r.replyClass })), [replies, overrides]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length };
    for (const r of rows) if (r.replyClass) c[r.replyClass] = (c[r.replyClass] ?? 0) + 1;
    return c;
  }, [rows]);
  const needle = q.trim().toLowerCase();
  const shown = rows
    .filter((r) => (tab === "all" || r.replyClass === tab) && (!client || r.clientName === client) && (!needle || [r.preview, r.leadEmail, r.domain, r.campaignName].some((v) => v?.toLowerCase().includes(needle))))
    .sort(SORTS[sort].fn);

  const reclassify = (r: ReplyRow, c: Cls) =>
    startTransition(async () => {
      setOverride([r.id, c]);
      const res = await reclassifyReply(r.id, c);
      if (!res.ok) toast.error(res.error);
      else toast(`Marked as ${REPLY_CLASS_META[c].label.toLowerCase()}`);
    });

  return (
    <div className="flex flex-col gap-3">
      <div className="table-bar">
        <div className="view-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? "is-on" : undefined} onClick={() => setTab(t.key)}>
              {t.label} <span>{int(counts[t.key] ?? 0)}</span>
            </button>
          ))}
        </div>
        {clients.length ? (
          <select className="select" style={{ width: 150 }} value={client} onChange={(e) => setClient(e.target.value)} aria-label="Filter by client">
            <option value="">All clients</option>
            {clients.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        ) : null}
        <select className="select" style={{ width: 140 }} value={sort} onChange={(e) => setSort(e.target.value as keyof typeof SORTS)} aria-label="Sort replies">
          {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <span className="text-[12.5px] text-muted"><b className="num text-ink">{int(shown.length)}</b> replies</span>
        <span className="spacer-auto" />
        <label className="search-input">
          <Search size={14} strokeWidth={1.5} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search replies" />
        </label>
      </div>
      <div className="card">
        {shown.length === 0 ? (
          <Empty icon={MessageSquareText} title="No replies here">Replies arrive from the Smartlead webhook as they happen.</Empty>
        ) : (
          <div className="list">
            {shown.map((r) => {
              const meta = r.replyClass ? REPLY_CLASS_META[r.replyClass] : null;
              return (
                <div key={r.id} className="list-row" style={{ alignItems: "flex-start", paddingTop: 10, paddingBottom: 10 }}>
                  <div className="list-main gap-0.5">
                    <p className="line-clamp-2 text-ink" style={{ whiteSpace: "normal" }}>{r.preview ?? <span className="zero">No preview</span>}</p>
                    <p className="list-meta">
                      {r.leadEmail}
                      {r.domain ? <> · to <Link className="hover:underline" href={r.domainId ? `/domains?d=${r.domainId}` : "/domains"}>{r.domain}</Link></> : null}
                      {r.campaignName ? ` · ${r.campaignName}` : ""}
                      {r.recipientEsp ? ` · ${r.recipientEsp}` : ""}
                    </p>
                  </div>
                  <span className="hidden w-28 pt-0.5 lg:block"><ClientCell name={r.clientName} hue={r.clientHue} /></span>
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button type="button" className={`badge${meta ? ` tone-${meta.tone}` : ""} cursor-pointer`} aria-label="Change classification">
                        {meta?.label ?? "Unclassified"} <ChevronDown size={11} />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content className="menu" align="end" sideOffset={6}>
                        <DropdownMenu.Label className="menu-label">Classify as</DropdownMenu.Label>
                        {(Object.keys(REPLY_CLASS_META) as Cls[]).map((c) => (
                          <DropdownMenu.Item key={c} className="menu-item" onSelect={() => reclassify(r, c)}>
                            <span className={`dot tone-${REPLY_CLASS_META[c].tone}`} />
                            {REPLY_CLASS_META[c].label}
                            {r.replyClass === c ? <Check size={13} className="menu-hint" /> : null}
                          </DropdownMenu.Item>
                        ))}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                  <span className="list-meta w-16 pt-0.5 text-right">{ago(r.occurredAt)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
