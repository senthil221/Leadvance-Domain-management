"use client";

import { DomainLink } from "@/components/domains/DomainLink";
import Link from "next/link";
import { useState } from "react";
import { Ban, Check, CircleCheck, Globe, SearchX, ThermometerSnowflake, Trash2, TriangleAlert, Unplug, type LucideIcon } from "lucide-react";
import { ClientCell } from "@/components/ui";
import { CONNECTION_PROBLEMS, type ConnectionProblem } from "@/lib/connections";
import { ago, int } from "@/lib/format";
import type { ConnectionCheckData, ConnectionProvider, ConnectionRow } from "@/lib/queries";

// Worst first: broken means nothing can send, the rest are at risk.
const CAUSES: { c: ConnectionProblem; icon: LucideIcon; broken: boolean }[] = [
  { c: "dns_gone", icon: Globe, broken: true },
  { c: "disconnected", icon: Unplug, broken: true },
  { c: "deleted", icon: Trash2, broken: true },
  { c: "missing", icon: SearchX, broken: false },
  { c: "warmup_off", icon: ThermometerSnowflake, broken: false },
  { c: "warmup_blocked", icon: Ban, broken: false },
];
const isBroken = (s: ConnectionProblem) => CAUSES.some((x) => x.c === s && x.broken);
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

/** One count against the orders: a check when it matches, the gap when it doesn't. */
function Match({ label, n, of, risk }: { label: string; n: number; of?: number; risk?: boolean }) {
  const gap = of == null ? 0 : of - n;
  return (
    <div className="conn-count">
      <span className="conn-count-label">{label}</span>
      <span className="conn-count-value">
        {int(n)}
        {of == null ? null : gap > 0
          ? <span className={`conn-gap${risk ? " is-risk" : ""}`}>−{int(gap)}</span>
          : <Check size={14} strokeWidth={2.25} className="conn-ok" aria-label="matches" />}
      </span>
    </div>
  );
}

function ProviderRow({ p, problems }: { p: ConnectionProvider; problems: ConnectionRow[] }) {
  const mine = problems.filter((r) => r.provider === p.provider);
  const broken = mine.filter((r) => isBroken(r.state)).length;
  const segs = [
    { k: "live", n: p.ok, tone: "success", label: "Fully live" },
    { k: "risk", n: mine.length - broken, tone: "warning", label: "Warm-up off or not in Smartlead" },
    { k: "broken", n: broken, tone: "danger", label: "Broken" },
    { k: "setup", n: p.settingUp, tone: "info", label: "Being set up" },
    { k: "retired", n: p.retiring, tone: "faint", label: "Retired, still billed" },
  ].filter((s) => s.n > 0);
  return (
    <div className="conn-provider">
      <div className="conn-provider-top">
        <span className="conn-provider-name">{p.provider}</span>
        <Match label="Active orders" n={p.orders} />
        <Match label="Smartlead active" n={p.connected} of={p.orders - p.settingUp - p.retiring} />
        <Match label="Warm-up on" n={p.ok} of={p.connected} risk />
      </div>
      <div className="conn-bar" role="img" aria-label={segs.map((s) => `${s.label}: ${s.n}`).join(", ")}>
        {segs.map((s) => <span key={s.k} className={`tone-${s.tone}`} style={{ flex: s.n }} title={`${s.label}: ${int(s.n)}`} />)}
      </div>
    </div>
  );
}

