// Sorts a reply into human, out of office, auto-reply or not interested.
// Rules run on the new text only (quoted history removed), in that order of
// priority: an out-of-office that also says "automatic reply" is out of office.

export type ReplyClass = "human" | "ooo" | "auto" | "negative";

const OOO = [
  /\bout of (?:the )?office\b/,
  /\bo\.?o\.?o\.?\b/,
  /\b(?:on|currently on) (?:vacation|holiday|annual leave|leave|pto|parental leave|maternity leave|paternity leave|sabbatical)\b/,
  /\baway from (?:the |my )?(?:office|desk|email)\b/,
  /\b(?:i am|i'm|i will be|i'll be) (?:currently )?(?:away|travell?ing|out)\b.*\b(?:until|through|returning|back)\b/,
  /\b(?:returning|return|back in the office|back in office) (?:on|monday|tuesday|wednesday|thursday|friday|next week)\b/,
  /\blimited (?:access to|ability to check) (?:my )?e-?mail\b/,
  /\bresponses? (?:will|may) be delayed\b/,
];

const AUTO = [
  /\b(?:this is an? )?automat(?:ed|ic) (?:reply|response|message|notification)\b/,
  /\bverify that you are a (?:real )?(?:live )?human\b/,
  /\bchallenge[- ]response\b/,
  /\b(?:do not|don't) reply to this (?:e-?mail|message)\b/,
  /\b(?:we|i) (?:have )?received your (?:e-?mail|message|request)\b/,
  /\bthank you for (?:your|contacting)\b.*\b(?:we will|we'll|someone will) (?:get back|respond|be in touch)\b/,
  /\bticket (?:#|number|id)\b/,
  /\bno longer (?:with|works? (?:at|for)|employed|at)\b/,
  /\bhas left the (?:company|organi[sz]ation)\b/,
  /\b(?:this )?mailbox is (?:not|no longer) (?:monitored|active)\b/,
  /\baddress (?:is )?no longer (?:in use|active|valid)\b/,
];

const NEGATIVE = [
  /\bunsubscribe\b/,
  /\bopt(?:ed)?[- ]?out\b/,
  /\b(?:please )?remove (?:me|us|my (?:e-?mail|address)|this (?:e-?mail|address))\b/,
  /\btake (?:me|us) off\b/,
  /\bstop (?:e-?mailing|contacting|sending|messaging)\b/,
  /^\s*stop\b/,
  /\bnot interested\b/,
  /\bno,? thanks?\b|\bno thank you\b/,
  /\b(?:do not|don't|never) (?:contact|e-?mail|reach out)\b/,
  /\bnot a (?:good )?fit\b/,
  /\b(?:i am|i'm|we are|we're|all) set\s*(?:[.!,]|$)/,
  /\bwe(?: are|'re) (?:good|covered|all set)\b/,
  /\bspam\b/,
];

// Removes HTML, quoted history and signatures' common separators.
export function newText(raw: string) {
  let t = raw
    .replace(/<(?:style|script)[\s\S]*?<\/(?:style|script)>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/P \{margin-top:0;margin-bottom:0;\}/gi, " ");
  // Cut at the start of the quoted thread.
  const cut = t.search(/\n\s*(?:on .{4,80} wrote:|-{2,}\s*original message|from:\s.+\n\s*sent:|>)/i);
  if (cut > 0) t = t.slice(0, cut);
  return t.replace(/\s+/g, " ").trim();
}

export function classifyReply(body: string | null | undefined, subject?: string | null): ReplyClass {
  const text = newText(body ?? "").toLowerCase();
  const subj = (subject ?? "").toLowerCase();
  const both = `${subj} ${text}`;
  if (OOO.some((r) => r.test(both))) return "ooo";
  if (AUTO.some((r) => r.test(both))) return "auto";
  if (NEGATIVE.some((r) => r.test(text))) return "negative";
  return "human";
}
