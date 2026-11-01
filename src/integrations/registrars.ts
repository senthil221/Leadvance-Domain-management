import type postgres from "postgres";
import { open } from "../lib/secret-box";
import { API_REGISTRARS, PROVIDERS, isProvider, type Provider } from "../lib/registrar-providers";
import { createDynadot } from "./dynadot";
import { createPorkbun, sameNameservers, type Porkbun } from "./porkbun";
import { createSpaceship } from "./spaceship";
import { createUnstoppable } from "./unstoppable";

// Every registrar account the app can reach: the ones added in Settings
// (keys encrypted in registrar_accounts) plus Porkbun from the server's .env.
// Each domain remembers its account; nameserver changes go through it.

export type RegistrarDomain = {
  name: string;
  status: string | null;
  createdAt: Date | null;
  expiresAt: Date | null;
  autoRenew: boolean | null;
  /** Porkbun's per-domain API switch; null elsewhere. */
  apiAccess: boolean | null;
  /** When the list already carries them (Spaceship). */
  nameservers: string[] | null;
};

export type RegistrarClient = {
  provider: Provider;
  dryRun: boolean;
  listAll(): Promise<RegistrarDomain[]>;
  getNs(domain: string): Promise<string[]>;
  /** pending: the registrar queued the change, so a read-back may lag. */
  updateNs(domain: string, ns: string[]): Promise<{ pending: boolean }>;
};

export type RegistrarAccount = { id: string | null; provider: Provider; vendor: string; label: string; client: RegistrarClient };

export function porkbunClient(pb: Porkbun): RegistrarClient {
  return {
    provider: "porkbun",
    dryRun: pb.dryRun,
    listAll: async () => (await pb.listAll()).map((d) => ({ ...d, nameservers: null })),
    getNs: (d) => pb.getNs(d),
    updateNs: async (d, ns) => { await pb.updateNs(d, ns); return { pending: false }; },
  };
}

export const envPorkbunAccount = (pb: Porkbun): RegistrarAccount =>
  ({ id: null, provider: "porkbun", vendor: "Porkbun", label: "Server .env", client: porkbunClient(pb) });

type ClientOptions = { sql?: postgres.Sql; dryRun: boolean; fetchImpl?: typeof fetch };

export function createRegistrarClient(provider: Provider, keys: Record<string, string>, opts: ClientOptions): RegistrarClient {
  const { sql, dryRun, fetchImpl } = opts;
  switch (provider) {
    case "porkbun": return porkbunClient(createPorkbun({ apiKey: keys.apiKey, secretKey: keys.secretKey, sql, dryRun, fetchImpl }));
    case "dynadot": return createDynadot({ apiKey: keys.apiKey, sql, dryRun, fetchImpl });
    case "spaceship": return createSpaceship({ apiKey: keys.apiKey, apiSecret: keys.apiSecret, sql, dryRun, fetchImpl });
    case "unstoppable": return createUnstoppable({ apiKey: keys.apiKey, sql, dryRun, fetchImpl });
  }
}

/** All accounts; one whose keys can't be decrypted is left out and reported. */
export async function loadRegistrars(sql: postgres.Sql, opts: { dryRun: boolean; porkbun: Porkbun | null }) {
  const accounts: RegistrarAccount[] = opts.porkbun ? [envPorkbunAccount(opts.porkbun)] : [];
  const broken: { id: string; error: string }[] = [];
  const rows = await sql`select id, provider, label, credentials from registrar_accounts order by provider, created_at`.catch(() => []);
  for (const r of rows) {
    if (!isProvider(r.provider)) continue;
    try {
      const client = createRegistrarClient(r.provider, open(r.credentials as string), { sql, dryRun: opts.dryRun });
      accounts.push({ id: r.id as string, provider: r.provider, vendor: PROVIDERS[r.provider].vendor, label: r.label as string, client });
    } catch (e) {
      broken.push({ id: r.id as string, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { accounts, broken };
}

export type RegistrarScope = { porkbun?: Porkbun | null; registrars?: RegistrarAccount[] };

/**
 * The account that can change this domain's nameservers, or why none can.
 * A domain synced from an account uses it; otherwise the registrar's only
 * account (or the .env Porkbun) is assumed.
 */
export function registrarFor(scope: RegistrarScope, vendor: string | null, accountId: string | null): { account: RegistrarAccount; why?: undefined } | { account?: undefined; why: string } {
  const all = scope.registrars ?? (scope.porkbun ? [envPorkbunAccount(scope.porkbun)] : []);
  if (!vendor) return { why: "the registrar isn't known" };
  if (accountId) {
    const own = all.find((a) => a.id === accountId);
    if (own) return { account: own };
  }
  const same = all.filter((a) => a.vendor === vendor);
  if (same.length === 1) return { account: same[0] };
  const env = same.find((a) => a.id === null);
  if (env) return { account: env };
  if (!API_REGISTRARS.has(vendor)) return { why: `the app can't change nameservers at ${vendor}` };
  if (!same.length) return { why: `${vendor} isn't connected: add it in Settings → Connections` };
  return { why: `${vendor} has ${same.length} accounts and this domain hasn't been matched to one yet: run Registrar domains in Settings → Background sync` };
}

export type NsOutcome =
  | { outcome: "dry_run" }
  | { outcome: "done"; now: string[] }
  | { outcome: "pending"; now: string[] }
  | { outcome: "mismatch"; now: string[] };

/** Sets the nameservers and reads them back. */
export async function applyNameservers(account: RegistrarAccount, domain: string, ns: string[]): Promise<NsOutcome> {
  const { pending } = await account.client.updateNs(domain, ns);
  if (account.client.dryRun) return { outcome: "dry_run" };
  const now = await account.client.getNs(domain).catch(() => [] as string[]);
  if (sameNameservers(now, ns)) return { outcome: "done", now };
  return { outcome: pending ? "pending" : "mismatch", now };
}

/** "Unstoppable Domains" or "Unstoppable Domains (Account 2)" when there are several. */
export function accountName(scope: RegistrarScope, account: RegistrarAccount) {
  const all = scope.registrars ?? [];
  return all.filter((a) => a.vendor === account.vendor).length > 1 ? `${account.vendor} (${account.label})` : account.vendor;
}
