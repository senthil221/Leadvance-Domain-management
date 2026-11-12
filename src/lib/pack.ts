// Rows that repeat their group's fields (every inbox carries its domain's
// status, order, DNS and warm-up) go to the browser with each group's fields
// once, and are put back together there. A domain with 100 inboxes otherwise
// sends its 30 fields 100 times.

export type Packed<R, G extends keyof R, K extends keyof R> = {
  /** The field that names the group; it stays on every row. */
  by: G;
  groups: Record<string, Pick<R, K>>;
  rows: Omit<R, K>[];
};

/** Every row of a group must have the same values in `keys`: the first row's are kept. */
export function packRows<R, G extends keyof R, K extends Exclude<keyof R, G>>(rows: R[], by: G, keys: readonly K[]): Packed<R, G, K> {
  const groups: Record<string, Pick<R, K>> = {};
  const out = rows.map((r) => {
    const g = String(r[by]);
    const rest = { ...r };
    const shared = {} as Pick<R, K>;
    for (const k of keys) {
      shared[k] = r[k];
      delete rest[k];
    }
    groups[g] ??= shared;
    return rest as Omit<R, K>;
  });
  return { by, groups, rows: out };
}

export function unpackRows<R, G extends keyof R, K extends keyof R>(p: Packed<R, G, K>): R[] {
  return p.rows.map((r) => ({ ...r, ...p.groups[String((r as R)[p.by])] }) as R);
}
