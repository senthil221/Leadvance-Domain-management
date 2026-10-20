import { describe, expect, it, vi } from "vitest";
import { createPorkbun, parsePorkbunDomain, sameNameservers } from "../src/integrations/porkbun";

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("parsePorkbunDomain", () => {
  it("reads listAll items, including integer flags and Porkbun's UTC dates", () => {
    expect(parsePorkbunDomain({
      domain: "BlueCrestis.com", status: "ACTIVE", tld: "com",
      createDate: "2026-03-01 14:05:00", expireDate: "2027-03-01 14:05:00",
      autoRenew: 1, apiAccess: 0, securityLock: 1,
    })).toEqual({
      name: "bluecrestis.com",
      status: "ACTIVE",
      createdAt: new Date("2026-03-01T14:05:00Z"),
      expiresAt: new Date("2027-03-01T14:05:00Z"),
      autoRenew: true,
      apiAccess: false,
    });
  });

  it("accepts the older string flags and skips junk", () => {
    expect(parsePorkbunDomain({ domain: "a.io", autoRenew: "1" })?.autoRenew).toBe(true);
    expect(parsePorkbunDomain({ domain: "not a domain" })).toBeNull();
  });
});

describe("sameNameservers", () => {
  it("compares as a set, ignoring case, order and trailing dots", () => {
    expect(sameNameservers(["NS2.hypertide.io.", "ns1.hypertide.io"], ["ns1.hypertide.io", "ns2.hypertide.io"])).toBe(true);
    expect(sameNameservers(["ns1.a.com"], ["ns1.a.com", "ns2.a.com"])).toBe(false);
  });
});

describe("createPorkbun", () => {
  it("sends keys in the body and pages through listAll", async () => {
    const first = Array.from({ length: 1000 }, (_, i) => ({ domain: `d${i}.com` }));
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.apikey).toBe("pk1_x");
      expect(body.secretapikey).toBe("sk1_y");
      return ok({ status: "SUCCESS", domains: body.start === 0 ? first : [{ domain: "last.com" }] });
    });
    const pb = createPorkbun({ apiKey: "pk1_x", secretKey: "sk1_y", minSpacingMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    const all = await pb.listAll();
    expect(all).toHaveLength(1001);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not send nameserver updates in dry-run, and sends them with an idempotency key when live", async () => {
    const fetchImpl = vi.fn(async () => ok({ status: "SUCCESS" }));
    const dry = createPorkbun({ apiKey: "a", secretKey: "b", dryRun: true, minSpacingMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await dry.updateNs("x.com", ["ns1.h.io"])).toMatchObject({ dryRun: true });
    expect(fetchImpl).not.toHaveBeenCalled();

    const live = createPorkbun({ apiKey: "a", secretKey: "b", dryRun: false, minSpacingMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    await live.updateNs("x.com", ["ns1.h.io", "ns2.h.io"]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/domain\/updateNs\/x\.com$/);
    expect(JSON.parse(String(init.body)).ns).toEqual(["ns1.h.io", "ns2.h.io"]);
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
  });

  it("turns a Porkbun error into a readable message with its code", async () => {
    const fetchImpl = vi.fn(async () => ok({ status: "ERROR", code: "DOMAIN_NOT_ALLOWED", message: "Domain is not opted in to API access." }, 400));
    const pb = createPorkbun({ apiKey: "a", secretKey: "b", minSpacingMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(pb.getNs("x.com")).rejects.toThrow(/DOMAIN_NOT_ALLOWED.*not opted in/);
  });
});
