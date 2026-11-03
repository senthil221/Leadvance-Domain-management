import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, type LucideIcon } from "lucide-react";

export type Accent = "brand" | "violet" | "info" | "success" | "warning" | "danger" | "faint";

/** A signed change, coloured by whether that direction is good. */
export function Delta({ now, before, points = false, invert = false }: { now: number | null; before: number | null; points?: boolean; invert?: boolean }) {
  if (now == null || before == null || (!points && before === 0)) return null;
  const d = points ? now - before : (100 * (now - before)) / before;
  if (Math.abs(d) < (points ? 0.05 : 1)) return null;
  const Arrow = d > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`kpi-delta ${(invert ? d < 0 : d > 0) ? "is-good" : "is-bad"}`}>
      <Arrow size={12} strokeWidth={2} aria-hidden="true" />
      {Math.abs(d).toFixed(points ? 2 : 0)}{points ? " pts" : "%"}
    </span>
  );
}

/** A day-by-day trend with its last point marked; hover a day for its value. */
export function Sparkline({ points }: { points: { value: number | null; label: string }[] }) {
  const known = points.map((p) => p.value).filter((v): v is number => v != null);
  const max = Math.max(...known, 0);
  if (!known.length || max === 0) return <span className="kspark" />;
  const x = (i: number) => (points.length > 1 ? (100 * i) / (points.length - 1) : 50);
  const y = (v: number) => 30 - (28 * v) / max;
  const line = points.flatMap((p, i) => (p.value == null ? [] : [[x(i), y(p.value)] as const]));
  const path = line.map(([a, b], i) => `${i ? "L" : "M"}${a.toFixed(2)} ${b.toFixed(2)}`).join(" ");
  const [lastX, lastY] = line[line.length - 1];
  const step = 100 / points.length;
  return (
    <span className="kspark">
      <svg viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
        <path className="kspark-area" d={`${path} L${lastX.toFixed(2)} 32 L${line[0][0].toFixed(2)} 32 Z`} />
        <path className="kspark-line" d={path} vectorEffect="non-scaling-stroke" />
        {points.map((p, i) => (
          <rect key={i} className="kspark-hit" x={Math.max(0, x(i) - step / 2)} y={0} width={step} height={32}><title>{p.label}</title></rect>
        ))}
      </svg>
      <i className="kspark-end" style={{ left: `${lastX}%`, top: `${(100 * lastY) / 32}%` }} />
    </span>
  );
}

/** One headline number: the icon and colour say what it is, a tint says it needs you. */
export function Kpi({ href, label, icon: Icon, accent, alert, value, delta, foot, children }: {
  href: string; label: string; icon: LucideIcon; accent: Accent; alert?: boolean; value: ReactNode; delta?: ReactNode; foot?: ReactNode; children?: ReactNode;
}) {
  return (
    <Link href={href} className={`kpi acc-${accent}${alert ? " is-alert" : ""}`}>
      <span className="kpi-label"><span className="kpi-icon"><Icon size={13} strokeWidth={1.75} aria-hidden="true" /></span>{label}</span>
      <span className="kpi-value-row"><span className="kpi-value">{value}</span>{delta}</span>
      {children}
      <span className="kpi-foot">{foot}</span>
    </Link>
  );
}
