// Sorts a reply into a type. Rules run on the new text only (quoted history
// removed), in order of priority: out of office, auto-reply, unsubscribe,
// referral, wrong person, not interested; anything else is a human reply
// (shown as Interested). An out-of-office that also says "automatic reply"
// is out of office; "I don't handle HR, please contact Priya" is a referral.

export const REPLY_CLASSES = ["human", "referral", "negative", "wrong_person", "unsubscribe", "ooo", "auto"] as const;
export type ReplyClass = (typeof REPLY_CLASSES)[number];

const OOO = [
  /\bout of (?:the )?office\b/,
  /\bo\.?o\.?o\.?\b/,
  /\b(?:on|currently on) (?:vacation|holiday|annual leave|leave|pto|parental leave|maternity leave|paternity leave|sabbatical)\b/,
  /\baway from (?:the |my )?(?:office|desk|email)\b/,
  /\b(?:i am|i'm|i will be|i'll be) (?:currently )?(?:away|travell?ing|out)\b.*\b(?:until|through|returning|back)\b/,
  /\b(?:returning|return|back in the office|back in office) (?:on|monday|tuesday|wednesday|thursday|friday|next week)\b/,
  /\blimited (?:access to|ability to check) (?:my )?e-?mail\b/,
  /\b(?:i am|i'm) (?:currently )?travell?ing\b/,
  /\bon (?:planned |annual |sick |medical |a )?(?:leave|vacation|holiday)\b/,
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
  /\b(?:e-?mail|mail) ?(?:id|address)? (?:has )?(?:been )?(?:permanently )?(?:changed|updated)\b/,
  /\b(?:shifted|moved) to a new (?:domain|e-?mail|mail)\b/,
  /\bmail delivery (?:software|subsystem|system)\b|\bcould not be delivered to one or more\b/,
  /\bfor any (?:query|queries|questions?|support)\b.*\b(?:reach out|write|contact|e-?mail)\b/,
];

const UNSUBSCRIBE = [
  /\bunsubscribe\b/,
  /\bopt(?:ed)?[- ]?out\b/,
  /\b(?:please )?remove (?:me|us|my (?:e-?mail|address)|this (?:e-?mail|address))\b/,
  /\btake (?:me|us) off\b/,
  /\bstop (?:e-?mailing|contacting|sending|messaging)\b/,
  /^\s*stop\b/,
  /\b(?:do not|don't|never) (?:contact|e-?mail|reach out)\b/,
];

const REFERRAL = [
  /\bloop(?:ing|ed)? (?:in|you in|our|my)\b/,
  /\b(?:have |i've |i have )?added (?:my|our) (?:colleague|team|hr|manager|head)\b/,
  /\b(?:i am|i'm|i have|i've) (?:cc'?d|copied|copying|adding|forwarded|forwarding)\b/,
  /\b(?:cc'?ing|copying|adding) (?:my|our|in)\b/,
  /\bforward(?:ed|ing)? (?:this|your (?:e-?mail|message|note)) to\b/,
  /\b(?:please |kindly |you (?:can|could|may) )?(?:reach out|get in touch|connect|speak|talk|write|contact) (?:to |with )?(?:my colleague|our (?:hr|team|head|manager|ceo|founder)|the (?:hr|right) (?:team|person)|@)/,
  /\bthe right person (?:is|would be|to (?:speak|talk|contact))\b/,
  /\b(?:he|she|they) (?:is|are|will be) (?:the )?(?:right|best|better) (?:person|contact)\b/,
];

const WRONG_PERSON = [
  /\b(?:i|we) (?:do not|don't|dont|no longer) (?:handle|deal with|manage|look after|take care of|work (?:in|on))\b/,
  /\b(?:i am|i'm|im) not (?:an? |the |in )?(?:hr|right person|correct person|person|decision ?maker|responsible|involved|handling)\b/,
  /\bnot (?:the )?(?:right|correct|relevant) (?:person|contact)\b/,
  /\bwrong (?:person|contact|e-?mail|address)\b/,
  /\bnot (?:my|in my) (?:area|department|role|domain|scope)\b/,
  /\bnot (?:handling|in charge of|responsible for)\b/,
];

const NEGATIVE = [
  /\bnot interested\b/,
  /^\s*(?:nope|no|nah)\s*[.!,]*\s*$/,
  /^\s*(?:nope|nah)\b/,
  /\bnot (?:looking|required|needed|a priority|at this (?:time|point))\b/,
  /\b(?:no|don't have (?:a|any)) (?:need|requirement|budget)\b/,
  /\b(?:do not|don't|does not|doesn't) (?:require|need)\b/,
  /\bwe (?:do not|don't) (?:source|use|work with|hire|engage)\b/,
  /\b(?:we )?have our own (?:system|team|solution|platform|vendor|software)\b/,
  /\bwill not (?:move|switch|change)\b/,
  /\bnot related to us\b/,
  /\bno,? thanks?\b|\bno thank you\b/,
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
    .replace(/&#39;|&rsquo;|&lsquo;|[‘’ʼ]/g, "'")
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
  if (UNSUBSCRIBE.some((r) => r.test(text))) return "unsubscribe";
  if (REFERRAL.some((r) => r.test(text))) return "referral";
  if (WRONG_PERSON.some((r) => r.test(text))) return "wrong_person";
  if (NEGATIVE.some((r) => r.test(text))) return "negative";
  return "human";
}
