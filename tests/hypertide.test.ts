import { describe, expect, it, vi } from "vitest";
import { buildOrderPayload, createHypertide, hypertideAcceptsDomain, readNameservers } from "../src/integrations/hypertide";

const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const creds = { api_key: "sl_x", username: "ops@b2bdrive.net", password: "pw", oauth_link: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x" };
const template = { plan: "entra" as const, inbox_quantity: 50 as const, forwarding_domain: "leadvance.io", client_name: "" };

describe("hypertideAcceptsDomain", () => {
  it("follows Hypertide's own-domain rules", () => {
    expect(hypertideAcceptsDomain("farnholt.com")).toBe(true);
    expect(hypertideAcceptsDomain("farn-holt.com")).toBe(false);
    expect(hypertideAcceptsDomain("averyveryveryveryverylongdomainnamex.com")).toBe(false);
  });
});

describe("buildOrderPayload", () => {
  it("builds an entra order from the template, old senders and warmup", () => {
    const r = buildOrderPayload({
      template, domain: "kelmorepoint.com", clientName: "Kapable",
      senders: ["Amelia Wren", "Amelia Wren", "Sophia Lark"],
      warmup: { perDay: 30, rampup: 3, dailyLimit: 15 }, credentials: creds,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload).toMatchObject({
      plan: "entra",
      domain_option: "i_have_my_own_domains",
      domains: ["kelmorepoint.com"],
      forwarding_domain: "leadvance.io",
      client_name: "Kapable",
      selected_tool: "smartlead",
      inbox_quantity: 50,
      users: [{ first_name: "Amelia", last_name: "Wren" }, { first_name: "Sophia", last_name: "Lark" }],
      warmup_setup: { disabled: false, settings: { max_warmup_emails_per_day: 30, ramp_up_value: 3 } },
      sending_settings: { max_email_per_day: 15 },
    });
    expect((r.payload.tool_credentials as Record<string, string>).oauth_link).toMatch(/^https:\/\/login\.microsoftonline\.com/);
  });

  it("uses one user and no OAuth link for the google plan", () => {
    const r = buildOrderPayload({
      template: { ...template, plan: "google" }, domain: "rowanquay.com", clientName: "Leadvance",
      senders: ["Amelia Wren", "Sophia Lark"], warmup: { perDay: null, rampup: null, dailyLimit: null },
      credentials: { api_key: "a", username: "b@c.com", password: "p" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.users).toEqual([{ first_name: "Amelia", last_name: "Wren" }]);
    expect(r.payload).not.toHaveProperty("inbox_quantity");
    expect(r.payload.tool_credentials).not.toHaveProperty("oauth_link");
    expect(r.payload).not.toHaveProperty("warmup_setup");
  });

  it("lists everything missing instead of sending a bad order", () => {
    const r = buildOrderPayload({
      template: { ...template, forwarding_domain: "" }, domain: "bad-name.com", clientName: null,
      senders: [], warmup: { perDay: null, rampup: null, dailyLimit: null }, credentials: { api_key: "x" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.join(" | ")).toMatch(/hyphens.*forwarding domain.*client.*Smartlead login.*OAuth.*sender names/);
  });
});

describe("createHypertide", () => {
  it("sends the key header and reads reserved nameserver pairs", async () => {
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)["x-api-key"]).toBe("ht_key");
      expect((init.headers as Record<string, string>)["x-dry-run"]).toBeUndefined();
      return res({ success: true, data: { nameservers: { domains: [{ domain: "Farnholt.com", ns: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"] }] } } });
    });
    const ht = createHypertide({ baseUrl: "https://ht.example/api/v1/", apiKey: "ht_key", dryRun: true, minSpacingMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    const ns = await ht.previewNameservers(["farnholt.com"]);
    expect(ns.get("farnholt.com")).toEqual(["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"]);
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe("https://ht.example/api/v1/domains/nameservers/preview");
  });

  it("sends orders and charges with x-dry-run while dry-run is on", async () => {
    const fetchImpl = vi.fn(async () => res({ success: true, message: "Dry run: order is valid" }));
    const ht = createHypertide({ baseUrl: "https://ht.example/api/v1", apiKey: "k", dryRun: true, minSpacingMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    const order = await ht.createOrder({ plan: "entra" });
    expect(order).toMatchObject({ dryRun: true, recordId: null });
    await ht.charge(["recX"]);
    for (const call of fetchImpl.mock.calls as unknown as [string, RequestInit][]) {
      expect((call[1].headers as Record<string, string>)["x-dry-run"]).toBe("true");
    }
  });

  it("returns the record id of a live order", async () => {
    const fetchImpl = vi.fn(async () => res({ success: true, data: { orders: [{ id: "recABC", domain: "farnholt.com" }],
      nameservers: { domains: [{ domain: "farnholt.com", ns: ["a.ns.cloudflare.com", "b.ns.cloudflare.com"] }] } } }));
    const ht = createHypertide({ baseUrl: "https://ht.example/api/v1", apiKey: "k", dryRun: false, minSpacingMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    const order = await ht.createOrder({});
    expect(order.recordId).toBe("recABC");
    expect(order.nameservers.get("farnholt.com")).toHaveLength(2);
  });

  it("explains validation failures with their fields", async () => {
    const fetchImpl = vi.fn(async () => res({ success: false, error: "VALIDATION_FAILED", message: "Order validation failed",
      details: [{ field: "tool_credentials.api_key", reason: "api_key is required for Smartlead" }] }, 400));
    const ht = createHypertide({ baseUrl: "https://ht.example/api/v1", apiKey: "k", minSpacingMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(ht.createOrder({})).rejects.toThrow(/VALIDATION_FAILED.*tool_credentials\.api_key: api_key is required/);
  });

  it("reads nameserver verification results", async () => {
    const fetchImpl = vi.fn(async () => res({ success: true, data: { results: [
      { domain: "farnholt.com", verified: false, expectedNameservers: ["a"], currentNameservers: ["b"], message: "Nameservers not updated yet" },
    ] } }));
    const ht = createHypertide({ baseUrl: "https://ht.example/api/v1", apiKey: "k", dryRun: false, minSpacingMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await ht.verifyNameservers(["recA"]);
    expect(r.results[0]).toEqual({ domain: "farnholt.com", verified: false, message: "Nameservers not updated yet", expected: ["a"], current: ["b"] });
  });

  it("reads single-domain nameserver responses too", () => {
    expect(readNameservers({ nameservers: { domains: [] } }).size).toBe(0);
  });
});
