import { describe, expect, it } from "vitest";
import { parseSmartleadEvent } from "../src/lib/smartlead-events";

// Flat shape, as Smartlead sends it (fields seen in the Airtable reply log).
const flatReply = {
  event_type: "EMAIL_REPLY",
  stats_id: "c1a2b3",
  sl_email_lead_id: 98765,
  from_email: "Sophia.Lark@BlueCrestis.com",
  to_email: "niles@globaltelematics.com",
  to_name: "Niles",
  subject: "Re: Quick question",
  campaign_id: 2400012,
  campaign_name: "1-Qualifi-Qualifi telecom 1-10 TM (ai Ark)",
  client_id: 4411,
  sequence_number: 2,
  time_replied: "2026-10-20T05:09:00Z",
  reply_message: { message_id: "<abc@mail.gmail.com>", text: "Ms. Lark, what's your phone number so I can call to discuss. John N", time: "2026-10-20T05:09:00Z" },
  preview_text: "Ms. Lark, what's your phone number",
};

// Nested shape from the Smartlead webhook docs.
const nestedReply = {
  event: "EMAIL_REPLIED",
  timestamp: "2024-01-15T11:00:00Z",
  campaign_id: 123,
  lead_id: 789,
  email_account_id: 456,
  sequence_number: 1,
  reply: { subject: "Re: Quick question", body: "Please remove me from your list", received_at: "2024-01-15T11:00:00Z", message_id: "reply-abc123" },
  lead: { email: "lead@example.com", first_name: "Jane" },
};

describe("parseSmartleadEvent", () => {
  it("reads the flat reply shape: our inbox, the lead, the campaign and the class", () => {
    const e = parseSmartleadEvent(flatReply)!;
    expect(e.kind).toBe("reply");
    expect(e.inboxEmail).toBe("sophia.lark@bluecrestis.com");
    expect(e.domainName).toBe("bluecrestis.com");
    expect(e.leadEmail).toBe("niles@globaltelematics.com");
    expect(e.campaignId).toBe(2400012);
    expect(e.smartleadClientId).toBe(4411);
    expect(e.sequenceNumber).toBe(2);
    expect(e.replyClass).toBe("human");
    expect(e.occurredAt.toISOString()).toBe("2026-10-20T05:09:00.000Z");
    expect(e.dedupeKey).toBe("reply:<abc@mail.gmail.com>");
  });

  it("reads the nested shape and matches the inbox by account id", () => {
    const e = parseSmartleadEvent(nestedReply)!;
    expect(e.kind).toBe("reply");
    expect(e.inboxEmail).toBeNull();
    expect(e.smartleadAccountId).toBe(456);
    expect(e.leadEmail).toBe("lead@example.com");
    expect(e.replyClass).toBe("negative");
    expect(e.dedupeKey).toBe("reply:reply-abc123");
  });

  it("reads bounces with their bounce text", () => {
    const e = parseSmartleadEvent({
      event_type: "EMAIL_BOUNCE",
      from_email: "michaelreynolds_m@boldvault.info",
      to_email: "ehess@flowprod.com",
      campaign_id: 77,
      stats_id: "s-9",
      sequence_number: 1,
      event_timestamp: "2026-06-28T10:00:00Z",
      bounce_reason: "Delivery has failed to these recipients or groups: ehess@flowprod.com",
    })!;
    expect(e.kind).toBe("bounce");
    expect(e.domainName).toBe("boldvault.info");
    expect(e.preview).toContain("Delivery has failed");
    expect(e.replyClass).toBeNull();
    expect(e.dedupeKey).toBe("bounce:s-9:1");
  });

  it("ignores events we don't track", () => {
    expect(parseSmartleadEvent({ event_type: "EMAIL_OPEN", from_email: "a@b.com" })).toBeNull();
    expect(parseSmartleadEvent({ hello: "world" })).toBeNull();
    expect(parseSmartleadEvent(null)).toBeNull();
  });

  it("gives a retried delivery the same key, and a different event a different key", () => {
    const sent = { event_type: "EMAIL_SENT", from_email: "amelia.wren@cedarflowpro.com", to_email: "x@y.com", campaign_id: 1, sequence_number: 1, event_timestamp: "2026-10-19T09:00:00Z" };
    const a = parseSmartleadEvent(sent)!.dedupeKey;
    const b = parseSmartleadEvent({ ...sent })!.dedupeKey;
    const c = parseSmartleadEvent({ ...sent, sequence_number: 2 })!.dedupeKey;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("falls back to the time it arrived when the payload has none", () => {
    const at = new Date("2026-10-20T12:00:00Z");
    const e = parseSmartleadEvent({ event_type: "EMAIL_SENT", from_email: "a@b.com" }, at)!;
    expect(e.occurredAt).toEqual(at);
  });
});
