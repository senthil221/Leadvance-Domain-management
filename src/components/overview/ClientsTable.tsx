"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { SortTh, type SortState } from "@/components/SortTh";
import { ClientCell, Metric } from "@/components/ui";
import { int } from "@/lib/format";
import type { ClientInsight } from "@/lib/queries";

type Key = "name" | "active" | "inboxes" | "capacity" | "sent" | "replyRate" | "humanRate" | "bounceRate";
const rate = (n: number, d: number) => (d > 0 ? (100 * n) / d : null);
const value = (c: ClientInsight, k: Key): string | number | null =>
  k === "name" ? c.name.toLowerCase() : k === "replyRate" ? rate(c.replies, c.sent) : k === "humanRate" ? rate(c.human, c.sent) : k === "bounceRate" ? rate(c.bounces, c.sent) : c[k];

/** Per-client sending for the last 7 days, sortable. */
export function ClientsTable({ clients }: { clients: ClientInsight[] }) {
  const [sort, setSort] = useState<SortState<Key>>({ key: "sent", dir: -1 });
  const rows = useMemo(() => [...clients].sort((a, b) => {
    const x = value(a, sort.key), y = value(b, sort.key);
    if (x === y) return a.name.localeCompare(b.name);
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : 1) * sort.dir;
  }), [clients, sort]);
  const onSort = (key: Key) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "name" ? 1 : -1 }));

  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <SortTh k="name" sort={sort} onSort={onSort}>Client</SortTh>
            <SortTh k="active" sort={sort} onSort={onSort} num>Domains</SortTh>
            <SortTh k="inboxes" sort={sort} onSort={onSort} num>Inboxes</SortTh>
            <SortTh k="capacity" sort={sort} onSort={onSort} num>Per day</SortTh>
            <SortTh k="sent" sort={sort} onSort={onSort} num>Sent 7d</SortTh>
            <SortTh k="replyRate" sort={sort} onSort={onSort} num>Reply</SortTh>
            <SortTh k="humanRate" sort={sort} onSort={onSort} num>Human</SortTh>
            <SortTh k="bounceRate" sort={sort} onSort={onSort} num>Bounce</SortTh>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const change = c.sentPrev > 0 ? (100 * (c.sent - c.sentPrev)) / c.sentPrev : null;
            return (
              <tr key={c.id}>
                <td><Link href={`/stats?client=${c.id}`} className="hover:underline"><ClientCell name={c.name} hue={c.hue} /></Link></td>
                <td className="is-num">{c.active ? int(c.active) : <span className="zero">0</span>}{c.warming ? <span className="text-faint"> +{c.warming}</span> : null}</td>
                <td className="is-num">{c.inboxes ? int(c.inboxes) : <span className="zero">0</span>}</td>
                <td className="is-num">{c.capacity ? int(c.capacity) : <span className="zero">0</span>}</td>
                <td className="is-num">
                  {c.sent ? int(c.sent) : <span className="zero">0</span>}
                  {change != null && Math.abs(change) >= 1 ? <span className={`text-[11.5px] ${change > 0 ? "delta-up" : "delta-down"}`}> {change > 0 ? "+" : ""}{change.toFixed(0)}%</span> : null}
                </td>
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
