import { describe, expect, it, vi } from "vitest";
import { asArray, createSmartlead } from "../src/integrations/smartlead";
import { parseAccount, parseCampaign, parseDomainHealth } from "../src/integrations/smartlead-parse";

describe("parseAccount", () => {
  it("reads a Smartlead email account with warmup details", () => {
    const a = parseAccount({
      id: 4100123,
      from_name: "Amelia Wren",
      from_email: "Amelia.Wren@CedarFlowPro.com",
      message_per_day: 15,
      client_id: 4411,
      is_smtp_success: true,
      is_imap_success: true,
      warmup_details: { status: "ACTIVE", warmup_reputation: "98%", max_email_per_day: 30, daily_rampup: 3 },
    });
    expect(a).toMatchObject({
      id: 4100123,
      email: "amelia.wren@cedarflowpro.com",
      domain: "cedarflowpro.com",
      senderName: "Amelia Wren",
      clientId: 4411,
      dailyLimit: 15,
      warmupEnabled: true,
      warmupPerDay: 30,
      warmupRampup: 3,
      warmupReputation: 98,
      connected: true,
    });
  });

  it("marks broken SMTP/IMAP as disconnected and missing values as unknown", () => {
    const a = parseAccount({ id: 1, from_email: "x@y.com", is_imap_success: false })!;
    expect(a.connected).toBe(false);
    expect(a.warmupEnabled).toBeNull();
    expect(a.warmupReputation).toBeNull();
  });

  it("skips rows without an id or address", () => {
    expect(parseAccount({ from_email: "x@y.com" })).toBeNull();
    expect(parseAccount({ id: 2 })).toBeNull();
  });
});

describe("parseCampaign", () => {
  it("reads id, name, status and client", () => {
    expect(parseCampaign({ id: "77", name: "3-Qualifi-Qualifi 23-24 New TM", status: "ACTIVE", client_id: 9 })).toEqual({
      id: 77, name: "3-Qualifi-Qualifi 23-24 New TM", status: "ACTIVE", clientId: 9,
    });
  });
});

describe("parseDomainHealth", () => {
  it("finds domain rows in a wrapped response", () => {
    const r = parseDomainHealth({ ok: true, data: { domain_wise_health_metrics: [
      { domain: "bluecrestis.com", sent_count: "208", reply_count: 3, bounce_count: 2 },
      { domain: "fieldopsbase.com", sent: 42 },
    ] } });
    expect(r.recognised).toBe(true);
    expect(r.rows).toEqual([
      { domain: "bluecrestis.com", sent: 208, replies: 3, bounces: 2 },
      { domain: "fieldopsbase.com", sent: 42, replies: null, bounces: null },
    ]);
  });

  it("says so when it cannot read the shape", () => {
    expect(parseDomainHealth({ data: [{ foo: 1 }] }).recognised).toBe(false);
  });
});

describe("asArray", () => {
  it("unwraps the list shapes Smartlead uses", () => {
    expect(asArray([1])).toEqual([1]);
    expect(asArray({ data: [2] })).toEqual([2]);
    expect(asArray({ data: { email_accounts: [3] } })).toEqual([3]);
    expect(asArray({ message: "none" })).toEqual([]);
  });
});

describe("createSmartlead", () => {
  it("sends reads, but only logs writes while dry-run is on", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{ id: 1 }]), { status: 200 }));
    const sl = createSmartlead({ apiKey: "k", dryRun: true, minSpacingMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await sl.listCampaigns()).toEqual([{ id: 1 }]);
    expect(await sl.updateDailyLimit(5, 20)).toEqual({ dryRun: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain("api_key=k");
  });

  it("retries a rate-limited call", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => (++n === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } }) : new Response("[]", { status: 200 })));
    const sl = createSmartlead({ apiKey: "k", minSpacingMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await sl.listCampaigns()).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("raises a readable error on a failed call", async () => {
    const fetchImpl = vi.fn(async () => new Response("Invalid API key", { status: 401 }));
    const sl = createSmartlead({ apiKey: "bad", minSpacingMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(sl.listCampaigns()).rejects.toThrow(/HTTP 401.*Invalid API key/);
  });
});
