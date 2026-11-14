import { describe, expect, it } from "vitest";
import { bounceCauseOf, bounceCode, bounceLine, bounceReason } from "../src/lib/bounces";
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

  it("blames our DNS when the receiver says our mail has no SPF, DKIM or DMARC, even on a bare 5.7.1", () => {
    expect(bounceReason("550 5.7.1 Message rejected: Message lacks SPF/DKIM/DMARC Auth Records")).toBe("dns");
    expect(bounceReason("Remote server returned '550 5.7.1 Message rejected: Message lacks SPF/DKIM/DMARC Auth Records'")).toBe("dns");
    expect(bounceReason("550 5.7.1 Email rejected per DMARC policy for example.com")).toBe("dns");
    expect(bounceReason("550 5.7.1 Message blocked due to DMARC policy")).toBe("dns");
    expect(bounceReason("550 5.7.1 DMARC policy check failed")).toBe("dns");
  });

  it("calls a content filter's score spam, whatever its rule names say", () => {
    const sa = (rules: string) => `550 5.7.350 Remote server returned message detected as spam -> 554 5.7.1 Content filter reject: SpamAssassin score 24.109 (${rules})`;
    expect(bounceReason(sa("DKIM_SIGNED,DKIM_VALID,URIBL_BLOCKED"))).toBe("spam");
    expect(bounceReason(sa("DKIM_SIGNED,DKIM_VALID,DKIM_VALID_AU,DMARC_PASS,RCVD_IN_DNSWL_NONE"))).toBe("spam");
    // A real listing still reads as one.
    expect(bounceReason("554 5.7.1 Service unavailable; Client host [1.2.3.4] blocked using zen.spamhaus.org")).toBe("blocklist");
  });

  it("a try-again code is temporary, unless it blames our reputation", () => {
    expect(bounceReason("450 4.3.2 Service currently unavailable")).toBe("temporary");
    expect(bounceReason("451 4.7.1 Greylisted, please try again later, policy check")).toBe("temporary");
    expect(bounceReason("421 4.7.28 Unusual rate of unsolicited mail from your domain")).toBe("spam");
    expect(bounceReason("421 4.7.0 Messages from this sender deferred due to user complaints")).toBe("spam");
  });

  it("detected as spam only says the other server called it spam: its own words decide", () => {
    expect(bounceReason("550 5.7.350 Remote server returned message detected as spam -> 550 5.7.1 Message rejected: sender domain is blocklisted")).toBe("blocklist");
    expect(bounceReason("550 5.7.350 Remote server returned message detected as spam -> 550 An URL in this email is listed by Spamhaus DBL")).toBe("blocklist");
    expect(bounceReason("550 5.7.350 Remote server returned message detected as spam -> 550 High probability of spam")).toBe("spam");
  });

  it("a sender domain nobody can find is our DNS, whatever the code", () => {
    expect(bounceReason("550 5.4.300 Message expired - 450 4.1.8 <a@b.com>: Sender address rejected: Domain not found")).toBe("dns");
    expect(bounceReason("550 5.4.300 Message expired - 451 4.1.8 Domain of sender address a@b.com does not resolve")).toBe("dns");
    expect(bounceReason("550 5.1.8 <a@b.com>... Domain of sender address a@b.com does not exist")).toBe("dns");
    expect(bounceReason("Sender (example.com) has no A, AAAA, or MX DNS records.")).toBe("dns");
  });

  it("sender rejected isn't a bad address, whatever the code", () => {
    expect(bounceReason("550 5.1.0 <a@b.com> sender rejected. Please see the help page")).toBe("policy");
    expect(bounceReason("550 Requested action not taken: mailbox unavailable Reject due to policy restrictions")).toBe("policy");
  });

  it("a mailbox that's gone is a bad address, even behind 5.7.1", () => {
    expect(bounceReason("554 5.7.1 Sorry, your message cannot be delivered. This mailbox is disabled (554.30)")).toBe("missing");
    expect(bounceReason("550 5.7.1 This person is no longer at Acme. Please reach out to us instead")).toBe("missing");
    expect(bounceReason("451 4.4.4 Mail received as unauthenticated, incoming to a recipient domain configured in a hosted tenant which has no mail-enabled subscriptions")).toBe("missing");
  });

  it("a mail loop is the recipient's own setup, neither a bad address nor a delay", () => {
    expect(bounceReason("554 5.4.14 Hop count exceeded - possible mail loop")).toBe("restricted");
    expect(bounceReason("550 misconfigured forwarding address")).toBe("restricted");
  });
  it("a sender domain nobody can resolve is DNS, even with the address in brackets", () => {
    expect(bounceReason("553 #5.1.8 Domain of sender address <amy@example.com> does not exist")).toBe("dns");
    expect(bounceReason("Message expired - 451 #4.1.8 Domain of sender address <amy@example.com> does not resolve")).toBe("dns");
    expect(bounceReason("Message permanently deferred due to unresolvable example.com from domain")).toBe("dns");
  });
  it("a server that won't take mail for the address means the address is no good", () => {
    expect(bounceReason("454 4.7.1 <amy@example.com>: Relay access denied")).toBe("missing");
    expect(bounceReason("authentication required to relay - 550 Please turn on SMTP Authentication in your mail client")).toBe("missing");
    expect(bounceReason("550 Disabled recipient address")).toBe("missing");
  });

  it("finds the server's own error further down a Microsoft notice, past its help text", () => {
    const html = (error: string) => ({ bounce_message: {
      text: "Your message to a@b.com couldn't be delivered. Security or policy settings at b.com have rejected your message.",
      html: `<p>Security or policy settings at b.com have rejected your message.</p><p>How to Fix It</p><p>Check the Error Details below to see why it was blocked.</p><p>Error Details</p><p>Error: ${error}</p><p>Message rejected by: mx.b.com</p><p>Notification Details</p>`,
    } });
    expect(bounceCauseOf(html("554 5.7.1 Service unavailable; Sender address [a@c.com] blocked using dbl.spamhaus.org"))).toBe("blocklist");
    expect(bounceCauseOf(html("554 5.7.1 Service unavailable; Sender address [a@c.com] blocked"))).toBe("blocklist");
    expect(bounceCauseOf(html("554 5.7.1 Mail was classified as unsolicited"))).toBe("spam");
    expect(bounceCauseOf(html("550 5.7.1 Message rejected by policy"))).toBe("policy");
    expect(bounceLine("clipped text", "Error: 554 5.7.1 Sender address blocked Message rejected by: mx.b.com")).toBe("554 5.7.1 Sender address blocked");
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

  it.each([
    // Mailboxes that are gone, and acknowledgements.
    ["This email is no longer being managed. Please call our office.", "auto"],
    ["This account is no longer managed or reviewed by Pat.", "auto"],
    ["Hello, this email is not longer a valid email. Please contact our CEO.", "auto"],
    ["Thank you for emailing me. I will respond to your email as soon as I can.", "auto"],
    ["This is to confirm receipt of your message.", "auto"],
    ["If you are attempting to contact the office manager, please email Sam at sam@example.com", "auto"],
    ["With deep sadness we share that our colleague has passed away. For funding matters, contact info@example.com", "auto"],
    ["Thank you. For general assistance please reach out to help@example.com", "auto"],
    // Away, said differently.
    ["I will be teaching this week and will return to my inbox on October 19.", "ooo"],
    ["My computer needs a cool-down and is taking a vacation until October 19.", "ooo"],
    ["Thank you for emailing me. I am ill today but plan to be back this afternoon.", "ooo"],
    ["I am out the month of November. For emergencies, please contact a@example.com", "ooo"],
    ["We are moving office, so response times may be slower.", "ooo"],
    ["Bonjour, je suis en arrêt actuellement pour raison médicale.", "ooo"],
    ["Current status: away from keyboard. Return date: October 26th.", "ooo"],
    // People saying no.
    ["Good morning, not @ this time. Dan", "negative"],
    ["This is not a problem for us. Best, Pat", "negative"],
    ['I have "0" problems with funding. Thanks', "negative"],
    ["We are cash positive and do not have and need for outside investment.", "negative"],
    ["We are a factory abroad, so we don't plan to purchase from the US.", "negative"],
    ["We aren't currently looking for external programs.", "negative"],
    ["Sold company and retired. Pat Lee", "negative"],
    // Taken off the list, and passed along.
    ["unsub", "unsubscribe"],
    ["Remove please\nSincerely, Pat", "unsubscribe"],
    ["Please email Sam at sam@example.com, he would be the contact for this.", "referral"],
    ["Sorry, no Alex here.", "wrong_person"],
    // Real interest stays human.
    ["Hi, I'm interested in learning more about inventory funding. Can you advise?", "human"],
    ["Is this credit based or income based", "human"],
    ["Send more info please\nPat Lee, CEO", "human"],
    ["Pat, https://example.com/circuits Best, Lee", "human"],
  ] as [string, ReturnType<typeof classifyReply>][])("%s → %s", (text, cls) => {
    expect(classifyReply(text)).toBe(cls);
  });

  it("a footer doesn't bury a real question", () => {
    expect(classifyReply("What are your rates? We're looking for a line of credit. ******We have moved. Please update your records. Regards, Pat")).toBe("human");
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
