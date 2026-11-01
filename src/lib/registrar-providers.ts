// The registrars an account can be added for, and the keys each one needs.
// Shared by the Settings form and the server, so it holds no secrets.

export type Provider = "porkbun" | "dynadot" | "spaceship" | "unstoppable";

export type KeyField = { key: string; label: string; prefix?: string; placeholder?: string };

export type ProviderInfo = {
  label: string;
  /** The vendors row domains point at. */
  vendor: string;
  fields: KeyField[];
  /** Where to get the keys, in one line. */
  where: string;
  /** Anything to switch on at the registrar first. */
  note?: string;
};

export const PROVIDERS: Record<Provider, ProviderInfo> = {
  unstoppable: {
    label: "Unstoppable Domains",
    vendor: "Unstoppable Domains",
    fields: [{ key: "apiKey", label: "API key", prefix: "ud_", placeholder: "ud_mcp_…" }],
    where: "Account Settings → Advanced → API key (the key starts with ud_)",
  },
  dynadot: {
    label: "Dynadot",
    vendor: "Dynadot",
    fields: [{ key: "apiKey", label: "API key" }],
    where: "Tools → API → API key",
    note: "If you turned on an IP allowlist at Dynadot, add this server's IP address to it.",
  },
  spaceship: {
    label: "Spaceship",
    vendor: "Spaceship",
    fields: [{ key: "apiKey", label: "API key" }, { key: "apiSecret", label: "API secret" }],
    where: "API Manager → New API key, with domains:read and domains:write",
  },
  porkbun: {
    label: "Porkbun",
    vendor: "Porkbun",
    fields: [{ key: "apiKey", label: "API key", prefix: "pk1_" }, { key: "secretKey", label: "Secret key", prefix: "sk1_" }],
    where: "porkbun.com/account/api → Create API key (Manage, but no purchases)",
    note: "Turn on API access for each domain at Porkbun so nameservers can be changed.",
  },
};

export const PROVIDER_ORDER: Provider[] = ["unstoppable", "dynadot", "spaceship", "porkbun"];

/** Registrars whose nameservers the app can change. */
export const API_REGISTRARS = new Set(PROVIDER_ORDER.map((p) => PROVIDERS[p].vendor));

export const isProvider = (v: unknown): v is Provider => typeof v === "string" && v in PROVIDERS;
