"use client";

import { Inbox, Info, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ClientCell, Empty, Metric } from "@/components/ui";
import { ago, int } from "@/lib/format";
import type { ClientRow, InboxListRow } from "@/lib/queries";

const TABS = [
  { key: "connected", label: "Connected" },
  { key: "pending", label: "Pending" },
  { key: "disconnected", label: "Disconnected" },
  { key: "all", label: "All" },
] as const;

export function InboxesView({ inboxes, clients, smartleadConnected }: { inboxes: InboxListRow[]; clients: ClientRow[]; smartleadConnected: boolean }) {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("connected");
  const [q, setQ] = useState("");
  const [clientId, setClientId] = useState("");

  const base = useMemo(() => {
    const client = clients.find((c) => c.id === clientId)?.name;
    return inboxes.filter((i) => !client || i.clientName === client);
  }, [inboxes, clients, clientId]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: base.length };
    for (const i of base) c[i.status] = (c[i.status] ?? 0) + 1;
    return c;
  }, [base]);
  const needle = q.trim().toLowerCase();
  const rows = base.filter((i) => (tab === "all" || i.status === tab) && (!needle || i.email.includes(needle) || i.senderName?.toLowerCase().includes(needle)));
  const capacity = rows.reduce((a, i) => a + (i.dailyLimit ?? 0), 0);
  const warmup = rows.reduce((a, i) => a + (i.warmupEnabled ? i.warmupPerDay ?? 0 : 0), 0);

  return (
    <div className="flex flex-col gap-3">
      {!smartleadConnected ? (
        <div className="callout tone-info">
          <Info size={15} strokeWidth={1.75} />
          <span>
            Showing the last synced settings. Add your Smartlead API key in <Link href="/settings" className="underline">Settings</Link> to
            change warmup and daily limits from here.
          </span>
        </div>
      ) : null}
      <div className="view-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? "is-on" : undefined} onClick={() => setTab(t.key)}>
            {t.label} <span>{int(counts[t.key] ?? 0)}</span>
          </button>
        ))}
      </div>
      <div className="toolbar">
        <label className="search-input">
          <Search size={14} strokeWidth={1.5} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search inboxes or senders" aria-label="Search inboxes" />
        </label>
        <select className="select" style={{ width: 180 }} value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Filter by client">
          <option value="">All clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <div className="view-tabs-summary"><b>{int(capacity)}</b> campaign emails / day · <b>{int(warmup)}</b> warmup</div>
      </div>
      <div className="table-wrap">
        <div className="table-scroll" style={{ maxHeight: "calc(100dvh - 290px)", minHeight: 240 }}>
          <table className="data-table is-main">
            <thead>
              <tr>
                <th>Inbox</th><th>Sender</th><th>Domain</th><th>Client</th>
                <th className="is-num">Warmup / day</th><th className="is-num">Ramp-up</th><th className="is-num">Campaign limit</th><th className="is-num">Reputation</th><th className="is-num">Synced</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id}>
                  <td className="col-first strong">{i.email}</td>
                  <td>{i.senderName ?? <span className="zero">—</span>}</td>
                  <td><Link href={`/domains?d=${i.domainId}&view=all`} className="hover:underline">{i.domain}</Link></td>
                  <td><ClientCell name={i.clientName} hue={i.clientHue} /></td>
                  <td className="is-num">{i.warmupEnabled ? int(i.warmupPerDay) : <span className="zero">off</span>}</td>
                  <td className="is-num">{i.warmupRampup ? int(i.warmupRampup) : <span className="zero">—</span>}</td>
                  <td className="is-num">{i.dailyLimit ? int(i.dailyLimit) : <span className="zero">0</span>}</td>
                  <td className="is-num"><Metric value={i.warmupReputation} warn={95} bad={90} invert digits={0} suffix="" /></td>
                  <td className="is-num text-muted">{i.lastSyncedAt ? ago(i.lastSyncedAt) : <span className="zero">never</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 ? <Empty icon={Inbox} title="No inboxes here">Inboxes appear once a domain is set up on Hypertide and connected to Smartlead.</Empty> : null}
        </div>
        <div className="table-footer">
          <span><b>{int(rows.length)}</b> inboxes</span>
          <span><b>{int(capacity)}</b> campaign emails a day</span>
        </div>
      </div>
    </div>
  );
}
