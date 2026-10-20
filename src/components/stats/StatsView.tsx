"use client";

import { BarChart3, Download, Search } from "lucide-react";
import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import { SortTh } from "@/components/SortTh";
import { ClientCell, Empty, Metric, StatusDot } from "@/components/ui";
import { int } from "@/lib/format";
import type { ClientRow, DomainStatRow, StatPeriod } from "@/lib/queries";
import { DOMAIN_STATUSES } from "@/lib/status";

const PERIODS: { days: StatPeriod; label: string }[] = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 14, label: "14 days" },
  { days: 30, label: "30 days" },
];

type Totals = Pick<DomainStatRow, "inboxes" | "capacity" | "sent" | "replies" | "human" | "ooo" | "negative" | "bounces" | "prevSent" | "prevReplies" | "prevBounces">;
const rate = (n: number, d: number) => (d > 0 ? (100 * n) / d : null);
const sum = (rows: DomainStatRow[]): Totals => rows.reduce<Totals>((a, r) => ({
  inboxes: a.inboxes + r.inboxes, capacity: a.capacity + r.capacity, sent: a.sent + r.sent, replies: a.replies + r.replies,
  human: a.human + r.human, ooo: a.ooo + r.ooo, negative: a.negative + r.negative, bounces: a.bounces + r.bounces,
  prevSent: a.prevSent + r.prevSent, prevReplies: a.prevReplies + r.prevReplies, prevBounces: a.prevBounces + r.prevBounces,
}), { inboxes: 0, capacity: 0, sent: 0, replies: 0, human: 0, ooo: 0, negative: 0, bounces: 0, prevSent: 0, prevReplies: 0, prevBounces: 0 });

type SortKey = "name" | "status" | "client" | "inboxes" | "capacity" | "sent" | "replies" | "human" | "ooo" | "negative" | "bounces" | "replyRate" | "humanRate" | "bounceRate" | "reputation" | "usage";
const sortValue = (r: DomainStatRow, k: SortKey, days: number): string | number | null => {
  switch (k) {
    case "status": return DOMAIN_STATUSES.indexOf(r.status);
    case "client": return r.clientName?.toLowerCase() ?? null;
    case "replyRate": return rate(r.replies, r.sent);
    case "humanRate": return rate(r.human, r.sent);
    case "bounceRate": return rate(r.bounces, r.sent);
    case "usage": return r.capacity ? r.sent / (r.capacity * days) : null;
    default: return r[k];
  }
};

// Change against the period before, in percentage points for rates.
function Delta({ now, before, points = false, invert = false }: { now: number | null; before: number | null; points?: boolean; invert?: boolean }) {
  if (now == null || before == null || (!points && before === 0)) return null;
  const d = points ? now - before : (100 * (now - before)) / before;
  if (Math.abs(d) < (points ? 0.05 : 1)) return null;
  const good = invert ? d < 0 : d > 0;
  return <span className={`text-[11.5px] ${good ? "delta-up" : "delta-down"}`}> {d > 0 ? "+" : ""}{d.toFixed(points ? 1 : 0)}{points ? "pt" : "%"}</span>;
}

function Cells({ r, days }: { r: Totals & { reputation?: number | null }; days: number }) {
  return (
    <>
      <td className="is-num">{r.inboxes ? int(r.inboxes) : <span className="zero">0</span>}</td>
      <td className="is-num" title={r.capacity ? `${int(r.sent)} of ${int(r.capacity * days)} possible` : undefined}>
        {r.capacity ? <Metric value={(100 * r.sent) / (r.capacity * days)} digits={0} /> : <span className="zero">—</span>}
      </td>
      <td className="is-num">{r.sent ? int(r.sent) : <span className="zero">0</span>}<Delta now={r.sent} before={r.prevSent} /></td>
      <td className="is-num">{r.replies ? int(r.replies) : <span className="zero">0</span>}</td>
      <td className="is-num">{r.human ? int(r.human) : <span className="zero">0</span>}</td>
      <td className="is-num">{r.ooo ? int(r.ooo) : <span className="zero">0</span>}</td>
      <td className="is-num">{r.negative ? int(r.negative) : <span className="zero">0</span>}</td>
      <td className="is-num">{r.bounces ? int(r.bounces) : <span className="zero">0</span>}</td>
      <td className="is-num"><Metric value={rate(r.replies, r.sent)} digits={2} /><Delta now={rate(r.replies, r.sent)} before={rate(r.prevReplies, r.prevSent)} points /></td>
      <td className="is-num"><Metric value={rate(r.human, r.sent)} digits={2} /></td>
      <td className="is-num"><Metric value={rate(r.bounces, r.sent)} warn={2} bad={3} /><Delta now={rate(r.bounces, r.sent)} before={rate(r.prevBounces, r.prevSent)} points invert /></td>
      <td className="is-num">{r.reputation !== undefined ? <Metric value={r.reputation} warn={95} bad={90} invert digits={0} suffix="" /> : null}</td>
    </>
  );
}

