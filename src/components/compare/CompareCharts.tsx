"use client";

import { ArrowDown, ArrowUp, Equal, Minus } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { formatMetric, METRICS, metricValue, standAgainst, wilson, type Group, type MetricKey, type TrendBucket, type TrendSeries } from "@/lib/compare";
import { int } from "@/lib/format";
import { nice } from "@/lib/range";

/** The chart colour a group wears. Slots stay with the group, whatever else is picked. */
export const seriesColor = (slot: number | null) => (slot == null ? "var(--faint)" : `var(--cat-${slot + 1})`);

export const STATE_META = {
  ahead: { label: "Ahead", icon: ArrowUp, cls: "is-ahead" },
  behind: { label: "Behind", icon: ArrowDown, cls: "is-behind" },
  level: { label: "In line", icon: Equal, cls: "is-level" },
  low: { label: "Too little sent", icon: Minus, cls: "is-low" },
  none: { label: "", icon: Minus, cls: "" },
} as const;

/** Each group's value on one metric, best first, with the average and how sure each number is. */
export function RankedBars({ groups, all, metric, slotOf, picked, onPick }: {
  groups: Group[]; all: Group; metric: MetricKey; slotOf: (key: string) => number | null;
  picked: string | null; onPick: (key: string) => void;
}) {
  const def = METRICS[metric];
  const rows = useMemo(() => groups.map((g) => {
    const v = metricValue(g, metric);
    return { g, v, range: def.kind === "rate" ? wilson(def.count(g), g.sent) : null, stand: standAgainst(g, all, metric) };
  }).sort((a, b) => {
    // What can be judged first, best first; the rest under it.
    const low = Number(a.stand.state === "low") - Number(b.stand.state === "low");
    if (low) return low;
    if (a.v == null || b.v == null) return a.v == null ? 1 : -1;
    return (b.v - a.v) * (def.better || 1);
  }), [groups, all, metric, def]);
  const avg = metricValue(all, metric);
  const top = Math.max(0.0001, ...rows.map((r) => Math.max(r.v ?? 0, r.stand.state === "low" ? 0 : r.range?.[1] ?? 0)), avg ?? 0) * 1.05;
  const at = (v: number) => `${Math.min(100, (100 * v) / top)}%`;
  return (
    <div className="cmp-rank" role="list" aria-label={`${def.label} by group`}>
      {avg != null && def.kind !== "count" ? (
        <div className="cmp-rank-avg" aria-hidden="true"><span style={{ left: at(avg) }}><b className="num">Everything in view {formatMetric(avg, metric)}</b></span></div>
      ) : null}
      {rows.map(({ g, v, range, stand }) => {
        const s = STATE_META[stand.state];
        const Icon = s.icon;
        return (
          <button key={g.key} type="button" role="listitem" className={`cmp-rank-row${picked === g.key ? " is-picked" : ""}`} onClick={() => onPick(g.key)}
            aria-label={`${g.label}: ${formatMetric(v, metric)}. ${s.label}. ${int(g.sent)} sent. Show its domains.`}>
            <span className="cmp-rank-name"><span className="cmp-dot" style={{ background: seriesColor(slotOf(g.key)) }} />{g.label}</span>
            <span className="cmp-rank-track">
              {avg != null && def.kind !== "count" ? <span className="cmp-rank-line" style={{ left: at(avg) }} /> : null}
              {v != null ? <span className={`cmp-rank-bar${stand.state === "low" ? " is-low" : ""}`} style={{ width: at(v), background: seriesColor(slotOf(g.key)) }} /> : null}
              {range && stand.state !== "low" ? <span className="cmp-rank-range" style={{ left: at(range[0]), width: `calc(${at(range[1])} - ${at(range[0])})` }} /> : null}
            </span>
            <span className="cmp-rank-value num">{formatMetric(v, metric)}</span>
            <span className={`cmp-state ${s.cls}`}>{stand.state !== "none" ? <><Icon size={12} strokeWidth={2} aria-hidden="true" />{s.label}</> : null}</span>
            <span className="st-tip cmp-rank-tip">
              <b>{g.label}</b>
              <span><i>{def.label}</i>{formatMetric(v, metric)}</span>
              {range ? <span><i>Likely range</i>{formatMetric(range[0], metric)} to {formatMetric(range[1], metric)}</span> : null}
              <span><i>Sent</i>{int(g.sent)}</span>
              <span><i>Domains</i>{int(g.domains)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((x) => x >= v) ?? v;
};

type Line = { key: string; label: string; color: string; values: (number | null)[]; sent: number[] };

/** One line per group over the range, with a crosshair and every value at that point. */
export function TrendChart({ series, buckets, metric, labelOf, slotOf, today }: {
  series: TrendSeries[]; buckets: TrendBucket[]; metric: MetricKey; labelOf: (key: string) => string; slotOf: (key: string) => number | null; today: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!box.current || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => { if (e.contentRect.width > 0) setWidth(e.contentRect.width); });
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const lines: Line[] = series.map((s) => ({ key: s.key, label: labelOf(s.key), color: seriesColor(slotOf(s.key)), values: s.values, sent: s.sent }));
  const direct = lines.length <= 4 && width >= 480;
  const H = 230, L = 44, R = direct ? 96 : 12, T = 12, B = 24;
  const n = buckets.length;
  const plotW = Math.max(10, width - L - R), plotH = H - T - B;
  const peak = niceMax(Math.max(0, ...lines.flatMap((l) => l.values.map((v) => v ?? 0))) * 1.05);
  const x = (i: number) => L + (n > 1 ? (i * plotW) / (n - 1) : plotW / 2);
  const y = (v: number) => T + plotH - (v / peak) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * peak);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 70))));
  const fmt = (v: number) => (METRICS[metric].kind === "rate" ? `${v < 10 ? v.toFixed(v < 1 ? 2 : 1) : v.toFixed(0)}%` : v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}K` : String(Math.round(v)));
  const lastIsLive = buckets.at(-1)?.to === today;

  /** The path, broken where a point has too little behind it; today's unfinished segment is drawn apart. */
  const paths = (l: Line) => {
    const solid: string[] = [];
    let open = false;
    const end = lastIsLive ? n - 1 : n;
    for (let i = 0; i < end; i++) {
      const v = l.values[i];
      if (v == null) { open = false; continue; }
      solid.push(`${open ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`);
      open = true;
    }
    const a = l.values[n - 2], b = l.values[n - 1];
    return { solid: solid.join(" "), live: lastIsLive && a != null && b != null ? `M${x(n - 2).toFixed(1)},${y(a).toFixed(1)} L${x(n - 1).toFixed(1)},${y(b).toFixed(1)}` : null };
  };

  // Direct labels on the last point, nudged apart so they don't overlap.
  const labels = direct ? lines.map((l) => {
    let i = n - 1;
    while (i >= 0 && l.values[i] == null) i--;
    return i < 0 ? null : { key: l.key, label: l.label, i, y: y(l.values[i]!) };
  }).filter((v): v is NonNullable<typeof v> => !!v).sort((a, b) => a.y - b.y) : [];
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 13) labels[i].y = labels[i - 1].y + 13;

  const move = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = n > 1 ? Math.round(((e.clientX - r.left - L) / plotW) * (n - 1)) : 0;
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      setHover((h) => Math.max(0, Math.min(n - 1, (h ?? n - 1) + (e.key === "ArrowLeft" ? -1 : 1))));
    }
    if (e.key === "Escape") setHover(null);
  };
  const tipLeft = hover != null ? x(hover) : 0;
  const hasData = lines.some((l) => l.values.some((v) => v != null));

  return (
    <div className="cmp-trend" ref={box}>
      {hasData ? (
        <svg width={width} height={H} role="img" tabIndex={0} aria-label={`${METRICS[metric].label} over time for ${lines.map((l) => l.label).join(", ")}. Use the arrow keys to read each point.`}
          onMouseMove={move} onMouseLeave={() => setHover(null)} onKeyDown={key} onBlur={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={L} x2={L + plotW} y1={y(t)} y2={y(t)} className={t === 0 ? "cmp-axis" : "cmp-grid"} />
              <text x={L - 6} y={y(t) + 3.5} textAnchor="end" className="cmp-tick">{fmt(t)}</text>
            </g>
          ))}
          {buckets.map((b, i) => ((n - 1 - i) % every === 0 ? <text key={b.from} x={x(i)} y={H - 7} textAnchor="middle" className="cmp-tick">{nice(b.from)}</text> : null))}
          {lines.map((l) => {
            const p = paths(l);
            return (
              <g key={l.key} style={{ color: l.color }}>
                <path d={p.solid} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {p.live ? <path d={p.live} fill="none" stroke="currentColor" strokeWidth={2} strokeDasharray="3 4" strokeLinecap="round" /> : null}
                {/* A point on its own has no line to show it. */}
                {l.values.map((v, i) => (v != null && l.values[i - 1] == null && l.values[i + 1] == null ? <circle key={i} cx={x(i)} cy={y(v)} r={3} fill="currentColor" /> : null))}
              </g>
            );
          })}
          {labels.map((t) => <text key={t.key} x={L + plotW + 7} y={t.y + 3.5} className="cmp-line-label">{t.label.length > 13 ? `${t.label.slice(0, 12)}…` : t.label}</text>)}
          {hover != null ? (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={T} y2={T + plotH} className="cmp-cross" />
              {lines.map((l) => (l.values[hover] != null ? <circle key={l.key} cx={x(hover)} cy={y(l.values[hover]!)} r={4.5} fill={l.color} stroke="var(--surface)" strokeWidth={2} /> : null))}
            </g>
          ) : null}
        </svg>
      ) : <p className="cmp-trend-empty">Not enough sent in this range to draw a line.</p>}
      {hover != null && hasData ? (
        <div className={`cmp-trend-tip${tipLeft > width * 0.6 ? " is-left" : ""}`} style={tipLeft > width * 0.6 ? { right: width - tipLeft + 12 } : { left: tipLeft + 12 }} role="status">
          <b>{buckets[hover].from === buckets[hover].to ? nice(buckets[hover].from) : `${nice(buckets[hover].from)} to ${nice(buckets[hover].to)}`}{buckets[hover].to === today ? ", so far" : ""}</b>
          {[...lines].sort((a, b) => (b.values[hover] ?? -1) - (a.values[hover] ?? -1)).map((l) => (
            <span key={l.key}><em><span className="cmp-dot" style={{ background: l.color }} />{l.label}</em><strong className="num">{l.values[hover] == null ? "Too little sent" : formatMetric(l.values[hover], metric)}</strong></span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

