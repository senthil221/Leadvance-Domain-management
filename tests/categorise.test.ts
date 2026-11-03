import { describe, expect, it } from "vitest";
import { bounceCode, bounceReason } from "../src/lib/bounces";
import { classifyReply, withoutFooter } from "../src/lib/classify";

// The notices below are written from each provider's published formats; addresses and hosts are made up.
describe("reading the bounce code", () => {
  it.each([
    ["550 5.1.1 The email account that you tried to reach does not exist", "5.1.1"],
    ["550-5.7.26 This mail has been blocked", "5.7.26"],
    ["Remote server returned '550 5.4.1 Recipient address rejected: Access denied'", "5.4.1"],
    ["452 4.2.2 The recipient's inbox is out of storage space", "4.2.2"],
    ["550 No such user here", "550"],
    ["421 Service not available, try again later", "421"],
    ["Connection from [40.107.5.2] to 192.168.0.1 refused", null],
    ["", null],
  ])("%s → %s", (text, code) => {
    expect(bounceCode(text)).toBe(code);
  });
  it("doesn't take a part of an IP address or an address for a code", () => {
    expect(bounceCode("Delivery to 550@example.com failed")).toBeNull();
    expect(bounceCode("host 10.5.1.1 said nothing")).toBeNull();
    expect(bounceCode("You reached the limit of 450 recipients")).toBeNull();
    expect(bounceCode("Delivered 250 2.0.0 OK earlier, then v5.1.2 said no")).toBeNull();
    expect(bounceCode("host mx1 said: 554 rejected")).toBe("554");
  });
});

describe("bounces: the code decides, then the words", () => {
  it.each([
    ["550 5.1.1 The email account that you tried to reach does not exist.", "missing"],
    ["550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup", "missing"],
    ["550 5.4.1 Recipient address rejected: Access denied. AS(201806281)", "missing"],
    ["550 5.4.310 DNS domain does not exist", "missing"],
    ["550 5.2.1 The email account that you tried to reach is disabled", "missing"],
    ["452 4.2.2 The recipient's inbox is out of storage space", "full"],
    ["552 5.2.2 Mailbox full", "full"],
    ["550 5.7.26 Unauthenticated email from this domain is not accepted", "dns"],
    ["550 5.7.515 Access denied, sending domain does not meet the required authentication level", "dns"],
    ["550 5.7.350 Remote server returned message detected as spam", "spam"],
    ["550 5.7.708 Service unavailable. Access denied, traffic not accepted from this IP", "sender"],
    ["550 5.7.705 Access denied, tenant has exceeded threshold", "sender"],
    ["550 5.7.133 Sender not authenticated for group", "restricted"],
    ["550 5.7.606 Access denied, banned sending IP", "blocklist"],
  ])("%s → %s", (text, reason) => {
    expect(bounceReason(text)).toBe(reason);
  });

  it("isn't fooled by a filter's host name", () => {
    expect(bounceReason("550 No such user here (mx1.mailspamprotection.com)")).toBe("missing");
    expect(bounceReason("550 Recipient address rejected: user unknown, from d123.barracudanetworks.com")).toBe("missing");
    expect(bounceReason("Mailbox does not exist at spamfilter.example.com")).toBe("missing");
  });

  it("keeps block list zones: they are the reason", () => {
    expect(bounceReason("554 Rejected by zen.spamhaus.org")).toBe("blocklist");
    expect(bounceReason("550 URL listed in multi.surbl.org")).toBe("blocklist");
  });

  it("5.7.1 means many things, so its words decide", () => {
    expect(bounceReason("550 5.7.1 Message rejected as spam")).toBe("spam");
    expect(bounceReason("550 5.7.1 Service unavailable, client host blocked using Spamhaus")).toBe("blocklist");
    expect(bounceReason("550 5.7.1 Recipient does not accept mail from this sender per local policy")).toBe("policy");
  });

  it("a try-again code is temporary, unless it blames our reputation", () => {
    expect(bounceReason("450 4.3.2 Service currently unavailable")).toBe("temporary");
    expect(bounceReason("451 4.7.1 Greylisted, please try again later, policy check")).toBe("temporary");
    expect(bounceReason("421 4.7.28 Unusual rate of unsolicited mail from your domain")).toBe("spam");
    expect(bounceReason("421 4.7.0 Messages from this sender deferred due to user complaints")).toBe("spam");
  });

  it("reads Gmail's wording with no code", () => {
    expect(bounceReason("Address not found: Your message wasn't delivered because the address couldn't be found")).toBe("missing");
  });
});

describe("replies: what they wrote, not their signature", () => {
  it.each([
    ["Sounds interesting, can you send more details?\nKind regards,\nAnna\nOur office hours are: Monday to Friday 9 to 5", "human"],
    ["Yes let's talk next week.\n\nBest regards, Sam\nThis email is confidential. If you received this in error, do not reply and delete it.", "human"],
    ["Please send pricing.\nSent from my iPhone\nTo unsubscribe from our newsletter click here", "human"],
    ["We're not hiring right now.", "negative"],
    ["Not for us, thanks.", "negative"],
    ["No thanks", "negative"],
    ["We already work with an agency for this.", "negative"],
    ["I'll pass, thanks", "negative"],
    ["I'll pass this on to our CFO, he will reply.", "human"],
  ])("%s → %s", (text, cls) => {
    expect(classifyReply(text)).toBe(cls);
  });

  it("still catches an out of office in a real out of office", () => {
    expect(classifyReply("I am out of the office until Monday.\nKind regards, Anna")).toBe("ooo");
    expect(classifyReply("I'm on annual leave until the 20th.", "Automatic reply: Your message")).toBe("ooo");
    expect(classifyReply("Thanks for your email.", "Automatic reply: Your message")).toBe("auto");
  });

  it("our own subject line, repeated with Re:, says nothing about the reply", () => {
    expect(classifyReply("Sure, send it over.", "Re: Out of office tools for your team")).toBe("human");
  });

  it("doesn't cut a whole message that starts with the footer", () => {
    expect(withoutFooter("regards, nothing else")).toBe("regards, nothing else");
    expect(withoutFooter("Call me on Friday.\nKind regards, Anna")).toBe("Call me on Friday.");
  });
});
