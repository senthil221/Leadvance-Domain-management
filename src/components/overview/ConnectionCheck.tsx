"use client";

import { DomainLink } from "@/components/domains/DomainLink";
import Link from "next/link";
import { useMemo, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Badge, ClientCell, Dot } from "@/components/ui";
import { CONNECTION_PROBLEMS, type ConnectionProblem } from "@/lib/connections";
import { ago, int } from "@/lib/format";
import type { ConnectionCheckData, ConnectionRow } from "@/lib/queries";

const ORDER = Object.keys(CONNECTION_PROBLEMS) as ConnectionProblem[];
const inboxes = (n: number) => `${int(n)} inbox${n === 1 ? "" : "es"}`;

function detail(r: ConnectionRow) {
  const all = r.connected + r.disconnected;
  switch (r.state) {
    case "disconnected": return `${int(r.disconnected)} of ${inboxes(all)} disconnected`;
    case "deleted": return `${inboxes(r.removed)} deleted in Smartlead`;
    case "missing": return "No inboxes in Smartlead";
    case "dns_gone": return `DNS not answering, ${inboxes(r.connected)} still connected`;
    case "warmup_off": return `Warm-up off on ${int(r.warmupOff)} of ${inboxes(r.connected)}`;
    case "warmup_blocked": return `Warm-up blocked on ${int(r.warmupBlocked)} of ${inboxes(r.connected)}`;
  }
}

/** Active orders against Smartlead: the counts should match, and anything that doesn't is listed by cause. */
export function ConnectionCheck({ data }: { data: ConnectionCheckData }) {
  const { providers, problems, withoutOrder, syncs } = data;
  const [show, setShow] = useState<ConnectionProblem | "all" | null>(null);
  const counts = useMemo(() => {
    const m = new Map<ConnectionProblem, number>();
    for (const r of problems) m.set(r.state, (m.get(r.state) ?? 0) + 1);
    return ORDER.filter((c) => m.has(c)).map((c) => ({ c, n: m.get(c)! }));
  }, [problems]);
  const shown = show === "all" ? problems : problems.filter((r) => r.state === show);
  const stale = syncs.filter((s) => s.stale);
  const settingUp = providers.reduce((a, p) => a + p.settingUp, 0);
  const retiring = providers.reduce((a, p) => a + p.retiring, 0);
  const notes = [
    settingUp ? `${int(settingUp)} still being set up` : null,
    retiring ? `${int(retiring)} retired but still billed` : null,
  ].filter(Boolean);

  return (
    <section className="card" id="connections" aria-labelledby="connections-title" style={{ scrollMarginTop: 72 }}>
      <div className="card-head">
        <h2 id="connections-title" className="card-title">Connections</h2>
        {providers.length === 0 ? null : problems.length ? <Badge tone="danger">{int(problems.length)} to check</Badge> : <Badge tone="success">All connected</Badge>}
        <span className="card-sub ml-auto" suppressHydrationWarning title="Hypertide orders sync every 5 minutes, Smartlead inboxes and Icemail every 30">
          {syncs.map((s) => `${s.label} ${s.at ? ago(s.at) : "never"}`).join(" · ")}
        </span>
      </div>
      {stale.length ? (
        <div className="card-body" style={{ borderBottom: "1px solid var(--line)" }}>
          <div className="callout tone-warning" role="alert">
            <TriangleAlert size={15} strokeWidth={1.75} />
            <span>{stale.map((s) => s.label).join(" and ")} {stale.length === 1 ? "isn't" : "aren't"} syncing, so these numbers may be out of date.</span>
          </div>
        </div>
      ) : null}
      {providers.length === 0 ? (
        <p className="card-body zero">No active orders synced yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th className="is-num" title="Done at Hypertide, active at Icemail. Cancelled orders aren't counted.">Active orders</th>
                <th className="is-num" title="Domains with every inbox connected in Smartlead">Smartlead active</th>
                <th className="is-num" title="Connected, DNS answering and warm-up running on every inbox">Warm-up on</th>
                <th className="is-num">To check</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.provider}>
                  <td><span className="inline-flex items-center gap-2"><Dot tone={p.problems ? "danger" : "success"} />{p.provider}</span></td>
                  <td className="is-num">{int(p.orders)}</td>
                  <td className="is-num">{int(p.connected)}</td>
                  <td className="is-num">{int(p.ok)}</td>
                  <td className={`is-num${p.problems ? " text-danger-ink" : ""}`}>{p.problems ? int(p.problems) : <span className="zero">0</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {counts.length ? (
        <div className="card-body flex flex-wrap items-center gap-2" style={{ borderTop: "1px solid var(--line)", paddingTop: 10, paddingBottom: 10 }}>
          <button type="button" className={`btn btn-sm${show === "all" ? " btn-primary" : ""}`} aria-pressed={show === "all"} onClick={() => setShow(show === "all" ? null : "all")}>All · {int(problems.length)}</button>
          {counts.map(({ c, n }) => (
            <button key={c} type="button" className={`btn btn-sm${show === c ? " btn-primary" : ""}`} aria-pressed={show === c} title={CONNECTION_PROBLEMS[c].hint} onClick={() => setShow(show === c ? null : c)}>
              {CONNECTION_PROBLEMS[c].label} · {int(n)}
            </button>
          ))}
        </div>
      ) : null}
      {show ? (
        <div className="list" style={{ maxHeight: 360, overflowY: "auto", borderTop: "1px solid var(--line)" }}>
          {shown.map((r) => (
            <div key={`${r.provider}|${r.name}`} className="list-row">
              <Dot tone={r.state === "warmup_off" || r.state === "warmup_blocked" ? "warning" : "danger"} />
              <div className="list-main">
                {r.domainId ? <DomainLink id={r.domainId} className="list-title hover:underline">{r.name}</DomainLink> : <span className="list-title">{r.name}</span>}
                <span className="list-meta" title={CONNECTION_PROBLEMS[r.state].hint}>{r.provider} · {detail(r)}</span>
              </div>
              <span className="hidden sm:inline-flex"><ClientCell name={r.clientName} hue={r.clientHue} /></span>
            </div>
          ))}
        </div>
      ) : null}
      {withoutOrder || notes.length ? (
        <p className="card-body text-muted" style={{ borderTop: "1px solid var(--line)", paddingTop: 8, paddingBottom: 8, fontSize: 12 }}>
          {notes.length ? <>Not counted as problems: {notes.join(", ")}. </> : null}
          {withoutOrder ? <Link href="/inboxes?view=attention" className="hover:underline">{int(withoutOrder)} more domain{withoutOrder === 1 ? " is" : "s are"} connected in Smartlead without an active order.</Link> : null}
        </p>
      ) : null}
    </section>
  );
}
