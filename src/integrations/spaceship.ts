import type postgres from "postgres";
import { AccountBlocked, SkipPurchase, withinBudget } from "./buy";
import { ApiError, cleanNs, createHttp, isoDate, validDomain } from "./http";
import type { RegistrarClient, RegistrarDomain } from "./registrars";

// Spaceship API v1 (https://spaceship.dev/api/v1). Key and secret go in the
// X-API-Key / X-API-Secret headers. Domain lists carry nameservers, so the
// sync gets them for free. Nameserver writes are limited to 5 per domain
// per 5 minutes, which a replacement never comes near.

type Options = { apiKey: string; apiSecret: string; sql?: postgres.Sql; dryRun?: boolean; fetchImpl?: typeof fetch; minSpacingMs?: number };

export function parseSpaceshipDomain(raw: unknown): RegistrarDomain | null {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = validDomain(d.name);
  if (!name) return null;
  const ns = (d.nameservers && typeof d.nameservers === "object" ? d.nameservers : {}) as { hosts?: unknown };
  return {
    name,
    status: typeof d.lifecycleStatus === "string" ? d.lifecycleStatus : null,
    createdAt: isoDate(d.registrationDate),
    expiresAt: isoDate(d.expirationDate),
    autoRenew: typeof d.autoRenew === "boolean" ? d.autoRenew : null,
    apiAccess: null,
    nameservers: Array.isArray(ns.hosts) ? cleanNs(ns.hosts) : null,
  };
}

type SsPrice = { period?: { value?: number; unit?: string }; priceInDefaultCurrency?: { finalPrice?: { amount?: string; currency?: string } } };
type SsContacts = { registrant?: string; admin?: string; tech?: string; billing?: string };

/** The one-year registration price in dollars, from GET /domains/{domain}/pricing. */
export function spaceshipYearPrice(r: { priceClass?: string; prices?: { register?: SsPrice[] } } | null) {
  const year = r?.prices?.register?.find((p) => p.period?.value === 1 && (p.period.unit ?? "y") === "y");
  const fp = year?.priceInDefaultCurrency?.finalPrice;
  return { premium: r?.priceClass === "premium", price: fp?.amount && (fp.currency ?? "USD") === "USD" ? Number(fp.amount) : null };
}

export function createSpaceship({ apiKey, apiSecret, sql, dryRun = true, fetchImpl, minSpacingMs = 1100 }: Options): RegistrarClient {
  // 300 requests per 5 minutes per user: one a second stays well inside it.
  const http = createHttp({ service: "spaceship", baseUrl: "https://spaceship.dev/api/v1", sql, dryRun, fetchImpl, minSpacingMs });
  const headers = { "X-API-Key": apiKey, "X-API-Secret": apiSecret };
  let contacts: SsContacts | null = null;

  return {
    provider: "spaceship",
    dryRun,
    async listAll() {
      const out: RegistrarDomain[] = [];
      for (let skip = 0; skip < 100_000; skip += 100) {
        const r = await http.request<{ items?: unknown[]; total?: number }>({ path: `/domains?take=100&skip=${skip}&orderBy=name`, headers });
        const page = Array.isArray(r?.items) ? r.items : [];
        for (const raw of page) {
          const d = parseSpaceshipDomain(raw);
          if (d) out.push(d);
        }
        if (page.length < 100 || (typeof r?.total === "number" && skip + 100 >= r.total)) break;
      }
      return out;
    },
    async getNs(domain) {
      const r = await http.request<{ nameservers?: { hosts?: unknown[] } }>({ path: `/domains/${encodeURIComponent(domain)}`, headers });
      return cleanNs(r?.nameservers?.hosts ?? []);
    },
    async updateNs(domain, ns) {
      await http.request({ method: "PUT", path: `/domains/${encodeURIComponent(domain)}/nameservers`, headers, body: { provider: "custom", hosts: ns }, write: true });
      return { pending: false };
    },
    buyer: {
      async buy(domain, maxUsd) {
        const avail = await http.request<{ result?: string }>({ path: `/domains/${encodeURIComponent(domain)}/available`, headers });
        if (avail?.result !== "available") throw new SkipPurchase(avail?.result === "tldNotSupported" ? "Spaceship doesn't sell this ending" : "Taken");
        const p = spaceshipYearPrice(await http.request({ path: `/domains/${encodeURIComponent(domain)}/pricing`, headers }));
        if (p.premium) throw new SkipPurchase("Premium name", p.price);
        const price = withinBudget(domain, p.price, maxUsd);
        const who = await contactsOf();
        if (dryRun) return { status: "dry_run", quotedUsd: price };
        let ref: string | null = null;
        try {
          await http.request({
            method: "POST", path: `/domains/${encodeURIComponent(domain)}`, headers, write: true,
            body: { autoRenew: false, years: 1, privacyProtection: { level: "high", userConsent: true }, contacts: who },
            onHeaders: (h) => { ref = h.get("spaceship-async-operationid"); },
          });
        } catch (e) {
          if (e instanceof ApiError && e.status === 403) throw new AccountBlocked("This Spaceship key can't buy: give it the domains:billing and asyncoperations:read scopes in API Manager, then resume");
          if (e instanceof ApiError && /fund|balance|payment/i.test(e.message)) throw new AccountBlocked(`Spaceship couldn't charge the account: ${e.message}`);
          throw e;
        }
        if (!ref) return { status: "bought", paidUsd: price, ref: null };
        return { status: "registering", quotedUsd: price, ref };
      },
      async follow(ref) {
        const r = await http.request<{ status?: string; details?: unknown }>({ path: `/async-operations/${encodeURIComponent(ref)}`, headers });
        if (r?.status === "success") return { status: "bought" };
        if (r?.status === "failed") return { status: "failed", message: `Spaceship couldn't finish the registration${r.details ? `: ${JSON.stringify(r.details).slice(0, 300)}` : ""}` };
        return { status: "pending" };
      },
      // Spaceship's API doesn't show the balance.
      balance: async () => null,
    },
  };

  // The contacts of a domain the account already owns: Spaceship has no
  // default contact in its API, and every registration needs a registrant.
  async function contactsOf(): Promise<SsContacts> {
    if (contacts) return contacts;
    const list = await http.request<{ items?: { name?: string }[] }>({ path: "/domains?take=1&skip=0&orderBy=-registrationDate", headers });
    const name = list?.items?.[0]?.name;
    if (!name) throw new AccountBlocked("Spaceship needs a contact for new domains and this account has no domain to copy one from: buy one by hand first");
    const d = await http.request<{ contacts?: SsContacts }>({ path: `/domains/${encodeURIComponent(name)}`, headers });
    if (!d?.contacts?.registrant) throw new AccountBlocked(`Couldn't read the contacts of ${name} at Spaceship to reuse them`);
    const { registrant, admin, tech, billing } = d.contacts;
    contacts = Object.fromEntries(Object.entries({ registrant, admin, tech, billing }).filter(([, v]) => v)) as SsContacts;
    return contacts;
  }
}
