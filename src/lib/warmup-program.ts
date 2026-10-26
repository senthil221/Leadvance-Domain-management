/** Settings → Warming up: how new domains are warmed once they connect to Smartlead. */
export type WarmupProgram = {
  enabled: boolean;
  /** How many days a domain stays in the Warming up view. */
  days: number;
  /** Only domains this young (days since their first inbox joined Smartlead) are enrolled. */
  maxAgeDays: number;
  perDay: number;
  rampup: number;
  replyRate: number;
};

export const WARMUP_DEFAULTS: WarmupProgram = { enabled: false, days: 12, maxAgeDays: 1, perDay: 20, rampup: 2, replyRate: 40 };

const num = (v: unknown, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

export function parseWarmupProgram(v: unknown): WarmupProgram {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    days: num(o.days, WARMUP_DEFAULTS.days, 1, 60),
    maxAgeDays: num(o.maxAgeDays, WARMUP_DEFAULTS.maxAgeDays, 0, 30),
    perDay: num(o.perDay, WARMUP_DEFAULTS.perDay, 1, 1000),
    rampup: num(o.rampup, WARMUP_DEFAULTS.rampup, 0, 1000),
    replyRate: num(o.replyRate, WARMUP_DEFAULTS.replyRate, 0, 100),
  };
}

/** Where a domain is in its warm-up: day 1 is the day it was enrolled. */
export function warmupProgress(startedAt: Date | string | null, days: number | null, now = Date.now()) {
  if (!startedAt || !days) return null;
  const elapsed = Math.floor((now - new Date(startedAt).getTime()) / 86_400_000);
  const day = Math.max(1, Math.min(days, elapsed + 1));
  return { day, days, ready: elapsed + 1 > days, left: Math.max(0, days - elapsed - 1), pct: Math.min(100, Math.round((100 * Math.max(0, elapsed + 1)) / days)) };
}