/** Are active orders and Smartlead the same? The verdict first, the counts per provider, and what's off by cause. */
export function ConnectionCheck({ data }: { data: ConnectionCheckData }) {
  const { providers, problems, withoutOrder, syncs } = data;
  const [show, setShow] = useState<ConnectionProblem | "all" | null>(null);
  const counts = CAUSES.map((x) => ({ ...x, n: problems.filter((r) => r.state === x.c).length })).filter((x) => x.n > 0);
  const shown = show === "all" ? problems : problems.filter((r) => r.state === show);
  const stale = syncs.filter((s) => s.stale);
  const orders = providers.reduce((a, p) => a + p.orders, 0);
  const expected = providers.reduce((a, p) => a + p.orders - p.settingUp - p.retiring, 0);
  const live = providers.reduce((a, p) => a + p.ok, 0);
  const settingUp = providers.reduce((a, p) => a + p.settingUp, 0);
  const retiring = providers.reduce((a, p) => a + p.retiring, 0);
  const anyBroken = problems.some((r) => isBroken(r.state));
  const tone = problems.length ? (anyBroken ? "danger" : "warning") : stale.length ? "warning" : "success";
  const notes = [
    settingUp ? `${int(settingUp)} being set up` : null,
    retiring ? `${int(retiring)} retired but still billed` : null,
  ].filter(Boolean);

  return (
    <section className={`card conn tone-${tone}`} id="connections" aria-label="Connections: active orders against Smartlead" style={{ scrollMarginTop: 72 }}>
      <div className="conn-main">
        <div className="conn-hero">
          <p className="conn-eyebrow">Connections</p>
          {providers.length === 0 ? (
            <p className="conn-verdict">No active orders synced yet</p>
          ) : problems.length ? (
            <>
              <p className="conn-figure">{int(problems.length)}</p>
              <p className="conn-verdict">domain{problems.length === 1 ? "" : "s"} to check</p>
              <p className="conn-sub">{int(live)} of {int(expected)} fully live</p>
            </>
          ) : (
            <>
              <p className="conn-figure conn-figure-ok"><CircleCheck size={34} strokeWidth={1.75} aria-hidden="true" />{int(live)}</p>
              <p className="conn-verdict">All connected</p>
              <p className="conn-sub">Every active order is live and warming</p>
            </>
          )}
        </div>

        {providers.length ? (
          <div className="conn-providers">
            {providers.map((p) => <ProviderRow key={p.provider} p={p} problems={problems} />)}
            {orders > live ? (
              <div className="conn-legend">
                <span><i className="dot tone-success" />Live</span>
                <span><i className="dot tone-warning" />At risk</span>
                {anyBroken ? <span><i className="dot tone-danger" />Broken</span> : null}
                {settingUp ? <span><i className="dot tone-info" />Setting up</span> : null}
                {retiring ? <span><i className="dot tone-faint" />Retired</span> : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {counts.length ? (
          <div className="conn-causes">
            {counts.map(({ c, n, icon: Icon, broken }) => (
              <button key={c} type="button" className={`conn-cause tone-${broken ? "danger" : "warning"}`} aria-pressed={show === c} title={CONNECTION_PROBLEMS[c].hint} onClick={() => setShow(show === c ? null : c)}>
                <span className="conn-cause-icon"><Icon size={15} strokeWidth={1.75} aria-hidden="true" /></span>
                <span className="conn-cause-n">{int(n)}</span>
                <span className="conn-cause-label">{CONNECTION_PROBLEMS[c].label}</span>
              </button>
            ))}
            {counts.length > 1 ? (
              <button type="button" className="conn-all" aria-pressed={show === "all"} onClick={() => setShow(show === "all" ? null : "all")}>
                {show === "all" ? "Hide the list" : `See all ${int(problems.length)}`}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {stale.length ? (
        <p className="conn-note is-warning" role="alert">
          <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
          {stale.map((s) => s.label).join(" and ")} {stale.length === 1 ? "isn't" : "aren't"} syncing, so these numbers may be out of date.
        </p>
      ) : null}

      {show ? (
        <div className="conn-list">
          {shown.map((r) => (
            <div key={`${r.provider}|${r.name}`} className="list-row">
              <span className={`conn-row-mark tone-${isBroken(r.state) ? "danger" : "warning"}`} aria-hidden="true" />
              <div className="list-main">
                {r.domainId ? <DomainLink id={r.domainId} className="list-title hover:underline">{r.name}</DomainLink> : <span className="list-title">{r.name}</span>}
                <span className="list-meta" title={CONNECTION_PROBLEMS[r.state].hint}>{r.provider} · {detail(r)}</span>
              </div>
              <span className="hidden sm:inline-flex"><ClientCell name={r.clientName} hue={r.clientHue} /></span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="conn-note">
        {notes.length ? <span>Not counted: {notes.join(", ")}.</span> : null}
        {withoutOrder ? <Link href="/inboxes?view=attention" className="hover:underline">{int(withoutOrder)} more connected in Smartlead without an active order</Link> : null}
        <span className="conn-sync" title="Hypertide orders sync every 5 minutes, Smartlead inboxes and Icemail every 30">
          {syncs.map((x) => (
            <span key={x.label} className={x.stale ? "is-stale" : undefined} suppressHydrationWarning>{x.label} {x.at ? ago(x.at) : "never"}</span>
          ))}
        </span>
      </div>
    </section>
  );
}
