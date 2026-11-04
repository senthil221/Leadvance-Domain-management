"use client";

import { ArrowDownRight, ArrowLeft, ArrowUpRight, BarChart3, Check, Columns2, Minus, Pencil, TriangleAlert, Unplug, Wrench } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { DomainLink } from "@/components/domains/DomainLink";
import { RangePicker } from "@/components/RangePicker";
import { SortTh, type SortState } from "@/components/SortTh";
import { PageHead } from "@/components/ui";
import { loadClientSending, setClientPromise } from "@/app/actions";
import { change, dayState, promiseReport, promiseVerdict, type DayState, type SendDay } from "@/lib/client-sending";
import { int } from "@/lib/format";
import type { ClientDomainRow, ClientSendingData } from "@/lib/queries";
import { nice, weekday } from "@/lib/range";
import { STANDING_META } from "@/lib/review";

const STATE_LABEL: Record<DayState, string> = { met: "Met the promise", short: "Under the promise", off: "Not a promised day", today: "Today, still sending", open: "Sent" };

const niceTop = (v: number) => {
  if (v <= 0) return 10;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((x) => x >= v) ?? v;
};

/** Sent per day against the promise line, with the day's numbers on hover or focus. */
function SendingChart({ days, promised, capacity, weekends, today }: { days: SendDay[]; promised: number | null; capacity: number; weekends: boolean; today: string }) {
  const top = niceTop(Math.max(1, promised ?? 0, ...days.map((d) => d.sent)) * 1.05);
  const grid = [top, top / 2, 0];
  const y = (v: number) => `${100 - (100 * v) / top}%`;
  const label = days.length > 21 ? Math.ceil(days.length / 10) : days.length > 14 ? 2 : 1;
  return (
    <div className="cl-chart" role="img" aria-label={`Emails sent per day, ${nice(days[0].day)} to ${nice(days.at(-1)!.day)}${promised ? `, against ${int(promised)} promised` : ""}. The table view has every value.`}>
      <div className="cl-plot">
        {grid.map((g) => (
          <span key={g} className="cl-grid" style={{ top: y(g) }}><i className="num">{g >= 1000 ? `${(g / 1000).toFixed(g % 1000 ? 1 : 0)}K` : g}</i></span>
        ))}
        {promised ? <span className="cl-target" style={{ top: y(promised) }}><b className="num">Promised {int(promised)}</b></span> : null}
        <div className="cl-bars" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
          {days.map((d, i) => {
            const s = dayState(d.day, d.sent, promised, weekends, today);
            const edge = i < 3 ? " is-start" : i >= days.length - 3 ? " is-end" : "";
            return (
              <div key={d.day} className="cl-col" tabIndex={0} aria-label={`${nice(d.day)}: ${int(d.sent)} sent. ${STATE_LABEL[s]}`}>
                <span className={`cl-bar is-${s}`} style={{ height: `${(100 * d.sent) / top}%` }} />
                <div className={`st-tip${edge}`}>
                  <b>{weekday(d.day)} {nice(d.day)}</b>
                  <span><i>Sent</i>{int(d.sent)}</span>
                  {promised && s !== "off" && s !== "today" ? <span><i>Against promise</i>{d.sent >= promised ? "+" : "−"}{int(Math.abs(d.sent - promised))}</span> : null}
                  <span><i>Domains sending</i>{int(d.senders)}</span>
                  <span><i>Human replies</i>{int(d.human)}</span>
                  <span><i>Bounces</i>{int(d.bounces)}</span>
                  <em>{STATE_LABEL[s]}</em>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="cl-axis" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
        {days.map((d, i) => <span key={d.day}>{(days.length - 1 - i) % label === 0 ? (days.length > 14 ? nice(d.day) : weekday(d.day).slice(0, 2)) : ""}</span>)}
      </div>
      <ul className="cl-legend">
        {promised ? (
          <>
            <li><span className="cl-key is-met" />Met</li>
            <li><span className="cl-key is-short" />Under the promise</li>
          </>
        ) : <li><span className="cl-key is-open" />Sent</li>}
        <li><span className="cl-key is-off" />{weekends ? "Today, still sending" : "Weekend or today"}</li>
        <li className="cl-legend-cap num">Inboxes can send {int(capacity)} a day</li>
      </ul>
    </div>
  );
}

function PromiseEditor({ data, onSaved, onClose }: { data: ClientSendingData; onSaved: (promised: number | null, weekends: boolean) => void; onClose: () => void }) {
  const [value, setValue] = useState(data.client.promisedDaily?.toString() ?? "");
  const [weekends, setWeekends] = useState(data.client.sendWeekends);
  const [error, setError] = useState<string | null>(null);
  const [saving, start] = useTransition();
  const save = () => start(async () => {
    const clean = value.replace(/[,\s]/g, "");
    const n = clean === "" ? null : Number(clean);
    if (n != null && (!Number.isInteger(n) || n < 0)) { setError("Use a whole number"); return; }
    const r = await setClientPromise({ id: data.client.id, promisedDaily: n, sendWeekends: weekends });
    if (!r.ok) { setError(r.error); return; }
    onSaved(n, weekends);
    onClose();
  });
  return (
    <form className="cl-edit" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <label className="cl-edit-field">
        <span>Emails promised per sending day</span>
        <input className="input num" inputMode="numeric" autoFocus value={value} onChange={(e) => { setValue(e.target.value); setError(null); }} placeholder="e.g. 1000" />
      </label>
      <label className="cl-edit-check">
        <input type="checkbox" checked={weekends} onChange={(e) => setWeekends(e.target.checked)} />
        Sends at weekends too
      </label>
      <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      {error ? <span className="cl-edit-error" role="alert">{error}</span> : null}
      <span className="cl-edit-note">Leave it empty to clear it. This comes from your agreement, so nothing fills it in for you.</span>
    </form>
  );
}

type DomainKey = "name" | "state" | "capacity" | "sent" | "change" | "bounce";
const domainValue = (d: ClientDomainRow, k: DomainKey): string | number | null =>
  k === "name" ? d.name : k === "state" ? (d.standing ?? "") : k === "capacity" ? d.capacity : k === "sent" ? d.sent : k === "change" ? d.sentFinished - d.prevSent : d.sent ? d.bounces / d.sent : null;

/** Why the sending moved: the domains whose volume changed most, and what's wrong with them now. */
function whyMoved(domains: ClientDomainRow[]) {
  return domains
    .map((d) => ({ d, delta: d.sentFinished - d.prevSent }))
    .filter((x) => Math.abs(x.delta) >= 10)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}
const stateOf = (d: ClientDomainRow) => {
  if (d.standing && d.standing !== "active") return STANDING_META[d.standing].label;
  if (d.disconnected) return `${int(d.disconnected)} inbox${d.disconnected === 1 ? "" : "es"} disconnected`;
  return null;
};

/** One client's daily sending against what they were promised. */
export function ClientSending({ initial }: { initial: ClientSendingData }) {
  const [data, setData] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [view, setView] = useState<"chart" | "table">("chart");
  const [loading, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState<DomainKey>>({ key: "sent", dir: -1 });
  const { client, days, today } = data;
  const promised = client.promisedDaily, weekends = client.sendWeekends;

  const report = useMemo(() => promiseReport(days, promised, weekends, today), [days, promised, weekends, today]);
  const prev = useMemo(() => promiseReport(data.prevDays, null, weekends, today), [data.prevDays, weekends, today]);
  const delta = change(report.avg, prev.avg);
  const verdict = promiseVerdict(report, promised, client.capacity);
  const moved = useMemo(() => whyMoved(data.domains), [data.domains]);

  const tags = useMemo(() => {
    const own = client.name.trim().toLowerCase();
    const m = new Map<string, { label: string; domains: number; sent: number; prev: number; finished: number; capacity: number }>();
    for (const d of data.domains) {
      for (const t of d.tags) {
        const k = t.toLowerCase();
        if (k === own) continue;
        const e = m.get(k) ?? { label: t, domains: 0, sent: 0, prev: 0, finished: 0, capacity: 0 };
        e.domains++; e.sent += d.sent; e.prev += d.prevSent; e.finished += d.sentFinished; e.capacity += d.capacity;
        m.set(k, e);
      }
    }
    return [...m.values()].sort((a, b) => b.sent - a.sent);
  }, [data.domains, client.name]);

  const sortedDomains = useMemo(() => [...data.domains].sort((a, b) => {
    const x = domainValue(a, sort.key), y = domainValue(b, sort.key);
    if (x === y) return a.name.localeCompare(b.name);
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : 1) * sort.dir;
  }), [data.domains, sort]);
  const onSort = (key: DomainKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "name" || key === "state" ? 1 : -1 }));

  const load = (from: string, to: string) => start(async () => {
    const r = await loadClientSending({ id: client.id, from, to });
    if (r.ok) { setData(r.data); setError(null); } else setError(r.error);
  });

  const VerdictIcon = verdict.tone === "success" ? Check : verdict.tone === "faint" ? Minus : TriangleAlert;
  const lastShort = promised && report.last ? report.last.sent - promised : null;

  return (
    <>
      <PageHead title={client.name}>
        <Link href="/clients" className="btn"><ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />All clients</Link>
        <Link href={`/fix?client=${client.id}`} className="btn"><Wrench size={14} strokeWidth={1.75} aria-hidden="true" />Fix queue</Link>
        <Link href={`/compare?client=${client.id}&dim=tag`} className="btn"><Columns2 size={14} strokeWidth={1.75} aria-hidden="true" />Compare tags</Link>
        <Link href={`/stats?client=${client.id}`} className="btn"><BarChart3 size={14} strokeWidth={1.75} aria-hidden="true" />Stats</Link>
      </PageHead>
      <div className="page-body">
        <p className={`cl-verdict tone-${verdict.tone}`}>
          <VerdictIcon size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>{verdict.text}</span>
          {!promised && !editing ? <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing(true)}>Set promised volume</button> : null}
        </p>

        {editing ? (
          <section className="card">
            <PromiseEditor data={data} onClose={() => setEditing(false)} onSaved={(n, w) => setData((d) => ({ ...d, client: { ...d.client, promisedDaily: n, sendWeekends: w } }))} />
          </section>
        ) : null}

        <div className="stats is-5">
          <div className="stat">
            <span className="stat-label">Promised a day <button type="button" className="cl-edit-btn" aria-label="Change the promised volume" onClick={() => setEditing(true)}><Pencil size={11} strokeWidth={1.75} /></button></span>
            <span className="stat-value">{promised ? int(promised) : <span className="zero">Not set</span>}</span>
            <span className="stat-foot">{weekends ? "Every day" : "Monday to Friday"}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Last sending day</span>
            <span className="stat-value">{report.last ? int(report.last.sent) : <span className="zero">—</span>}</span>
            <span className="stat-foot">
              {report.last ? `${weekday(report.last.day)} ${nice(report.last.day)}` : "None in this range"}
              {lastShort != null ? <span className={lastShort >= 0 ? "delta-up" : "delta-down"}>{lastShort >= 0 ? "+" : "−"}{int(Math.abs(lastShort))}</span> : null}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Average a sending day</span>
            <span className="stat-value">{report.avg != null ? int(Math.round(report.avg)) : <span className="zero">—</span>}</span>
            <span className="stat-foot">
              {delta != null ? (
                <span className={Math.abs(delta) < 1 ? undefined : delta > 0 ? "delta-up" : "delta-down"}>
                  {Math.abs(delta) < 1 ? "Flat" : <>{delta > 0 ? <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" className="inline" /> : <ArrowDownRight size={12} strokeWidth={2} aria-hidden="true" className="inline" />} {Math.abs(delta).toFixed(0)}%</>}
                </span>
              ) : null}
              {delta != null ? "vs the same days before" : "Nothing to compare with"}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Days the promise was met</span>
            <span className="stat-value">{promised ? `${report.met} of ${report.days}` : <span className="zero">—</span>}</span>
            <span className="stat-foot">{promised ? (report.shortfall ? `${int(report.shortfall)} emails short` : "Nothing short") : "Set a promise to track this"}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Inboxes can send</span>
            <span className={`stat-value${promised && client.capacity < promised ? " text-danger-ink" : ""}`}>{int(client.capacity)}</span>
            <span className="stat-foot">
              {client.disconnected ? <span className="delta-down"><Unplug size={11} strokeWidth={1.75} className="inline" aria-hidden="true" /> {int(client.lostCapacity)} a day lost, {int(client.disconnected)} disconnected</span> : `${int(client.inboxes)} inboxes on ${int(client.domains)} domains`}
            </span>
          </div>
        </div>

        <section className="card" aria-labelledby="cl-daily">
          <div className="card-head cl-head">
            <h2 id="cl-daily" className="card-title">Sent per day</h2>
            <div className="seg" role="group" aria-label="View">
              <button type="button" aria-pressed={view === "chart"} onClick={() => setView("chart")}>Chart</button>
              <button type="button" aria-pressed={view === "table"} onClick={() => setView("table")}>Table</button>
            </div>
            <span className="cl-range">
              <RangePicker from={data.from} to={data.to} today={today} loading={loading} onChange={load} />
            </span>
          </div>
          {error ? <p className="card-body text-danger-ink" role="alert">{error}</p> : null}
          <div style={{ opacity: loading ? 0.6 : 1 }}>
            {view === "chart" ? <div className="card-body"><SendingChart days={days} promised={promised} capacity={client.capacity} weekends={weekends} today={today} /></div> : (
              <div className="table-scroll cl-days">
                <table className="data-table">
                  <thead><tr><th>Day</th><th className="is-num">Sent</th>{promised ? <th className="is-num">Against promise</th> : null}<th className="is-num">Domains sending</th><th className="is-num">Human replies</th><th className="is-num">Bounces</th><th>State</th></tr></thead>
                  <tbody>
                    {[...days].reverse().map((d) => {
                      const s = dayState(d.day, d.sent, promised, weekends, today);
                      return (
                        <tr key={d.day}>
                          <td>{weekday(d.day)} {nice(d.day)}</td>
                          <td className="is-num">{int(d.sent)}</td>
                          {promised ? <td className="is-num">{s === "met" || s === "short" ? <span className={s === "met" ? "delta-up" : "delta-down"}>{d.sent >= promised ? "+" : "−"}{int(Math.abs(d.sent - promised))}</span> : <span className="zero">—</span>}</td> : null}
                          <td className="is-num">{int(d.senders)}</td>
                          <td className="is-num">{int(d.human)}</td>
                          <td className="is-num">{int(d.bounces)}</td>
                          <td className="cl-state">{STATE_LABEL[s]}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        <div className="cl-two">
          <section className="card" aria-labelledby="cl-moved">
            <div className="card-head">
              <h2 id="cl-moved" className="card-title">What moved the volume</h2>
              <span className="card-sub">Finished days vs the same days before</span>
            </div>
            {moved.length ? (
              <ul className="cl-moved">
                {moved.slice(0, 8).map(({ d, delta: n }) => {
                  const why = stateOf(d);
                  return (
                    <li key={d.id}>
                      <DomainLink id={d.id} className="cl-moved-name">{d.name}</DomainLink>
                      {why ? <span className="badge tone-warning">{why}</span> : null}
                      <span className={`num cl-moved-n ${n > 0 ? "delta-up" : "delta-down"}`}>{n > 0 ? "+" : "−"}{int(Math.abs(n))}</span>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="card-body cl-none">No domain&apos;s volume changed against the days before.</p>}
          </section>
          <section className="card" aria-labelledby="cl-tags">
            <div className="card-head">
              <h2 id="cl-tags" className="card-title">By tag</h2>
              {tags.length > 1 ? <Link href={`/compare?client=${client.id}&dim=tag`} className="card-link">Compare all {tags.length} <ArrowUpRight size={13} strokeWidth={1.5} /></Link> : null}
            </div>
            {tags.length ? (
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr><th>Tag</th><th className="is-num">Domains</th><th className="is-num">Sent</th><th className="is-num">Trend</th><th className="is-num">Can send a day</th></tr></thead>
                  <tbody>
                    {tags.slice(0, 10).map((t) => {
                      const c = change(t.finished, t.prev);
                      return (
                        <tr key={t.label}>
                          <td>{t.label}</td>
                          <td className="is-num">{int(t.domains)}</td>
                          <td className="is-num">{int(t.sent)}</td>
                          <td className="is-num">{c != null && Math.abs(c) >= 1 ? <span className={c > 0 ? "delta-up" : "delta-down"}>{c > 0 ? "+" : "−"}{Math.abs(c).toFixed(0)}%</span> : <span className="zero">—</span>}</td>
                          <td className="is-num">{int(t.capacity)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <p className="card-body cl-none">These domains have no tags.</p>}
          </section>
        </div>

        <section className="card" aria-labelledby="cl-domains">
          <div className="card-head">
            <h2 id="cl-domains" className="card-title">Domains</h2>
            <span className="card-sub">{data.domains.length} live, or sent in this range or the days before</span>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <SortTh k="name" sort={sort} onSort={onSort}>Domain</SortTh>
                  <SortTh k="state" sort={sort} onSort={onSort}>State</SortTh>
                  <SortTh k="capacity" sort={sort} onSort={onSort} num>Can send a day</SortTh>
                  <SortTh k="sent" sort={sort} onSort={onSort} num>Sent</SortTh>
                  <SortTh k="change" sort={sort} onSort={onSort} num title="Finished days against the same days before">Change</SortTh>
                  <SortTh k="bounce" sort={sort} onSort={onSort} num>Bounce</SortTh>
                </tr>
              </thead>
              <tbody>
                {sortedDomains.map((d) => {
                  const n = d.sentFinished - d.prevSent;
                  return (
                    <tr key={d.id}>
                      <td><DomainLink id={d.id} className="hover:underline">{d.name}</DomainLink></td>
                      <td className="cl-state" title={d.standing ? STANDING_META[d.standing].hint : undefined}>{stateOf(d) ?? (d.standing ? STANDING_META[d.standing].label : "—")}</td>
                      <td className="is-num">{d.capacity ? int(d.capacity) : <span className="zero">0</span>}</td>
                      <td className="is-num">{d.sent ? int(d.sent) : <span className="zero">0</span>}</td>
                      <td className="is-num">{n ? <span className={n > 0 ? "delta-up" : "delta-down"}>{n > 0 ? "+" : "−"}{int(Math.abs(n))}</span> : <span className="zero">0</span>}</td>
                      <td className="is-num">{d.sent ? `${((100 * d.bounces) / d.sent).toFixed(1)}%` : <span className="zero">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}
