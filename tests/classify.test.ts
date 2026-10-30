import { describe, expect, it } from "vitest";
import { classifyReply, newText } from "../src/lib/classify";

// Real reply previews from the Airtable reply log.
const cases: [string, ReturnType<typeof classifyReply>][] = [
  ["Ms. Lark, what's your phone number so I can call to discuss. John N", "human"],
  ["Let me know more about what sort of funding you offer Chris Barnhill LinkedIn | Book", "human"],
  ["What do you need to qualify? TT Best regards, Trung Thai CEO o: 415.645.2579", "human"],
  ["Please stop emailing me Cindy Seitz President Duperon Education", "unsubscribe"],
  ["No Thanks - I am set.", "negative"],
  ["Unsubscribe Trent Thompson PRESIDENT LAUTEN AUDIO www.LautenAudio.com", "unsubscribe"],
  ["Please remove this email address, we're not a fit.", "unsubscribe"],
  ["STOP ---", "unsubscribe"],
  ["P {margin-top:0;margin-bottom:0;} Not interested. Thanks.", "negative"],
  ["Hi Michael, Please remove me from your email list. Thank you, Kristina Boesch", "unsubscribe"],
  ["P {margin-top:0;margin-bottom:0;} Stop Laura Hunter Recruitment Founder: Tax | Acco", "unsubscribe"],
  // Replies from the Kapable campaigns (October 2026).
  ["nope", "negative"],
  ["I don’t handle HR ", "wrong_person"],
  ["Looping our HR team to evaluate the same. Get Outlook for iOS", "referral"],
  ["Sure. Have added my colleague Sudha as well.", "referral"],
  ["Hello! We have shifted to ODOO recently so we will not move to any other software. Regards Gs", "negative"],
  ["We don't source candidates from outside agencies. Thanks & Regards, Harish Kumar", "negative"],
  ["At the moment, we have our own system in place, which is working perfectly well, so we do not require any additional", "negative"],
  ["Hi Rishav, You are wrong, we are not manufacturing we are a software development company. Not related to us", "negative"],
  ["Hi, I’m away, back to work on 23rd October, Friday. Please expect a delay in my response.", "ooo"],
  ["Dear Sender Greetings and trust you are doing well. I'm on planned leave from 15th October 2026 to 20th October 2026.", "ooo"],
  ["Dear Partner / Customer, Thank you for reaching out. Please note that my email address has been updated.", "auto"],
  ["Dear Sir, This is to inform you that due to some Technical Issue, my Email id has been permanently changed from a@b.com", "auto"],
  ["This message was created automatically by mail delivery software. A message that you sent could not be delivered to one or more of its recipients.", "auto"],
  ["Please explain in detail, bcos we already use ERP. How does this system differe from ERP?", "human"],
  ["Sure.. can explore", "human"],
  ["Hi Rishav, Lets schedule a call in the coming week on Wednesday around 2pm.", "human"],
  ["I don't handle HR", "wrong_person"],
  ["I am not an HR, sorry", "wrong_person"],
  ["I don't handle HR for Aspire For Her. Thanks.", "wrong_person"],
  ["Hi, I am not handling the HR & currently we are not looking for this type coaching program.", "wrong_person"],
  ["Dear Shema, Looping you in Please have a look Regards Gagan Khurana", "referral"],
  ["Thanks Gagan, Looping in Priyanka from HR. @Priyanka if this is something you would be interested in", "referral"],
  ["Hi Twinkle, Awaiting a response here, in case you are keen to explore the requirement.", "human"],
  ["Thank you for your email. I am travelling. For any urgent matters you can reach out to my colleague: milan@cms.com", "ooo"],
  ["Hello Twinkle, I am on maternity leave. You can reach out to me after one week please", "ooo"],
  ["Name : Vikas Gupta Designation : Placement Manager Mail Id has been changed to vikas@vlcc.com", "auto"],
  ["Thank you for reaching out to Prosperr.io. For any query related to any support, Please reach out to us at support@prosperr.io.", "auto"],
  ["Hello! I am out of the office today through Friday, returning Monday Oct 19th. For an", "ooo"],
  ["Please note I am out of the office until Tuesday 10/20 and my responses will be delayed", "ooo"],
  ["Thank you for your email - I am currently out of the office but anticipate returning by", "ooo"],
  ["The message you sent requires that you verify that you are a real live human being", "auto"],
  ["Thanks for reaching out. Gary is no longer with the company, please contact sales@", "auto"],
  // Read as human before October 2026; paraphrased from the Qualifi replies.
  ["Thank you for your message. As of April 13 I am no longer involved in the day-to-day operations of the group.", "auto"],
  ["Thank you for contacting Acme Electric. As of June 17, Nathan has moved on and is no longer a part of the team.", "auto"],
  ["Hello, and thank you for reaching out – Andrew has transitioned from the company. Please edit your point of contact.", "auto"],
  ["Sam is longer working at Acme. For any related inquiries, please contact Rob at rob@acme.com.", "auto"],
  ["Hi, I'm sad to share that as of August the practice is closed, and I am no longer accepting clients.", "auto"],
  ["Thank you for choosing Acme Bridal. Your message is important to us. Please allow 24 hours for a reply.", "auto"],
  ["Your email has been received and I will get back to you in 24-48 business hours.", "auto"],
  ["Hi, This email address has been retired as of June 30. Please update your address book with my new email.", "auto"],
  ["Thank you for your email. Please note that I have changed my primary email address to n@acme.com", "auto"],
  ["Thank you for writing. Our grumpy automated gatekeeper won't let your email through unless you can show that you're a real person", "auto"],
  ["Hello, Thank you for reaching out. Please be advised that Phyllis has officially retired from the firm.", "auto"],
  ["This email address is not monitored. Please redirect your message to the appropriate contact.", "auto"],
  ["For new and existing requests please reach out to april@acme.com", "auto"],
  ["Out of business", "auto"],
  ["Hi! I'm currently in Omaha for training 10/26-10/29. I will have limited availability to my email during this time.", "ooo"],
  ["I will be offsite on Wednesday attending plan review appointments. Please expect a delay in my response.", "ooo"],
  ["Hi, I am currently unavailable. For assistance, please reach out to judy@acme.com", "ooo"],
  ["Vom 07.09. bis 18.09. bin ich nicht im Hause und werde meine Mails nur unregelmäßig lesen.", "ooo"],
  ["No interest at this time. Thank you", "negative"],
  ["Not very interesting", "negative"],
  ["This isn't relevant to us. Best, Dena", "negative"],
  ["Thank you for reaching out and for your interest in our work. For now, we will pass on this opportunity.", "negative"],
  ["We are currently all set with our employee development training and will keep your information on hand.", "negative"],
  ["Hi Shawn, We are taking care of this in house only.", "negative"],
  ["No interested. Pls remove from email list", "unsubscribe"],
  ["Remove from list. Thanks.", "unsubscribe"],
  ["Hi, kindly reach out to hr.support@acme.co.in for further assistance.", "referral"],
  ["I think you have the wrong company...we create video games.", "wrong_person"],
  // Real interest stays human.
  ["Hi Suvin Thank you for contacting us. We would like to see a basic demo to better understand your software.", "human"],
  ["Hello Isabella, Thanks for reaching out. I'd like to learn more about the funding process and what are the terms", "human"],
  ["Hi, I have left you a voicemail, call me back when free.", "human"],
  ["I'll pass this on to our CFO, he will reply.", "human"],
];

