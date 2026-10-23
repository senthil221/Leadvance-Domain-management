import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { SectionTabs } from "@/components/shell/SectionTabs";
import { initials } from "@/lib/format";
import { STATUS_META, type DomainStatus, type Tone } from "@/lib/status";

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="flex min-w-0 items-center gap-4">
        <h1 className="page-title">{title}</h1>
        <SectionTabs />
        {sub ? <p className="page-sub hidden 2xl:block">{sub}</p> : null}
      </div>
      {children ? <div className="page-actions">{children}</div> : null}
    </header>
  );
}

export function StatusDot({ status }: { status: DomainStatus }) {
  const m = STATUS_META[status];
  return <span className={`status-dot tone-${m.tone}${m.live ? " is-live" : ""}`} title={m.hint}>{m.label}</span>;
}

export function Dot({ tone }: { tone: Tone }) {
  return <span className={`dot tone-${tone}`} aria-hidden="true" />;
}

export function Badge({ tone, children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge${tone ? ` tone-${tone}` : ""}`}>{children}</span>;
}

// Replacement tags carry their state: New (violet) until the domain joins
// campaigns, Replaced with the days left in Hypertide's grace period.
function TagBadge({ tag, graceDaysLeft }: { tag: string; graceDaysLeft: number | null }) {
  const t = tag.toLowerCase();
  if (t === "new") return <span className="rpl-tag is-new" title="Replacement domain, warming before it joins campaigns">New</span>;
  if (t === "replaced") {
    if (graceDaysLeft == null) return <span className="rpl-tag is-gone" title="Replaced; its inboxes are gone">Replaced</span>;
    // The bar empties over the default 18-day grace period.
    const pct = Math.max(0, Math.min(100, (100 * graceDaysLeft) / 18));
    return (
      <span className={`rpl-tag is-replaced${graceDaysLeft <= 3 ? " is-ending" : ""}`} title="Replaced: Hypertide keeps its inboxes up for replies until the grace period ends">
        Replaced · {graceDaysLeft ? `${graceDaysLeft}d left` : "ends today"}
        <span className="rpl-grace"><span style={{ width: `${pct}%` }} /></span>
      </span>
    );
  }
  return <span className="badge">{tag}</span>;
}

/** A domain's tags, replacement tags first, the rest folded after `max`. */
export function TagList({ tags, graceDaysLeft = null, max = 2 }: { tags: string[]; graceDaysLeft?: number | null; max?: number }) {
  if (!tags.length) return null;
  const special = (t: string) => (["new", "replaced"].includes(t.toLowerCase()) ? 0 : 1);
  const sorted = [...tags].sort((a, b) => special(a) - special(b));
  const shown = sorted.slice(0, max), rest = sorted.slice(max);
  return (
    <>
      {shown.map((t) => <TagBadge key={t} tag={t} graceDaysLeft={graceDaysLeft} />)}
      {rest.length ? <span className="badge" title={rest.join(", ")}>+{rest.length}</span> : null}
    </>
  );
}

export function ClientCell({ name, hue }: { name: string | null; hue: number | null }) {
  if (!name) return <span className="zero">—</span>;
  return (
    <span className="client-cell">
      <span className="client-mark" style={{ "--h": hue ?? 250 } as CSSProperties}>{initials(name)}</span>
      <span>{name}</span>
    </span>
  );
}

export function Monogram({ name, hue }: { name: string; hue?: number }) {
  // Hue from the name when none is given, so a person keeps one colour.
  const h = hue ?? [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  return <span className="monogram" style={{ "--h": h } as CSSProperties}>{initials(name)}</span>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Empty({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon"><Icon size={18} strokeWidth={1.5} /></span>
      <p className="empty-title">{title}</p>
      {children ? <p className="empty-text">{children}</p> : null}
      {action}
    </div>
  );
}

export function Skeleton({ w, h = 14, className = "" }: { w?: number | string; h?: number; className?: string }) {
  return <span className={`skeleton block ${className}`} style={{ width: w ?? "100%", height: h }} />;
}

export function TableSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div className="table-wrap" aria-busy="true" aria-label="Loading">
      <div className="flex h-9 items-center gap-6 border-b border-line bg-surface-2 px-3">
        <Skeleton w={120} h={10} /><Skeleton w={80} h={10} /><Skeleton w={60} h={10} />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-[42px] items-center gap-6 border-b border-line px-3 last:border-0">
          <Skeleton w={16} h={16} /><Skeleton w={`${18 + ((i * 7) % 10)}%`} /><Skeleton w="12%" /><Skeleton w="10%" /><Skeleton w="8%" />
        </div>
      ))}
    </div>
  );
}

// 14-day sparkline. Flat zero lines are drawn faint at the bottom.
export function Spark({ values, bad = false, width = 64, height = 18 }: { values: number[]; bad?: boolean; width?: number; height?: number }) {
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const d = values.map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)},${(height - 1 - (v / max) * (height - 2)).toFixed(1)}`).join(" ");
  return (
    <svg className={`spark${bad ? " is-bad" : ""}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

// A rate cell: faint when there is no data, coloured when past a threshold.
export function Metric({ value, warn, bad, invert = false, digits = 1, suffix = "%" }: {
  value: number | null;
  warn?: number;
  bad?: number;
  invert?: boolean;
  digits?: number;
  suffix?: string;
}) {
  if (value == null) return <span className="metric zero">—</span>;
  const past = (t?: number) => t != null && (invert ? value < t : value > t);
  const cls = past(bad) ? " is-bad" : past(warn) ? " is-warn" : "";
  return <span className={`metric${cls}${value === 0 && !cls ? " zero" : ""}`}>{value.toFixed(digits)}{suffix}</span>;
}

/**
 * Warmup reputation, laid out the same in every row: a short bar (80–100),
 * the score with one decimal, and an optional fixed slot for how many
 * inboxes are under 90, so columns line up whatever the values.
 */
export function Rep({ value, low }: { value: number | null; low?: number }) {
  const slot = low !== undefined;
  if (value == null) return <span className={`rep${slot ? " has-low" : ""}`}><span className="rep-val zero">—</span>{slot ? <span /> : null}</span>;
  const tone = value < 90 ? "danger" : value < 95 ? "warning" : "success";
  return (
    <span className={`rep${slot ? " has-low" : ""}`} title={`Warmup reputation ${value.toFixed(1)}${low ? ` · ${low} inbox${low === 1 ? "" : "es"} under 90` : ""}`}>
      <span className={`rep-val is-${tone}`}>{value.toFixed(1)}</span>
      {slot ? <span className="rep-low" title={low ? `${low} inbox${low === 1 ? "" : "es"} under 90` : undefined}>{low ? `${low} low` : ""}</span> : null}
    </span>
  );
}
