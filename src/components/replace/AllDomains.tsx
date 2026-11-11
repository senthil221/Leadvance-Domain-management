"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { DomainLink } from "@/components/domains/DomainLink";
import { Badge, ClientCell } from "@/components/ui";
import { int } from "@/lib/format";
import { SEVERITY_META, SEVERITY_ORDER, severityOf, type DomainRow, type Severity } from "@/lib/replace-list";

const pct = (k: number, of: number) => { if (!of) return "–"; const v = (100 * k) / of; return `${v < 1 ? v.toFixed(2) : v.toFixed(1)}%`; };

type SortKey = "severity" | "sentY" | "repliesY" | "senderY" | "bouncesY" | "sent7" | "reply7" | "sender7" | "bounce7";
const value = (d: DomainRow, k: SortKey): number => {
  switch (k) {
    case "severity": return SEVERITY_ORDER.indexOf(severityOf(d));
    case "reply7": return d.sent7 ? d.replies7 / d.sent7 : -1;
    case "sender7": return d.sent7 ? d.sender7 / d.sent7 : -1;
    case "bounce7": return d.sent7 ? d.bounces7 / d.sent7 : -1;
    default: return d[k];
  }
};

/** Every live sending domain on one screen: its standing, yesterday, and the last 7 days. */
export function AllDomains({ domains }: { domains: DomainRow[] }) {
  const [only, setOnly] = useState<Severity | "">("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "severity", dir: 1 });

  const counts = useMemo(() => {
    const m = new Map<Severity, number>();
    for (const d of domains) m.set(severityOf(d), (m.get(severityOf(d)) ?? 0) + 1);
    return m;
  }, [domains]);
  const rows = useMemo(() => {
    const list = domains.filter((d) => !only || severityOf(d) === only);
    // Worst first by default; numbers sort high first, and the severity order breaks ties.
    return [...list].sort((a, b) => (value(a, sort.key) - value(b, sort.key)) * sort.dir || value(a, "severity") - value(b, "severity") || b.sent7 - a.sent7);
  }, [domains, only, sort]);
  const yesterday = useMemo(() => domains.reduce((t, d) => ({ sent: t.sent + d.sentY, replies: t.replies + d.repliesY, sender: t.sender + d.senderY, bounces: t.bounces + d.bouncesY }), { sent: 0, replies: 0, sender: 0, bounces: 0 }), [domains]);

  const head = (key: SortKey, label: string, title?: string) => (
    <th className={key === "severity" ? undefined : "is-num"} title={title} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
      <button type="button" className="rs-sort" onClick={() => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "severity" ? 1 : -1 }))}>
        {label}{sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );

  return (
    <>
      <div className="rs-chips" role="group" aria-label="Show only">
        {SEVERITY_ORDER.filter((s) => counts.get(s)).map((s) => (
          <button key={s} type="button" className="fx-kind" aria-pressed={only === s} data-on={only === s || undefined} title={SEVERITY_META[s].hint}
            onClick={() => setOnly(only === s ? "" : s)}>
            {SEVERITY_META[s].label} <span className="num">{int(counts.get(s) ?? 0)}</span>
          </button>
        ))}
        <span className="rs-sync">
          Yesterday: {int(yesterday.sent)} sent · {pct(yesterday.replies, yesterday.sent)} replies · {pct(yesterday.sender, yesterday.sent)} spam/block bounces
        </span>
      </div>
      <div className="table-scroll">
        <table className="data-table rs-table rs-all">
          <thead>
            <tr className="rs-span">
              <th colSpan={4} />
              <th colSpan={4} className="rs-span-h">Yesterday</th>
              <th colSpan={4} className="rs-span-h">Last 7 days</th>
            </tr>
            <tr>
              {head("severity", "Standing", "Worst first: Replace now, Replace, Fix first, Watch, Weak tag, List problem, OK, Too little")}
              <th>Domain</th><th title="Hover a client for its Smartlead tag">Client</th><th>Why</th>
              {head("sentY", "Sent")}
              {head("repliesY", "Replies", "Replies of any kind yesterday")}
              {head("senderY", "Spam/block", "Spam, policy and block list bounces yesterday")}
              {head("bouncesY", "Bounces", "Every bounce yesterday")}
              {head("sent7", "Sent")}
              {head("reply7", "Replies", "Replies of any kind, share of sent")}
              {head("sender7", "Spam/block", "Spam, policy and block list bounces, share of sent")}
              {head("bounce7", "Bounces", "Every bounce, share of sent")}
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const s = severityOf(d);
              return (
                <tr key={d.domainId}>
                  <td><Badge tone={SEVERITY_META[s].tone}>{SEVERITY_META[s].label}</Badge></td>
                  <td className="rs-name"><DomainLink id={d.domainId} className="fx-name">{d.name}</DomainLink></td>
                  <td className="rs-client" title={d.tags ? `Tag: ${d.tags}` : undefined}>
                    {d.clientId ? <Link href={`/clients/${d.clientId}`} className="hover:underline"><ClientCell name={d.clientName} hue={d.clientHue} /></Link> : <span className="zero">No client</span>}
                    {d.tags ? <span className="fx-provider">{d.tags}</span> : null}
                  </td>
                  <td className="rs-why" title={d.short || d.weakTag || undefined}>{d.short || d.weakTag || <span className="zero">–</span>}</td>
                  <td className="is-num num">{int(d.sentY)}</td>
                  <td className="is-num num">{d.sentY ? int(d.repliesY) : <span className="zero">–</span>}</td>
                  <td className={`is-num num${d.senderY >= 3 ? " rs-hot" : ""}`}>{d.sentY || d.senderY ? int(d.senderY) : <span className="zero">–</span>}</td>
                  <td className="is-num num">{d.sentY || d.bouncesY ? int(d.bouncesY) : <span className="zero">–</span>}</td>
                  <td className="is-num num">{int(d.sent7)}</td>
                  <td className="is-num num" title={d.sent7 ? `${int(d.human7)} human (${pct(d.human7, d.sent7)}) and ${int(d.ooo7)} out-of-office (${pct(d.ooo7, d.sent7)}) of ${int(d.replies7)} replies` : undefined}>{pct(d.replies7, d.sent7)}</td>
                  <td className="is-num num">{pct(d.sender7, d.sent7)}</td>
                  <td className="is-num num">{pct(d.bounces7, d.sent7)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
