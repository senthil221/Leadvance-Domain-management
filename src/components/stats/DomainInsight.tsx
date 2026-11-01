"use client";

import { useEffect, useState } from "react";
import { loadBounceDetail } from "@/app/actions";
import { BOUNCE_META } from "@/lib/bounces";
import type { BounceDetail } from "@/lib/bounce-detail";
import { int, shortDate } from "@/lib/format";
import { advise, type Advice, type Judged } from "@/lib/review";

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(n / d < 0.1 ? 1 : 0)}%` : "—");

/** The suggestion beside a domain: the one thing that matters most, with the rest on hover. */
export function AdviceCell({ call }: { call: Judged | null }) {
  if (!call) return <span className="zero">—</span>;
  const list = advise(call);
  if (!list.length) return <span className="zero">—</span>;
  const [first, ...rest] = list;
  return (
    <span className={`st-advice tone-${first.tone}`} title={list.map((a) => a.text).join("\n")}>
      <i aria-hidden />
      <span>{first.text}</span>
      {rest.length ? <span className="text-faint"> +{rest.length}</span> : null}
    </span>
  );
}

function AdviceList({ list }: { list: Advice[] }) {
  return (
    <ul className="st-advice-list">
      {list.map((a, i) => <li key={i} className={`st-advice tone-${a.tone}`}><i aria-hidden /><span>{a.text}</span></li>)}
    </ul>
  );
}

/**
 * Under a domain's row in Performance: what to do about it, why its emails
 * bounced in the receiving servers' own words, which campaigns the bounces
 * came from and which recipient providers refused.
 */
export function DomainInsight({ id, call, from, to, sent, bounces }: { id: string; call: Judged | null; from: string; to: string; sent: number; bounces: number }) {
  const [detail, setDetail] = useState<BounceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadBounceDetail({ domainId: id, from, to }).then((r) => {
      if (!live) return;
      if (r.ok) setDetail(r.data); else setError(r.error);
    });
    return () => { live = false; };
  }, [id, from, to]);
  const list = call ? advise(call) : [];

  return (
    <div className="st-insight">
      <section>
        <h3 className="st-insight-h">What to do</h3>
        {list.length ? <AdviceList list={list} /> : <p className="rv-none">No review call for this range.</p>}
        {call?.chips.length ? <p className="rv-why" style={{ marginTop: 8 }}>{call.why}</p> : null}
      </section>
      <section>
        <h3 className="st-insight-h">Why it bounced{detail ? <span className="text-faint"> · {int(detail.total)} bounce{detail.total === 1 ? "" : "s"}{sent ? `, ${pct(detail.total, sent)} of sent` : ""}</span> : null}</h3>
        {error ? <p className="cfg-note is-warn">{error}</p> : !detail ? <p className="rv-none">Loading…</p> : !detail.total ? <p className="rv-none">{bounces ? `No bounce notices on record for this range, though the daily numbers count ${int(bounces)}.` : "No bounces in this range."}</p> : (
          <>
            <div className="st-causes">
              {detail.causes.map((c) => (
                <span key={c.cause} className={`st-cause tone-${BOUNCE_META[c.cause].tone}`} title={BOUNCE_META[c.cause].hint}>
                  {BOUNCE_META[c.cause].label} <b>{int(c.n)}</b> <span className="text-faint">{pct(c.n, detail.total)}</span>
                </span>
              ))}
            </div>
            <p className="rv-note">{BOUNCE_META[detail.causes[0].cause].hint}.</p>
            <table className="data-table st-lines">
              <thead><tr><th>What the server said</th><th>Cause</th><th className="is-num">Bounces</th><th className="is-num">Last</th></tr></thead>
              <tbody>
                {detail.lines.map((l, i) => (
                  <tr key={i}>
                    <td className="st-line">{l.line}</td>
                    <td><span className={`badge tone-${BOUNCE_META[l.cause].tone}`}>{BOUNCE_META[l.cause].label}</span></td>
                    <td className="is-num">{int(l.n)}</td>
                    <td className="is-num text-muted">{shortDate(l.last)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
      <section>
        <h3 className="st-insight-h">Campaigns</h3>
        {detail?.campaigns.length ? (
          <ul className="st-mini">
            {detail.campaigns.map((c) => (
              <li key={`${c.id}-${c.name}`}>
                <span className="truncate" title={c.name}>{c.name}</span>
                <span className="text-muted">{int(c.n)}{c.missing ? <> · <span className={c.missing >= 0.5 * c.n ? "text-warning-ink" : undefined}>{pct(c.missing, c.n)} dead addresses</span></> : null}</span>
              </li>
            ))}
          </ul>
        ) : <p className="rv-none">{detail ? "None" : "…"}</p>}
        {/* Smartlead doesn't always say who the recipient's provider is: shown only when it does. */}
        {detail?.recipients.some((r) => r.esp !== "Unknown") ? <h3 className="st-insight-h" style={{ marginTop: 12 }}>Refused by</h3> : null}
        {!detail?.recipients.some((r) => r.esp !== "Unknown") ? null : detail.recipients.length ? (
          <ul className="st-mini">
            {detail.recipients.map((r) => (
              <li key={r.esp}>
                <span>{r.esp}</span>
                <span className="text-muted">{int(r.n)}{r.spam ? <> · <span className="text-danger-ink">{int(r.spam)} spam</span></> : null}</span>
              </li>
            ))}
          </ul>
        ) : <p className="rv-none">{detail ? "None" : "…"}</p>}
      </section>
    </div>
  );
}
