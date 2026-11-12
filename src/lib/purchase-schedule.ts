// Spreads a list of domains to buy over a few days, inside working hours, so
// they go out one at a time at uneven gaps the way a person buys them, and
// rotates them across the chosen registrar accounts.

export type ScheduleInput = {
  domains: string[];
  /** Registrar account ids, in the order picked. */
  accounts: string[];
  start: Date;
  /** How many days to spread the buying over (1 to 7). */
  days: number;
  /** Working hours in the timezone, e.g. 9 to 21: buys only happen then. */
  fromHour: number;
  toHour: number;
  timezone: string;
  /** No two buys closer than this, across all accounts. */
  minGapMinutes: number;
  /** Seeded so a preview and the saved order can match in tests. */
  random?: () => number;
};

export type Planned = { domain: string; accountId: string; at: Date };

const hourIn = (tz: string) => {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "numeric", hourCycle: "h23" });
  return (d: Date) => Number(f.format(d));
};

/** The minutes from start, over the window, that fall in working hours. */
export function workingMinutes(start: Date, days: number, fromHour: number, toHour: number, timezone: string): Date[] {
  const hour = hourIn(timezone);
  const first = new Date(Math.ceil(start.getTime() / 60_000) * 60_000);
  const out: Date[] = [];
  const inHours = (h: number) => (fromHour < toHour ? h >= fromHour && h < toHour : h >= fromHour || h < toHour);
  // Check hour by hour, then add its minutes: one Intl call an hour.
  for (let t = first.getTime(), end = first.getTime() + days * 86_400_000; t < end; ) {
    const d = new Date(t);
    const nextHour = Math.min(end, (Math.floor(t / 3_600_000) + 1) * 3_600_000);
    if (inHours(hour(d))) for (let m = t; m < nextHour; m += 60_000) out.push(new Date(m));
    t = nextHour;
  }
  return out;
}

/** The most domains that fit, keeping the minimum gap. */
export const capacity = (minutes: number, minGap: number) => Math.max(0, Math.floor(minutes / Math.max(1, minGap)));

/**
 * One time per domain: the working minutes are cut into equal slots and each
 * domain lands somewhere in the middle of its slot, so the gaps vary but never
 * shrink below the minimum. Accounts take turns, starting from a random one,
 * so each account's buys are spaced further still.
 */
export function planPurchases(input: ScheduleInput): { planned: Planned[] } | { error: string } {
  const rnd = input.random ?? Math.random;
  const domains = [...new Set(input.domains)];
  if (!domains.length) return { error: "No domains to buy" };
  if (!input.accounts.length) return { error: "Pick at least one registrar account" };
  const minutes = workingMinutes(input.start, input.days, input.fromHour, input.toHour, input.timezone);
  if (!minutes.length) return { error: "The working hours leave no time in this window" };
  const slot = minutes.length / domains.length;
  if (slot < input.minGapMinutes) {
    const fit = capacity(minutes.length, input.minGapMinutes);
    return { error: `${domains.length} domains don't fit ${input.days} day${input.days === 1 ? "" : "s"} with at least ${input.minGapMinutes} minutes between buys: ${fit} would. Spread them over more days, widen the hours or lower the gap` };
  }
  // Shuffle the order too, so the names don't go out alphabetically.
  const order = domains.map((d) => ({ d, k: rnd() })).sort((a, b) => a.k - b.k).map((x) => x.d);
  const offset = Math.floor(rnd() * input.accounts.length);
  // Inside a slot, keep away from both edges by half the minimum gap.
  const edge = Math.min(slot / 2, input.minGapMinutes / 2);
  const planned = order.map((domain, i) => {
    const lo = i * slot + edge, hi = (i + 1) * slot - edge;
    const idx = Math.min(minutes.length - 1, Math.floor(lo + rnd() * Math.max(0, hi - lo)));
    // A random second inside the minute, so nothing lands on :00.
    const at = new Date(minutes[idx].getTime() + Math.floor(rnd() * 60) * 1000);
    return { domain, accountId: input.accounts[(i + offset) % input.accounts.length], at };
  });
  return { planned };
}
