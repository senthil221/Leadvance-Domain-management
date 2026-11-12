import type postgres from "postgres";
import { AccountBlocked, SkipPurchase, usd, withinBudget } from "./buy";
import { cleanNs, createHttp, isoDate, validDomain } from "./http";
import type { RegistrarClient, RegistrarDomain } from "./registrars";

// Unstoppable Domains User API (https://api.unstoppabledomains.com/mcp/v1):
// every call is a POST to /actions/<name> with a Bearer key. The portfolio
// lists the account's DNS (ICANN) domains; nameserver changes are queued
// and finish within minutes, so a read-back right after can still show the
// old pair.

type Options = { apiKey: string; sql?: postgres.Sql; dryRun?: boolean; fetchImpl?: typeof fetch; minSpacingMs?: number };

export function parseUnstoppableDomain(raw: unknown): RegistrarDomain | null {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = validDomain(d.name);
  if (!name) return null;
  const renewal = (d.autoRenewal && typeof d.autoRenewal === "object" ? d.autoRenewal : null) as { status?: unknown } | null;
  return {
    name,
    status: d.transferStatus === "pending" ? "transfer pending" : null,
    createdAt: isoDate(d.purchasedAt),
    expiresAt: isoDate(d.expiresAt),
    autoRenew: renewal ? renewal.status === "active" : null,
    apiAccess: null,
    nameservers: null,
  };
}

type UdSearchHit = { name?: string; marketplace?: { status?: string }; pricing?: { amount?: number } };
type UdQuote = { quoteToken: string; quotedItemCount: number; expectedTotalCharged: number; items?: { domain?: string; lineTotalCents?: number }[] };

