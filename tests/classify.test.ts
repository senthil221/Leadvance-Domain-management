import { describe, expect, it } from "vitest";
import { classifyReply, newText } from "../src/lib/classify";

// Real reply previews from the Airtable reply log.
const cases: [string, ReturnType<typeof classifyReply>][] = [
  ["Ms. Lark, what's your phone number so I can call to discuss. John N", "human"],
  ["Let me know more about what sort of funding you offer Chris Barnhill LinkedIn | Book", "human"],
  ["What do you need to qualify? TT Best regards, Trung Thai CEO o: 415.645.2579", "human"],
  ["Please stop emailing me Cindy Seitz President Duperon Education", "negative"],
  ["No Thanks - I am set.", "negative"],
  ["Unsubscribe Trent Thompson PRESIDENT LAUTEN AUDIO www.LautenAudio.com", "negative"],
  ["Please remove this email address, we're not a fit.", "negative"],
  ["STOP ---", "negative"],
  ["P {margin-top:0;margin-bottom:0;} Not interested. Thanks.", "negative"],
  ["Hi Michael, Please remove me from your email list. Thank you, Kristina Boesch", "negative"],
  ["P {margin-top:0;margin-bottom:0;} Stop Laura Hunter Recruitment Founder: Tax | Acco", "negative"],
  ["Hello! I am out of the office today through Friday, returning Monday Oct 19th. For an", "ooo"],
  ["Please note I am out of the office until Tuesday 10/20 and my responses will be delayed", "ooo"],
  ["Thank you for your email - I am currently out of the office but anticipate returning by", "ooo"],
  ["The message you sent requires that you verify that you are a real live human being", "auto"],
  ["Thanks for reaching out. Gary is no longer with the company, please contact sales@", "auto"],
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

  it("reads HTML bodies", () => {
    expect(newText("<div>Interested,<br>call me</div><style>p{}</style>")).toBe("Interested, call me");
    expect(classifyReply("<p>Please <b>unsubscribe</b> me</p>")).toBe("negative");
  });

  it("treats an empty body as human so it is never hidden", () => {
    expect(classifyReply("")).toBe("human");
  });

  it("does not read 'we're set up' as a brush-off", () => {
    expect(classifyReply("We're set up to receive invoices by email, can you send details?")).toBe("human");
  });
});
