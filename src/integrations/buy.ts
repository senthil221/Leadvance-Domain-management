// What every registrar's buyer does: check the name is free and what it costs,
// then register it for one year paid from the account's balance, never more
// than the order allows.

export type BuyOutcome =
  | { status: "bought"; paidUsd: number | null; ref: string | null }
  /** The registrar took the order and finishes it later (Spaceship). */
  | { status: "registering"; quotedUsd: number | null; ref: string }
  /** Dry run: checked, and this is what it would have cost. */
  | { status: "dry_run"; quotedUsd: number | null };

export type FollowOutcome = { status: "bought" } | { status: "pending" } | { status: "failed"; message: string };

export type Buyer = {
  buy(domain: string, maxUsd: number): Promise<BuyOutcome>;
  /** For an order the registrar finishes later. */
  follow?(ref: string): Promise<FollowOutcome>;
  /** Spendable balance in US dollars; null when the registrar doesn't say. */
  balance(): Promise<number | null>;
};

/** Nothing was spent: the name is taken, premium, over budget or not sold there. */
export class SkipPurchase extends Error {
  constructor(message: string, public quotedUsd: number | null = null) {
    super(message);
  }
}

/**
 * The account can't buy anything until someone acts (balance too low, key
 * without purchase rights, a contact missing): the order pauses so the rest
 * don't fail one by one.
 */
export class AccountBlocked extends Error {}

export const usd = (n: number) => `$${n.toFixed(2)}`;

/** Refuses a price over the order's limit. */
export function withinBudget(domain: string, price: number | null, maxUsd: number) {
  if (price === null || !Number.isFinite(price)) throw new SkipPurchase(`Couldn't read the price of ${domain}, so it wasn't bought`);
  if (price > maxUsd + 1e-9) throw new SkipPurchase(`Costs ${usd(price)}, over your ${usd(maxUsd)} limit`, price);
  return price;
}
