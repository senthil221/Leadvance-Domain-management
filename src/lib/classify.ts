// Sorts a reply into a type. Rules run on the new text only (quoted history
// removed), in order of priority: out of office, auto-reply, unsubscribe,
// referral, wrong person, not interested; anything else is a human reply
// (shown as Interested). An out-of-office that also says "automatic reply"
// is out of office; "I don't handle HR, please contact Priya" is a referral.

export const REPLY_CLASSES = ["human", "referral", "negative", "wrong_person", "unsubscribe", "ooo", "auto"] as const;
export type ReplyClass = (typeof REPLY_CLASSES)[number];

const OOO = [
  /\b(?:will|i'll) return to (?:my |the )?(?:inbox|office|desk|e-?mail)\b|\b(?:i will|i'll) return on\b|\breturn date\b|\baway from keyboard\b/,
  /\bvacation until\b|\btaking a vacation\b|\b(?:i am|i'm) (?:ill|sick|unwell)\b|\b(?:i am|i'm) out (?:the|this|all)\b|\btemporary assignment\b/,
  /\bresponse times? (?:may|will|might) be\b|\bje suis (?:en arr[eê]t|absente?|en cong[eé]s?)\b/,
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
  /\b(?:expect|there (?:will|may) be) (?:a |some )?delay in (?:my |our )?(?:response|reply|replies)\b/,
  /\b(?:i am|i'm|i will be|i'll be) (?:currently )?(?:unavailable|offsite|off-site|on the road|in training|out sick)\b/,
  /\b(?:limited|no) (?:availability|access)\b.{0,40}\b(?:e-?mail|during)\b/,
  /\btravell?ing on business\b|\b(?:i will|i'll|i will be|i'll be) travell?ing\b/,
  /\battending (?:a |the )?conference\b|\bback-to-back conferences\b/,
  /\b(?:i will be|i'll be) (?:away|out of)\b|\b(?:out|in (?:a )?meetings?) for the (?:remainder|rest) of the day\b/,
  // German, French, Spanish, Dutch.
  /\b(?:abwesend|au(?:ß|ss)er haus|im urlaub|nicht im hause)\b|\bwieder zur(?:ü|ue)ck\b|\babsente? du bureau\b|\ben cong[ée]s?\b|\bfuera de la oficina\b|\bde vacaciones\b|\bafwezig\b/,
];

const AUTO = [
  /\b(?:no|not) longer (?:being )?(?:managed|maintained|monitored|reviewed|valid|active|in use|a valid)\b|\bpassed away\b/,
  /\bthank you for (?:your e-?mail|e-?mailing|your message|reaching out)\b.{0,160}\b(?:i will|i'll|we will|we'll)\b.{0,50}\b(?:respond|reply|get back)\b/,
  /\bconfirm(?:s|ing)? receipt\b|\bif you are (?:attempting|trying) to (?:contact|reach)\b/,
  /\b(?:this is an? )?automat(?:ed|ic) (?:reply|response|message|notification)\b/,
  /\bverify that you are a (?:real )?(?:live )?human\b/,
  /\bchallenge[- ]response\b/,
  /\b(?:do not|don't) reply to this (?:e-?mail|message)\b/,
  /\b(?:we|i) (?:have )?received your (?:e-?mail|message|request)\b/,
  /\bthank you for (?:your|contacting)\b.*\b(?:we will|we'll|someone will) (?:get back|respond|be in touch)\b/,
  /\bticket (?:#|number|id)\b/,
  /\bno longer (?:with|works? (?:at|for)|working|employed|at|involved|affiliated|associated|a part of|part of|serving|accepting|performing|providing|using|in business)\b/,
  /\b(?:is|am) longer (?:working|with)\b/,
  /\bhas left the (?:company|organi[sz]ation|firm|business)\b/,
  /\b(?:has|have|i've) (?:officially )?(?:moved on|transitioned|retired)\b/,
  /\bno longer (?:a working|receives|manages)\b|\b(?:has been|is) discontinued\b|\bsoon to become in-?active\b|\bout of business\b/,
  /\b(?:i|he|she) (?:have|has|'ve) (?:now )?(?:left|departed)\b(?! (?:a|you|it|this|my|your|the (?:message|voicemail|note))\b)|\bhas departed\b/,
  /\bcheck this (?:e-?mail|inbox|mailbox|address) (?:very )?(?:infrequently|rarely|occasionally)\b/,
  /\btransitioning (?:from|out of)\b|\bstepping down\b|\bmy last (?:working )?day\b|\bi (?:will )?retire\b|\bi (?:have |am )?retired\b|\bmerged with\b/,
  /\b(?:has|have) (?:been )?(?:permanently )?(?:closed|shut down)\b|\bis (?:now )?closed\b|\bclosed (?:until|for)\b|\bdefunct\b/,
  /\b(?:this )?(?:mailbox|inbox|e-?mail(?: address)?|address) (?:is|will be) (?:not|no longer|not longer) (?:being )?(?:actively )?(?:monitored|active|in use|checked)\b/,
  /\b(?:not|no longer) (?:actively )?monitored\b/,
  /\baddress (?:is )?no longer (?:in use|active|valid)\b/,
  /\b(?:e-?mail|mail) ?(?:id|address)? (?:has )?(?:been )?(?:permanently )?(?:changed|updated|retired|deactivated)\b/,
  /\bwill be (?:deactivated|discontinued|shut down)\b|\be-?mail address change\b|\b(?:my|our) new e-?mail\b/,
  /\b(?:has been|was|been) (?:automatically )?forwarded\b|\bchanged my (?:primary |work )?e-?mail\b|\bupdate (?:your|my) (?:address book|contacts?|records)\b|\bunable to use\b.{0,30}\be-?mail\b/,
  /\b(?:shifted|moved) to a new (?:domain|e-?mail|mail)\b/,
  /\bmail delivery (?:software|subsystem|system)\b|\bcould not be delivered to one or more\b|\bdelivery has failed\b|\bremote server returned\b/,
  /\bfor any (?:query|queries|questions?|support)\b.*\b(?:reach out|write|contact|e-?mail)\b/,
  /\bfor (?:all|new|existing|further|any|general|other) (?:\w+ ){0,3}(?:requests?|inquiries|enquiries|matters|assistance)\b.{0,60}\b(?:contact|reach out|e-?mail|write|redirect)\b/,
  // Acknowledgements and gatekeepers.
  /\bthank you for (?:contacting|choosing) (?!us\b|me\b)\w|\bthank you for reaching out to (?!me\b|us\b)\w/,
  /\byour (?:message|e-?mail|inquiry) (?:is important|has been received|was received)\b/,
  /\bwill (?:get back|respond|reply)(?: to you)? (?:in|within) \d+(?:-\d+)? (?:business )?hours\b|\ballow \d+(?:-\d+)? (?:business )?(?:hours|days)\b/,
  /\b(?:one of )?our (?:staff|team)(?: members?)? will (?:respond|reply|get back)\b|\bfor (?:immediate|urgent) (?:assistance|matters|response|help)\b/,
  /\boffice hours (?:are|:)|\bplease redirect your\b|\bautomated gatekeeper\b|\bshow that you'?re a real person\b|\bverify your e-?mail address\b/,
  /\bnous vous remercions\b|\bmerci pour votre (?:message|e-?mail)\b|\bnicht mehr erreichbar\b/,
];

const UNSUBSCRIBE = [
  /\bunsub\b|^\s*remove(?: me)?(?: please)?\b/,
  /\bunsubscribe\b/,
  /\bopt(?:ed)?[- ]?out\b/,
  /\b(?:please )?remove (?:me|us|my (?:e-?mail|address)|this (?:e-?mail|address))\b/,
  /\bremove\b.{0,25}\b(?:list|lists|records?|database|mailing)\b|\blose this address\b/,
  /\btake (?:me|us) off\b/,
  /\bstop (?:e-?mailing|contacting|sending|messaging)\b/,
  /^\s*stop\b/,
  /\b(?:do not|don't|never) (?:contact|e-?mail|reach out)\b/,
];

const REFERRAL = [
  /\b(?:please |kindly )?e-?mail \w+ at\b|\bwould be the (?:right |best |correct )?(?:contact|person)\b/,
  /\bloop(?:ing|ed)? (?:in|you in|our|my)\b/,
  /\b(?:have |i've |i have )?added (?:my|our) (?:colleague|team|hr|manager|head)\b/,
  /\b(?:i am|i'm|i have|i've) (?:cc'?d|copied|copying|adding|forwarded|forwarding)\b/,
  /\b(?:cc'?ing|copying|adding) (?:my|our|in)\b/,
  /\bforward(?:ed|ing)? (?:this|your (?:e-?mail|message|note)) to\b/,
  /\b(?:please |kindly |you (?:can|could|may) )?(?:reach out|get in touch|connect|speak|talk|write|contact) (?:to |with )?(?:my colleague|our (?:hr|team|head|manager|ceo|founder)|the (?:hr|right) (?:team|person)|@)/,
  /\bthe right person (?:is|would be|to (?:speak|talk|contact))\b/,
  /\b(?:he|she|they) (?:is|are|will be) (?:the )?(?:right|best|better) (?:person|contact)\b/,
  /\b(?:kindly |please )?(?:reach out|write|contact|mail) (?:to |at )?[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/,
];

const WRONG_PERSON = [
  /\bno \w+ here\b/,
  /\b(?:i|we) (?:do not|don't|dont|no longer) (?:handle|deal with|manage|look after|take care of|work (?:in|on))\b/,
  /\b(?:i am|i'm|im) not (?:an? |the |in )?(?:hr|right person|correct person|person|decision ?maker|responsible|involved|handling)\b/,
  /\bnot (?:the )?(?:right|correct|relevant) (?:person|contact)\b/,
  /\bwrong (?:person|contact|e-?mail|address|company|business)\b/,
  /\bnot (?:my|in my) (?:area|department|role|domain|scope)\b/,
  /\bnot (?:handling|in charge of|responsible for)\b/,
];

const NEGATIVE = [
  /\bnot interested\b/,
  /\b(?:no|not) (?:very |really )?interest(?:ed|ing)?\b/,
  /\b(?:not|isn't|is not) (?:applicable|relevant)\b|\bnot in (?:any |a )?position to\b|\bpass on (?:this|that|it|the opportunity)\b(?! to\b)|\b(?:i'll|we'll|i will|we will) pass\s*(?:[.!,]|$)/,
  /\b(?:we are|we're|i am|i'm) (?:currently |already )?(?:all set|covered)\b|\ball set with\b/,
  /\b(?:keep|have) (?:your|the|this) (?:information|info|details|contact)\b.{0,20}\b(?:on file|on hand|in mind)\b|\bwill keep it on file\b/,
  /\b(?:taking care of|handle|handling|do) (?:this|it|that|everything)? ?in[- ]house\b/,
  /\bfuck\b|\bawful\b|\bscam\b/,
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
  // Cut at the start of the quoted thread. A reply that opens with the quote
  // has no new text of its own (our own email must not be read as theirs).
  const cut = t.search(/(?:^|\n)\s*(?:on .{4,80} wrote:|-{2,}\s*original message|from:\s.+\n\s*sent:|>)/i);
  if (cut >= 0) t = t.slice(0, cut);
  return t.replace(/\s+/g, " ").trim();
}

// Where someone's own words end and their signature or legal footer begins. A
// footer's "office hours are", "unsubscribe" or "do not reply" isn't what they said.
const FOOTER = /\b(?:kind |best |warm |warmest |with )?regards\b|\bsincerely\b|\bcheers,|\bsent from my\b|\bget outlook for\b|\bconfidential(?:ity)? (?:notice|statement|disclaimer)\b|\bdisclaimer\b|\bthis (?:e-?mail|message|communication)(?: and any (?:files|attachments))?(?: \w+){0,4} (?:confidential|privileged|intended)\b|\bthe information (?:contained|in this)\b|\bif you (?:are not the intended|received this)\b|\*{4,}/i;
export function withoutFooter(text: string) {
  const at = text.search(FOOTER);
  return at >= 8 ? text.slice(0, at).trim() : text;
}

/** Negative ones the list below misses: said politely, or put off for later. */
const SOFT_NO = [
  /\bnot @ this time\b|\bnot a problem (?:for|we)\b|\b(?:no|"?0"?) problems? with\b/,
  /\b(?:do not|don't) (?:have )?(?:any |a |and )?need\b|\b(?:do not|don't) plan (?:to|on)\b|\b(?:aren't|are not|am not) (?:currently )?looking\b/,
  /\bsold (?:the |my |our )?(?:company|business)\b|\bwhy lie\b|\beat my shorts\b/,
  /\b(?:we are|we're|i am|i'm) not (?:hiring|recruiting|buying|in the market|currently (?:looking|hiring|interested))\b/,
  /\bnot (?:right now|for us|for me|something (?:we|i)(?:'re| are| am)?)\b/,
  /\bno (?:thanks|thank you)\b|\b(?:we|i)(?:'ll| will) pass\b(?! (?:this|it|that|them|you|your|on|along))/,
  /\b(?:we|i) (?:already )?(?:have|use|work with) (?:a|an|our) (?:\w+ ){0,2}(?:provider|vendor|partner|agency|supplier|solution)\b/,
  /\bplease (?:do not|don't) (?:follow up|send|write)\b/,
];

export function classifyReply(body: string | null | undefined, subject?: string | null): ReplyClass {
  const whole = newText(body ?? "").toLowerCase();
  const text = withoutFooter(whole);
  // The subject only counts when it's the reply's own: "Automatic reply: …". Re: repeats our subject line.
  const subj = /^\s*(?:re|fw|fwd)\s*:/i.test(subject ?? "") ? "" : (subject ?? "").toLowerCase();
  const both = `${subj} ${text}`;
  if (OOO.some((r) => r.test(both))) return "ooo";
  if (AUTO.some((r) => r.test(both))) return "auto";
  if (UNSUBSCRIBE.some((r) => r.test(text))) return "unsubscribe";
  if (REFERRAL.some((r) => r.test(text))) return "referral";
  if (WRONG_PERSON.some((r) => r.test(text))) return "wrong_person";
  if (NEGATIVE.some((r) => r.test(text)) || SOFT_NO.some((r) => r.test(text))) return "negative";
  return "human";
}
