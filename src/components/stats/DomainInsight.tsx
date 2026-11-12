"use client";

import { ArrowLeftRight, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { loadBounceDetail } from "@/app/actions";
import { DomainLink } from "@/components/domains/DomainLink";
import { BOUNCE_META } from "@/lib/bounces";
import type { BounceDetail } from "@/lib/bounce-detail";
import { int, shortDate } from "@/lib/format";
import { VERDICT_META, advise, type Advice, type Judged } from "@/lib/review";
import type { Trend } from "@/lib/trends";

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

/** The trend tags: days without a reply, and replies, bounces and reputation against the days before. */
export function TrendTags({ list, max }: { list: Trend[]; max?: number }) {
  if (!list.length) return <span className="zero">—</span>;
  const shown = max ? list.slice(0, max) : list;
  return (
    <span className="st-trends">
      {shown.map((t) => <span key={t.key} className={`st-trend tone-${t.tone}`} title={t.hint}>{t.label}</span>)}
      {shown.length < list.length ? <span className="text-faint text-[length:var(--fs-12)]" title={list.slice(shown.length).map((t) => `${t.label}: ${t.hint}`).join("\n")}>+{list.length - shown.length}</span> : null}
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

// Bounce details already fetched, so closing and reopening a domain is instant.
const cache = new Map<string, BounceDetail>();

/**
 * Under a domain's row in Performance. A header with the call, the trends and
 * the actions; then what to do and where the bounces came from on the left,
 * and why they bounced, in the receiving servers' own words, on the right.
 */
export function DomainInsight({ id, name, call, trends, from, to, sent, bounces, onReplace, replaceNote }: {
  id: string; name: string; call: Judged | null; trends: Trend[]; from: string; to: string; sent: number; bounces: number;
  /** Set when the domain can be replaced now; replaceNote says why not otherwise. */
  onReplace?: () => void; replaceNote?: string;
}) {
  const key = `${id}|${from}|${to}`;
  const [detail, setDetail] = useState<BounceDetail | null>(() => cache.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (cache.has(key)) return;
    let live = true;
    loadBounceDetail({ domainId: id, from, to }).then((r) => {
      if (r.ok) cache.set(key, r.data);
      if (!live) return;
      if (r.ok) setDetail(r.data); else setError(r.error);
    });
    return () => { live = false; };
  }, [key, id, from, to]);
  const list = call ? advise(call) : [];
  const meta = call ? VERDICT_META[call.verdict] : null;
  const refused = detail?.recipients.filter((r) => r.esp !== "Unknown") ?? [];

  return (
    <div className="st-insight">
      <header className="st-in-head">
        <div className="st-in-call">
          {meta ? <span className={`badge${meta.tone === "faint" ? "" : ` tone-${meta.tone}`}`} title={meta.hint}>{meta.label}</span> : null}
          {call?.why ? <span className="st-in-why" title={call.why}>{call.why}</span> : <span className="text-faint">No review call for this range</span>}
        </div>
        {trends.length ? <TrendTags list={trends} /> : null}
        <div className="st-in-actions">
          <DomainLink id={id} tab="stats" className="btn btn-sm"><ExternalLink size={13} /> Open {name}</DomainLink>
          <button type="button" className="btn btn-sm btn-primary" disabled={!onReplace} title={replaceNote ?? "Swap it for a free domain from storage"} onClick={onReplace}>
            <ArrowLeftRight size={13} /> Replace
          </button>
        </div>
      </header>

      <div className="st-in-grid">
        <div className="st-in-side">
          <section className="st-in-card">
            <h3 className="st-in-h">What to do</h3>
            {list.length ? <AdviceList list={list} /> : <p className="rv-none">Nothing to act on.</p>}
          </section>
          <section className="st-in-card">
            <h3 className="st-in-h">Campaigns with bounces</h3>
            {detail?.campaigns.length ? (
              <ul className="st-mini">
                {detail.campaigns.map((c) => (
                  <li key={`${c.id}-${c.name}`}>
                    <span className="st-mini-name" title={c.name}>{c.name}</span>
                    <span className="st-mini-n">
                      <b>{int(c.n)}</b>
                      {c.missing ? <span className={c.missing >= 0.5 * c.n ? "text-warning-ink" : "text-faint"}>{pct(c.missing, c.n)} dead</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p className="rv-none">{detail ? "None" : error ? "—" : "Loading…"}</p>}
          </section>
          {/* Smartlead doesn't always say who the recipient's provider is: shown only when it does. */}
          {refused.length ? (
            <section className="st-in-card">
              <h3 className="st-in-h">Refused by</h3>
              <ul className="st-mini">
                {detail!.recipients.map((r) => (
                  <li key={r.esp}>
                    <span className="st-mini-name">{r.esp}</span>
                    <span className="st-mini-n"><b>{int(r.n)}</b>{r.spam ? <span className="text-danger-ink">{int(r.spam)} spam</span> : null}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <section className="st-in-card st-in-main">
          <h3 className="st-in-h">
            Why it bounced
            {detail?.total ? <span className="st-in-sub">{int(detail.total)} bounce{detail.total === 1 ? "" : "s"}{sent ? ` · ${pct(detail.total, sent)} of sent` : ""}</span> : null}
          </h3>
          {error ? <p className="cfg-note is-warn">{error}</p> : !detail ? <p className="rv-none">Loading…</p> : !detail.total ? (
            <p className="rv-none">{bounces ? `No bounce notices on record for this range, though the daily numbers count ${int(bounces)}.` : "No bounces in this range."}</p>
          ) : (
            <>
              <div className="st-cause-bar" aria-hidden>
                {detail.causes.map((c) => <span key={c.cause} className={`tone-${BOUNCE_META[c.cause].tone}`} style={{ flexGrow: c.n }} title={`${BOUNCE_META[c.cause].label}: ${int(c.n)}`} />)}
              </div>
              <div className="st-causes">
                {detail.causes.map((c) => (
                  <span key={c.cause} className={`st-cause tone-${BOUNCE_META[c.cause].tone}`} title={BOUNCE_META[c.cause].hint}>
                    <i aria-hidden />{BOUNCE_META[c.cause].label} <b>{int(c.n)}</b> <span className="text-faint">{pct(c.n, detail.total)}</span>
                  </span>
                ))}
              </div>
              <p className="st-in-hint"><b>{BOUNCE_META[detail.causes[0].cause].label}:</b> {BOUNCE_META[detail.causes[0].cause].hint}.</p>
              <div className="st-lines-wrap">
                <table className="st-lines">
                  <colgroup><col /><col style={{ width: 132 }} /><col style={{ width: 72 }} /><col style={{ width: 96 }} /></colgroup>
                  <thead><tr><th>What the server said</th><th>Cause</th><th className="is-num">Bounces</th><th className="is-num">Last</th></tr></thead>
                  <tbody>
                    {detail.lines.map((l, i) => (
                      <tr key={i}>
                        <td><span className="st-line" title={l.line}>{l.line}</span></td>
                        <td><span className={`badge tone-${BOUNCE_META[l.cause].tone}`}>{BOUNCE_META[l.cause].label}</span></td>
                        <td className="is-num">{int(l.n)}</td>
                        <td className="is-num text-muted">{shortDate(l.last)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
