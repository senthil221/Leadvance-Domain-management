"use client";

import { Check, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { SortTh, type SortState } from "@/components/SortTh";
import { ClientCell, Metric } from "@/components/ui";
import { isSendingDay } from "@/lib/client-sending";
import { int } from "@/lib/format";
import type { ClientFleetRow, ClientInsight } from "@/lib/queries";
import { STATUS_META, type DomainStatus } from "@/lib/status";

type Key = "name" | "active" | "sent" | "replyRate" | "humanRate" | "bounceRate";
const FLEET: DomainStatus[] = ["active", "warming", "provisioning", "draining"];
const rate = (n: number, d: number) => (d > 0 ? (100 * n) / d : null);
const value = (c: ClientInsight, k: Key): string | number | null =>
  k === "name" ? c.name.toLowerCase() : k === "replyRate" ? rate(c.replies, c.sent) : k === "humanRate" ? rate(c.human, c.sent) : k === "bounceRate" ? rate(c.bounces, c.sent) : c[k];

/** Yesterday against the promise. Weekends don't count unless the client sends on them. */
function Promised({ c }: { c: ClientInsight }) {
  const judged = c.promisedDaily && isSendingDay(c.yesterday, c.sendWeekends);
  const short = judged && c.sentYesterday < c.promisedDaily!;
  return (
    <span className="ov-promise" title={c.promisedDaily ? `Promised ${int(c.promisedDaily)} a day` : "No promised volume set: open the client to set it"}>
      {judged ? (short ? <TriangleAlert size={12} strokeWidth={1.75} className="text-warning-ink" aria-label="Under the promise" /> : <Check size={12} strokeWidth={2} className="text-success-ink" aria-label="Met the promise" />) : null}
      <span className="num">{c.sentYesterday ? int(c.sentYesterday) : <span className="zero">0</span>}</span>
      {c.promisedDaily ? <span className="ov-promise-of num">/ {int(c.promisedDaily)}</span> : null}
    </span>
  );
}

/** Per client: its domains by state, what it sent against the others, and how that landed. Sortable. */
export function ClientsTable({ clients, fleet }: { clients: ClientInsight[]; fleet: ClientFleetRow[] }) {
  const [sort, setSort] = useState<SortState<Key>>({ key: "sent", dir: -1 });
  const rows = useMemo(() => [...clients].sort((a, b) => {
    const x = value(a, sort.key), y = value(b, sort.key);
    if (x === y) return a.name.localeCompare(b.name);
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : 1) * sort.dir;
  }), [clients, sort]);
  const onSort = (key: Key) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "name" ? 1 : -1 }));
  const maxSent = Math.max(1, ...clients.map((c) => c.sent));
  const fleetOf = useMemo(() => new Map(fleet.map((f) => [f.clientId, f])), [fleet]);

  return (
    <div className="table-scroll ov-clients">
      <table className="data-table">
        <thead>
          <tr>
            <SortTh k="name" sort={sort} onSort={onSort}>Client</SortTh>
            <SortTh k="active" sort={sort} onSort={onSort} title="Domains by state">Domains</SortTh>
            <SortTh k="sent" sort={sort} onSort={onSort}>Sent 7d</SortTh>
            <th className="is-num" title="What went out yesterday against the promised daily volume">Yesterday</th>
            <SortTh k="replyRate" sort={sort} onSort={onSort} num>Reply</SortTh>
            <SortTh k="humanRate" sort={sort} onSort={onSort} num>Human</SortTh>
            <SortTh k="bounceRate" sort={sort} onSort={onSort} num>Bounce</SortTh>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const change = c.sentPrev > 0 ? (100 * (c.sent - c.sentPrev)) / c.sentPrev : null;
            const f = fleetOf.get(c.id);
            return (
              <tr key={c.id}>
                <td><Link href={`/clients/${c.id}`} className="hover:underline" title={`Open ${c.name}'s daily sending: ${int(c.inboxes)} inboxes, ${int(c.capacity)} a day`}><ClientCell name={c.name} hue={c.hue} /></Link></td>
                <td>
                  {f ? (
                    <Link href={`/inventory?client=${c.id}&view=all`} className="ov-fleet">
                      <span className="fleet-bar">
                        {FLEET.filter((s) => f.counts[s]).map((s) => (
                          <span key={s} className={`tone-${STATUS_META[s].tone}`} style={{ flex: f.counts[s] }} title={`${STATUS_META[s].label}: ${f.counts[s]}`} />
                        ))}
                      </span>
                      <span className="num">{int(f.total)}</span>
                    </Link>
                  ) : <span className="zero">0</span>}
                </td>
                <td>
                  <span className="ov-sent">
                    <span className="ov-sent-track"><span style={{ width: `${(100 * c.sent) / maxSent}%` }} /></span>
                    <span className="num">{c.sent ? int(c.sent) : <span className="zero">0</span>}</span>
                    {change != null && Math.abs(change) >= 1 ? <span className={`ov-sent-delta ${change > 0 ? "delta-up" : "delta-down"}`}>{change > 0 ? "+" : "−"}{Math.abs(change).toFixed(0)}%</span> : null}
                  </span>
                </td>
                <td className="is-num"><Promised c={c} /></td>
                <td className="is-num"><Metric value={rate(c.replies, c.sent)} digits={2} /></td>
                <td className="is-num"><Metric value={rate(c.human, c.sent)} digits={2} /></td>
                <td className="is-num"><Metric value={rate(c.bounces, c.sent)} warn={2} bad={3} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