export function createUnstoppable({ apiKey, sql, dryRun = true, fetchImpl, minSpacingMs = 400 }: Options): RegistrarClient {
  const http = createHttp({ service: "unstoppable", baseUrl: "https://api.unstoppabledomains.com/mcp/v1/actions", sql, dryRun, fetchImpl, minSpacingMs });
  const headers = { Authorization: `Bearer ${apiKey.replace(/^bearer\s+/i, "")}` };
  let contactId: string | null = null;
  const action = <T>(name: string, body: Record<string, unknown>, write = false) => http.request<T>({ method: "POST", path: `/${name}`, headers, body, write });

  return {
    provider: "unstoppable",
    dryRun,
    async listAll() {
      // The live API pages by offset/limit and rejects any other field. A
      // large page can come back truncated, so the next offset follows what
      // actually arrived.
      const out: RegistrarDomain[] = [];
      for (let offset = 0, guard = 0; guard < 1000; guard++) {
        const r = await action<{ domains?: unknown[]; pagination?: { hasMore?: boolean; nextOffset?: number | null } }>(
          "ud_portfolio_list", { offset, limit: 200, registryType: "dns", orderBy: "name", orderDirection: "asc" });
        const list = Array.isArray(r?.domains) ? r.domains : [];
        for (const raw of list) {
          const d = parseUnstoppableDomain(raw);
          if (d) out.push(d);
        }
        if (!r?.pagination?.hasMore || !list.length) break;
        const next = r.pagination.nextOffset;
        offset = typeof next === "number" && next > offset ? Math.min(next, offset + list.length) : offset + list.length;
      }
      return out;
    },
    async getNs(domain) {
      const r = await action<{ nameservers?: unknown[] }>("ud_dns_nameservers_list", { domain });
      return cleanNs(r?.nameservers ?? []);
    },
    async updateNs(domain, ns) {
      const r = await action<{ results?: { domain?: string; success?: boolean; error?: string }[] }>(
        "ud_dns_nameservers_set_custom", { domains: [{ name: domain, nameservers: ns }] }, true);
      if (r === null) return { pending: false }; // dry run
      const res = r.results?.find((x) => x.domain?.toLowerCase() === domain) ?? r.results?.[0];
      if (!res?.success) throw new Error(`Unstoppable refused the nameservers for ${domain}: ${res?.error ?? "no result"}`);
      return { pending: true };
    },
    buyer: {
      // Search, put the one name in the cart, get a quote paid from the
      // account balance, and check out only if nothing would go on a card.
      async buy(domain, maxUsd) {
        const s = await action<{ results?: UdSearchHit[] }>("ud_domains_search", { query: domain, limit: 5 });
        const hit = s?.results?.find((r) => r.name?.toLowerCase() === domain);
        if (!hit || hit.marketplace?.status !== "available") throw new SkipPurchase(hit?.marketplace?.status?.includes("sale") ? "Taken (listed for resale)" : "Taken");
        const price = withinBudget(domain, typeof hit.pricing?.amount === "number" ? hit.pricing.amount / 100 : null, maxUsd);
        const contactId = await contact();
        if (dryRun) return { status: "dry_run", quotedUsd: price };

        // Never check out anything else someone left in the cart.
        const cart = await action<{ items?: { productId?: number; domain?: string | null }[] }>("ud_cart_get", {});
        const others = (cart?.items ?? []).filter((i) => i.domain?.toLowerCase() !== domain);
        if (others.length) throw new AccountBlocked(`The Unstoppable cart has ${others.length} other item${others.length === 1 ? "" : "s"} in it: empty it at unstoppabledomains.com, then resume`);
        if (!(cart?.items ?? []).length) {
          const add = await action<{ addedProducts?: { domain?: string; success?: boolean; error?: string; productId?: number }[] }>(
            "ud_cart_add_domain_registration", { domains: [{ name: domain, quantity: 1 }] }, true);
          const added = add?.addedProducts?.find((p) => p.domain?.toLowerCase() === domain) ?? add?.addedProducts?.[0];
          if (!added?.success) throw new SkipPurchase(`Unstoppable wouldn't add it to the cart: ${added?.error ?? "no reason given"}`);
        }
        const emptyCart = async () => {
          const c = await action<{ items?: { productId?: number }[] }>("ud_cart_get", {}).catch(() => null);
          const ids = (c?.items ?? []).map((i) => i.productId).filter((x): x is number => typeof x === "number");
          if (ids.length) await action("ud_cart_remove", { productIds: ids }, true).catch(() => null);
        };

        let q: UdQuote | null;
        try {
          q = await action<UdQuote>("ud_cart_quote", { useAccountBalance: true, contactId }, true);
        } catch (e) {
          await emptyCart();
          const msg = e instanceof Error ? e.message : String(e);
          if (/payment|card|balance|insufficient/i.test(msg)) throw new AccountBlocked(`Unstoppable balance is too low for ${domain} (${usd(price)}): add credit, then resume`);
          throw e;
        }
        const line = q?.items?.find((i) => i.domain?.toLowerCase() === domain);
        const lineUsd = typeof line?.lineTotalCents === "number" ? line.lineTotalCents / 100 : price;
        if (!q || q.quotedItemCount !== 1 || !line) { await emptyCart(); throw new Error(`Unstoppable quoted ${q?.quotedItemCount ?? 0} items instead of just ${domain}; nothing was bought`); }
        if (lineUsd > maxUsd + 1e-9) { await emptyCart(); throw new SkipPurchase(`Costs ${usd(lineUsd)} at checkout, over your ${usd(maxUsd)} limit`, lineUsd); }
        // Anything above zero would be charged to a card: the balance doesn't cover it.
        if (q.expectedTotalCharged !== 0) { await emptyCart(); throw new AccountBlocked(`Unstoppable balance doesn't cover ${domain}: ${usd(q.expectedTotalCharged / 100)} would go on a card. Add credit, then resume`); }

        const done = await action<{ success?: boolean; orderId?: number }>("ud_cart_checkout",
          { quoteToken: q.quoteToken, expectedTotalCharged: q.expectedTotalCharged, currency: "USD", quotedItemCount: q.quotedItemCount }, true);
        if (!done?.success) throw new Error("Unstoppable didn't confirm the checkout");
        return { status: "bought", paidUsd: lineUsd, ref: done.orderId ? String(done.orderId) : null };
      },
      async balance() {
        const r = await action<{ accountBalance?: { amount?: number }; promoCredits?: { amount?: number } }>("ud_cart_get_payment_methods", {});
        if (!r) return null;
        return ((r.accountBalance?.amount ?? 0) + (r.promoCredits?.amount ?? 0)) / 100;
      },
    },
  };

  // The account's ICANN contact, needed for .com and the like.
  async function contact() {
    if (contactId) return contactId;
    const r = await action<{ contacts?: { id?: string; status?: string }[] }>("ud_contacts_list", { includeDisabled: false });
    const c = r?.contacts?.find((x) => x.status === "active" && x.id);
    if (!c?.id) throw new AccountBlocked("Unstoppable needs an active contact to register .com and similar names: add one in the account, then resume");
    contactId = c.id;
    return contactId;
  }
}