export function StatsView({ rows, clients }: { rows: DomainStatRow[]; clients: ClientRow[] }) {
  const [days, setDays] = useState<StatPeriod>(7);
  const [q, setQ] = useState("");
  const [clientId, setClientId] = useState("");
  const [onlySending, setOnlySending] = useState(true);
  const [byClient, setByClient] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "sent", dir: -1 });

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows
      .filter((r) => r.days === days && (!clientId || r.clientId === clientId) && (!onlySending || r.sent > 0 || r.status === "active") &&
        (!needle || r.name.includes(needle) || r.clientName?.toLowerCase().includes(needle) || r.tags.some((t) => t.toLowerCase().includes(needle))))
      .sort((a, b) => {
        const x = sortValue(a, sort.key, days), y = sortValue(b, sort.key, days);
        if (x === y) return a.name.localeCompare(b.name);
        if (x === null) return 1;
        if (y === null) return -1;
        return (x < y ? -1 : 1) * sort.dir;
      });
  }, [rows, days, q, clientId, onlySending, sort]);

  const groups = useMemo(() => {
    if (!byClient) return [{ key: "all", name: null as string | null, hue: null as number | null, rows: shown }];
    const map = new Map<string, { key: string; name: string | null; hue: number | null; rows: DomainStatRow[] }>();
    for (const r of shown) {
      const k = r.clientId ?? "none";
      const g = map.get(k) ?? { key: k, name: r.clientName, hue: r.clientHue, rows: [] };
      g.rows.push(r);
      map.set(k, g);
    }
    return [...map.values()].sort((a, b) => sum(b.rows).sent - sum(a.rows).sent);
  }, [shown, byClient]);

  const t = sum(shown);
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "name" || key === "client" || key === "status" ? 1 : -1 }));


  const exportCsv = () => {
    const head = ["domain", "status", "client", "inboxes", "capacity_per_day", "sent", "replies", "human", "ooo", "negative", "bounces", "reply_rate", "human_rate", "bounce_rate", "reputation", "period_days"];
    const esc = (v: unknown) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const fx = (v: number | null) => (v == null ? "" : v.toFixed(2));
    const lines = shown.map((r) => [r.name, r.status, r.clientName, r.inboxes, r.capacity, r.sent, r.replies, r.human, r.ooo, r.negative, r.bounces, fx(rate(r.replies, r.sent)), fx(rate(r.human, r.sent)), fx(rate(r.bounces, r.sent)), fx(r.reputation), days].map(esc).join(","));
    const url = URL.createObjectURL(new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" }));
    Object.assign(document.createElement("a"), { href: url, download: `domain-stats-${days}d-${new Date().toISOString().slice(0, 10)}.csv` }).click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-3">
      <section className="stats" aria-label="Totals">
        <div className="stat"><span className="stat-label">Sent</span><span className="stat-value">{int(t.sent)}</span><span className="stat-foot">{t.prevSent ? <>vs {int(t.prevSent)} the period before<Delta now={t.sent} before={t.prevSent} /></> : `${int(t.capacity)} a day possible`}</span></div>
        <div className="stat"><span className="stat-label">Reply rate</span><span className="stat-value">{rate(t.replies, t.sent)?.toFixed(2) ?? "—"}%</span><span className="stat-foot">{int(t.replies)} replies · {int(t.ooo)} out of office<Delta now={rate(t.replies, t.sent)} before={rate(t.prevReplies, t.prevSent)} points /></span></div>
        <div className="stat"><span className="stat-label">Human replies</span><span className="stat-value">{int(t.human)}</span><span className="stat-foot">{rate(t.human, t.sent)?.toFixed(2) ?? "0.00"}% of sent · {int(t.negative)} not interested</span></div>
        <div className="stat"><span className="stat-label">Bounce rate</span><span className="stat-value">{rate(t.bounces, t.sent)?.toFixed(1) ?? "—"}%</span><span className="stat-foot">{int(t.bounces)} bounces<Delta now={rate(t.bounces, t.sent)} before={rate(t.prevBounces, t.prevSent)} points invert /></span></div>
      </section>

      <div className="toolbar">
        <div className="seg" role="group" aria-label="Period">
          {PERIODS.map((p) => <button key={p.days} type="button" aria-pressed={days === p.days} onClick={() => setDays(p.days)}>{p.label}</button>)}
        </div>
        <label className="search-input">
          <Search size={14} strokeWidth={1.5} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search domains, clients or tags" aria-label="Search stats" />
        </label>
        <select className="select" style={{ width: 170 }} value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Filter by client">
          <option value="">All clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-[12.5px] text-muted"><input type="checkbox" className="checkbox" checked={onlySending} onChange={(e) => setOnlySending(e.target.checked)} /> Sending only</label>
        <label className="flex items-center gap-1.5 text-[12.5px] text-muted"><input type="checkbox" className="checkbox" checked={byClient} onChange={(e) => setByClient(e.target.checked)} /> Group by client</label>
        <button type="button" className="btn btn-sm ml-auto" onClick={exportCsv}><Download size={14} /> Export</button>
      </div>

      <div className="table-wrap">
        <div className="table-scroll" style={{ maxHeight: "calc(100dvh - 330px)", minHeight: 280 }}>
          <table className="data-table is-main">
            <thead>
              <tr>
                <SortTh k="name" sort={sort} onSort={sortBy}>Domain</SortTh>
                <SortTh k="status" sort={sort} onSort={sortBy}>Status</SortTh>
                <SortTh k="client" sort={sort} onSort={sortBy}>Client</SortTh>
                <SortTh k="inboxes" sort={sort} onSort={sortBy} num>Inboxes</SortTh>
                <SortTh k="usage" sort={sort} onSort={sortBy} num title="Sent as a share of the inboxes' daily limits over the period">Used</SortTh>
                <SortTh k="sent" sort={sort} onSort={sortBy} num>Sent</SortTh>
                <SortTh k="replies" sort={sort} onSort={sortBy} num>Replies</SortTh>
                <SortTh k="human" sort={sort} onSort={sortBy} num>Human</SortTh>
                <SortTh k="ooo" sort={sort} onSort={sortBy} num>OOO</SortTh>
                <SortTh k="negative" sort={sort} onSort={sortBy} num>Negative</SortTh>
                <SortTh k="bounces" sort={sort} onSort={sortBy} num>Bounces</SortTh>
                <SortTh k="replyRate" sort={sort} onSort={sortBy} num>Reply %</SortTh>
                <SortTh k="humanRate" sort={sort} onSort={sortBy} num>Human %</SortTh>
                <SortTh k="bounceRate" sort={sort} onSort={sortBy} num>Bounce %</SortTh>
                <SortTh k="reputation" sort={sort} onSort={sortBy} num>Reputation</SortTh>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.key}>
                  {byClient ? (
                    <tr style={{ background: "var(--surface-2)" }}>
                      <td className="col-first" colSpan={3}><span className="flex items-center gap-2"><ClientCell name={g.name ?? "No client"} hue={g.hue} /><span className="text-faint">{g.rows.length} domains</span></span></td>
                      <Cells r={sum(g.rows)} days={days} />
                    </tr>
                  ) : null}
                  {g.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="col-first" style={byClient ? { paddingLeft: 28 } : undefined}><Link href={`/domains?d=${r.id}&view=all`} className="strong hover:underline">{r.name}</Link></td>
                      <td><StatusDot status={r.status} /></td>
                      <td><ClientCell name={r.clientName} hue={r.clientHue} /></td>
                      <Cells r={r} days={days} />
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
          {shown.length === 0 ? (
            <Empty icon={BarChart3} title="No numbers for this period">
              Stats come from the Smartlead webhooks (sent, replies, bounces) and are rolled up every 10 minutes.
            </Empty>
          ) : null}
        </div>
        <div className="table-footer">
          <span><b>{int(shown.length)}</b> domains</span>
          <span><b>{int(t.sent)}</b> sent</span>
          <span><b>{int(t.replies)}</b> replies</span>
          <span><b>{int(t.human)}</b> human</span>
          <span><b>{rate(t.bounces, t.sent)?.toFixed(1) ?? "0.0"}%</b> bounce</span>
        </div>
      </div>
    </div>
  );
}