describe("classifyReply", () => {
  it.each(cases)("%s → %s", (text, expected) => {
    expect(classifyReply(text)).toBe(expected);
  });

  it("uses the subject for out-of-office auto replies", () => {
    expect(classifyReply("I will respond when I return.", "Automatic reply: Out of Office")).toBe("ooo");
  });

  it("ignores the quoted thread below the reply", () => {
    const body = "Sounds good, send me times for Thursday.\n\nOn Mon, Oct 19, 2026 at 9:00 AM Amelia Wren wrote:\n> reply STOP to unsubscribe";
    expect(classifyReply(body)).toBe("human");
  });

  it("finds no new text in a reply that opens with the quoted email", () => {
    expect(newText("On Tue, Oct 20, 2026 at 1:06 PM Isabella Cove wrote:\n> Reply STOP to unsubscribe")).toBe("");
    expect(classifyReply("> On 10/20/2026 1:06 PM EDT Isabella Cove wrote:\n> not interested? remove me")).toBe("human");
  });

  it("reads HTML bodies", () => {
    expect(newText("<div>Interested,<br>call me</div><style>p{}</style>")).toBe("Interested, call me");
    expect(classifyReply("<p>Please <b>unsubscribe</b> me</p>")).toBe("unsubscribe");
  });

  it("treats an empty body as human so it is never hidden", () => {
    expect(classifyReply("")).toBe("human");
  });

  it("does not read 'we're set up' as a brush-off", () => {
    expect(classifyReply("We're set up to receive invoices by email, can you send details?")).toBe("human");
  });
});
