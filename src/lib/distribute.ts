// Splitting a daily total across inboxes for sending plans. Every inbox gets
// a whole number between lo and hi, and the numbers add up to the total
// (clamped to what the inboxes can carry), so the fleet sends the same amount
// while each inbox looks different from day to day.

export type Rng = () => number;

/** Small seeded generator so a plan's split can be reproduced in tests. */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(lo: number, hi: number, rng: Rng = Math.random) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function distribute(n: number, total: number, lo: number, hi: number, rng: Rng = Math.random): { values: number[]; total: number; clamped: boolean } {
  if (n <= 0) return { values: [], total: 0, clamped: total !== 0 };
  const target = Math.max(n * lo, Math.min(n * hi, Math.round(total)));
  const values = Array.from({ length: n }, () => lo);
  let left = target - n * lo;
  // Hand out the remainder in random-sized pieces to random inboxes with room,
  // which spreads it unevenly without ever breaking the bounds.
  while (left > 0) {
    const open = values.map((v, i) => (v < hi ? i : -1)).filter((i) => i >= 0);
    const i = open[Math.floor(rng() * open.length)];
    const room = hi - values[i];
    const piece = Math.max(1, Math.min(room, left, Math.ceil(rng() * Math.max(1, Math.ceil(left / open.length) * 2))));
    values[i] += piece;
    left -= piece;
  }
  return { values, total: target, clamped: target !== Math.round(total) };
}
