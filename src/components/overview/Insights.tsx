import Link from "next/link";
import { Gauge, MailX, MessageSquareHeart, PauseCircle, TrendingDown, TrendingUp, type LucideIcon } from "lucide-react";
import { int } from "@/lib/format";
import type { ClientInsight, TrendDay } from "@/lib/queries";
import type { Tone } from "@/lib/status";

// Below this many sends a client's rates are noise.
const MIN_SENT = 500;
const rate = (n: number, d: number) => (d > 0 ? (100 * n) / d : 0);

type Line = { key: string; tone: Tone; icon: LucideIcon; text: string; href: string };

/** What the numbers add up to this week, worst first; a line only shows when it says something. */
export function readInsights(trend: TrendDay[], clients: ClientInsight[], capacity: number): Line[] {
  const out: Line[] = [];
  const recent = trend.slice(-7), before = trend.slice(0, -7);
  const sent = recent.reduce((a, d) => a + d.sent, 0), sentBefore = before.reduce((a, d) => a + d.sent, 0);
  const named = clients.filter((c) => c.sent >= MIN_SENT);

  const silent = clients.filter((c) => c.active > 0 && c.sent === 0);
  if (silent.length) {
    const names = silent.slice(0, 2).map((c) => c.name).join(" and ");
    out.push({ key: "silent", tone: "danger", icon: PauseCircle, text: `${names}${silent.length > 2 ? ` and ${silent.length - 2} more` : ""} sent nothing in 7 days despite active domains`, href: "/stats" });
  }
  const bounce = [...named].sort((a, b) => rate(b.bounces, b.sent) - rate(a.bounces, a.sent))[0];
  if (bounce && rate(bounce.bounces, bounce.sent) >= 2) {
    const r = rate(bounce.bounces, bounce.sent);
    out.push({ key: "bounce", tone: r >= 3 ? "danger" : "warning", icon: MailX, text: `${bounce.name} has the highest bounce rate, ${r.toFixed(1)}%`, href: `/stats?client=${bounce.id}` });
  }
  const drop = named.filter((c) => c.sentPrev >= MIN_SENT).map((c) => ({ c, d: (100 * (c.sent - c.sentPrev)) / c.sentPrev })).sort((a, b) => a.d - b.d)[0];
  if (drop && drop.d <= -30) out.push({ key: "drop", tone: "warning", icon: TrendingDown, text: `${drop.c.name} is sending ${Math.abs(drop.d).toFixed(0)}% less than the week before`, href: `/stats?client=${drop.c.id}` });
  if (sentBefore > 0 && Math.abs(sent - sentBefore) >= sentBefore * 0.05) {
    const d = (100 * (sent - sentBefore)) / sentBefore;
    out.push({ key: "volume", tone: d <= -20 ? "warning" : "info", icon: d > 0 ? TrendingUp : TrendingDown, text: `Overall sending is ${d > 0 ? "up" : "down"} ${Math.abs(d).toFixed(0)}% on the week before`, href: "/stats" });
  }
  if (capacity > 0 && sent > 0) {
    const avg = sent / 7;
    out.push({ key: "capacity", tone: "info", icon: Gauge, text: `Averaging ${int(Math.round(avg))} a day, ${rate(avg, capacity).toFixed(0)}% of today's ${int(capacity)} capacity`, href: "/inboxes" });
  }
  const best = [...named].sort((a, b) => rate(b.human, b.sent) - rate(a.human, a.sent))[0];
  if (best && best.human > 0) out.push({ key: "best", tone: "success", icon: MessageSquareHeart, text: `${best.name} leads human replies at ${rate(best.human, best.sent).toFixed(2)}%`, href: `/stats?client=${best.id}` });
  return out;
}

export function Insights({ lines }: { lines: Line[] }) {
  if (!lines.length) return <p className="card-body zero">Not enough sending yet to say anything.</p>;
  return (
    <div className="list">
      {lines.map(({ key, tone, icon: Icon, text, href }) => (
        <Link key={key} href={href} className={`insight acc-${tone}`}>
          <span className="kpi-icon"><Icon size={13} strokeWidth={1.75} aria-hidden="true" /></span>
          <span>{text}</span>
        </Link>
      ))}
    </div>
  );
}
