"use client";

import { Check, CircleDashed, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { SortTh, type SortState } from "@/components/SortTh";
import { ClientCell, Empty, Spark } from "@/components/ui";
import { change, fillDays, promiseReport, promiseVerdict } from "@/lib/client-sending";
import { int } from "@/lib/format";
import type { ClientSendingRow as ClientRow } from "@/lib/queries";
import { addDays } from "@/lib/range";

type Key = "name" | "promised" | "last" | "avg" | "delivered" | "change" | "capacity";
type Row = ClientRow & {
  last: number | null; lastDay: string | null; avg: number | null; prevAvg: number | null; delta: number | null; delivered: number | null;
  met: number; days: number; shortfall: number; spark: number[]; state: "met" | "short" | "unset";
  verdict: string;
};

/** Every client: promised, what went out, and whether the inboxes could even do it. */
export function ClientsList({ today, clients, days }: { today: string; from: string; clients: ClientRow[]; days: { clientId: string; day: string; sent: number }[] }) {
  const [sort, setSort] = useState<SortState<Key>>({ key: "delivered", dir: 1 });
  const rows = useMemo<Row[]>(() => {
    const byClient = new Map<string, { day: string; sent: number }[]>();
    for (const d of days) byClient.set(d.clientId, [...(byClient.get(d.clientId) ?? []), d]);
    // The last 7 finished days against the 7 before.
    const w1 = addDays(today, -7), w2 = addDays(today, -14);
    return clients.map((c) => {
      const own = byClient.get(c.id) ?? [];
      const now = fillDays(own, w1, addDays(today, -1));
      const before = fillDays(own, w2, addDays(w1, -1));
      const r = promiseReport(now, c.promisedDaily, c.sendWeekends, today);
      const p = promiseReport(before, null, c.sendWeekends, today);
      return {
        ...c, last: r.last?.sent ?? null, lastDay: r.last?.day ?? null, avg: r.avg, prevAvg: p.avg, delta: change(r.avg, p.avg),
        delivered: r.delivered, met: r.met, days: r.days, shortfall: r.shortfall,
        spark: fillDays(own, addDays(today, -14), addDays(today, -1)).map((d) => d.sent),
        state: !c.promisedDaily ? "unset" as const : r.short ? "short" as const : "met" as const,
        verdict: promiseVerdict(r, c.promisedDaily, c.capacity).text,
      };
    });
  }, [clients, days, today]);

  const sorted = useMemo(() => {
    const val = (r: Row): number | string | null => sort.key === "name" ? r.name.toLowerCase() : sort.key === "promised" ? r.promisedDaily : sort.key === "change" ? r.delta : r[sort.key];
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x === y) return a.name.localeCompare(b.name);
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * sort.dir;
    });
  }, [rows, sort]);
  const onSort = (key: Key) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "name" || key === "delivered" ? 1 : -1 }));

  const short = rows.filter((r) => r.state === "short");
  const owed = short.reduce((a, r) => a + r.shortfall, 0);
  const unset = rows.filter((r) => r.state === "unset").length;
  const sentYest = rows.reduce((a, r) => a + (r.last ?? 0), 0);

  if (!clients.length) return <Empty icon={CircleDashed} title="No clients yet">Add clients in Settings, and they&apos;ll appear here with their sending.</Empty>;

  return (
    <>
      <div className="stats">
        <div className="stat">
          <span className="stat-label">On promise</span>
          <span className="stat-value">{rows.length - short.length - unset}</span>
          <span className="stat-foot">Met every sending day, last 7 days</span>
        </div>
        <div className="stat">
          <span className="stat-label">Under promise</span>
          <span className={`stat-value${short.length ? " text-warning-ink" : ""}`}>{short.length}</span>
          <span className="stat-foot">{short.length ? `${int(owed)} emails short, last 7 days` : "Nothing owed"}</span>
        </div>
        <div className="stat">
          <span className="stat-label">No promise set</span>
          <span className="stat-value">{unset}</span>
          <span className="stat-foot">{unset ? "Open a client to set it" : "Every client has one"}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Sent, last finished day</span>
          <span className="stat-value">{int(sentYest)}</span>
          <span className="stat-foot">Every client, all domains</span>
        </div>
      </div>
      <section className="card" aria-label="Client sending">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <SortTh k="name" sort={sort} onSort={onSort}>Client</SortTh>
                <SortTh k="promised" sort={sort} onSort={onSort} num title="Emails promised per sending day">Promised</SortTh>
                <SortTh k="last" sort={sort} onSort={onSort} num title="The last finished sending day">Last day</SortTh>
                <SortTh k="avg" sort={sort} onSort={onSort} num title="Average per sending day, last 7 days">Average</SortTh>
                <SortTh k="delivered" sort={sort} onSort={onSort} title="How much of the promised volume went out, last 7 days">Of promise</SortTh>
                <SortTh k="change" sort={sort} onSort={onSort} num title="Average per sending day against the 7 days before">Trend</SortTh>
                <th title="Last 14 days">14 days</th>
                <SortTh k="capacity" sort={sort} onSort={onSort} num title="Daily limit of every connected inbox on live domains">Capacity</SortTh>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/clients/${r.id}`} className="hover:underline" title={r.verdict}><ClientCell name={r.name} hue={r.hue} /></Link></td>
                  <td className="is-num">{r.promisedDaily ? int(r.promisedDaily) : <Link href={`/clients/${r.id}`} className="cl-set">Set</Link>}</td>
                  <td className="is-num">{r.last ? int(r.last) : <span className="zero">0</span>}</td>
                  <td className="is-num">{r.avg ? int(Math.round(r.avg)) : <span className="zero">0</span>}</td>
                  <td>
                    {r.delivered != null ? (
                      <span className="cl-meter">
                        {r.state === "met" ? <Check size={13} strokeWidth={2} className="text-success-ink" aria-hidden="true" /> : <TriangleAlert size={13} strokeWidth={1.75} className="text-warning-ink" aria-hidden="true" />}
                        <span className="cl-meter-track"><span className={r.state === "met" ? "is-met" : "is-short"} style={{ width: `${Math.min(100, r.delivered)}%` }} /></span>
                        <span className="num">{Math.round(r.delivered)}%</span>
                        <span className="cl-meter-days num">{r.met}/{r.days} days</span>
                      </span>
                    ) : <span className="zero">Not set</span>}
                  </td>
                  <td className="is-num">{r.delta != null && Math.abs(r.delta) >= 1 ? <span className={r.delta > 0 ? "delta-up" : "delta-down"}>{r.delta > 0 ? "+" : "−"}{Math.abs(r.delta).toFixed(0)}%</span> : <span className="zero">{r.delta == null ? "—" : "Flat"}</span>}</td>
                  <td><Spark values={r.spark} width={80} /></td>
                  <td className="is-num">
                    <span className={r.promisedDaily && r.capacity < r.promisedDaily ? "text-danger-ink" : undefined} title={`${int(r.inboxes)} connected inboxes on ${int(r.domains)} live domains${r.disconnected ? `; ${int(r.disconnected)} more disconnected, worth ${int(r.lostCapacity)} a day` : ""}`}>{int(r.capacity)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
