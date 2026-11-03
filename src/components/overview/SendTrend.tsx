import { int } from "@/lib/format";
import type { TrendDay } from "@/lib/queries";

const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n));

/** Sent per day: the last 7 days against the 7 before, with the day's numbers on hover. */
export function SendTrend({ days }: { days: TrendDay[] }) {
  const max = Math.max(1, ...days.map((d) => d.sent));
  const peak = days.reduce((a, d, i) => (d.sent > days[a].sent ? i : a), 0);
  return (
    <div className="st" role="img" aria-label="Emails sent per day over the last 14 days">
      <span className="st-top">{compact(max)}</span>
      <div className="st-plot" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
        {days.map((d, i) => {
          const day = new Date(`${d.day}T00:00:00Z`);
          const edge = i < 3 ? " is-start" : i >= days.length - 3 ? " is-end" : "";
          return (
            <div key={d.day} className={`st-col${i >= days.length - 7 ? " is-recent" : ""}`} tabIndex={0}>
              <div className="st-track">
                {i === peak && d.sent > 0 ? <span className="st-peak" style={{ bottom: `${(100 * d.sent) / max}%` }}>{compact(d.sent)}</span> : null}
                <span className="st-bar" style={{ height: `${Math.max(d.sent ? 3 : 0, (100 * d.sent) / max)}%` }} />
              </div>
              <span className="st-day">{day.getUTCDate()}</span>
              <div className={`st-tip${edge}`} role="tooltip">
                <b>{day.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}</b>
                <span><i>Sent</i>{int(d.sent)}</span>
                <span><i>Replies</i>{int(d.replies)}{d.sent ? ` · ${((100 * d.replies) / d.sent).toFixed(2)}%` : ""}</span>
                <span><i>Human</i>{int(d.human)}</span>
                <span><i>Bounces</i>{int(d.bounces)}{d.sent ? ` · ${((100 * d.bounces) / d.sent).toFixed(1)}%` : ""}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
