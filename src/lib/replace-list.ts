import { zScore } from "./compare";
import { problemsOf, type FixFact, type FixKind } from "./fix-queue";

// Which sending domains to replace, from this week's numbers. A domain is
// compared with the other domains on its own Smartlead tag (the same client,
// campaigns and mail provider), so a bad list or a bad week for everyone
// doesn't get a good domain replaced. A whole tag that's clearly worse than
// everyone else is flagged too, and its domains are then judged against the
// healthy tags instead of each other, so a tag that's bad all over can't hide
// its own domains. Shared by server and client.
//
// What the rules rest on (39 days of this agency's own data, November 2026):
// spam, policy and block list bounces repeat on the same domain week to week,
// and so does a clear gap in replies of any kind. Human reply rate for one
// domain, warm-up reputation, domain age and a few quiet days did not, so none
// of those can put a domain on this list.

export type ReplaceCall = "replace_now" | "replace" | "watch" | "fix" | "list";
export const CALLS: ReplaceCall[] = ["replace_now", "replace", "watch", "fix", "list"];
export const CALL_META: Record<ReplaceCall, { label: string; tone: "danger" | "warning" | "info"; hint: string }> = {
  replace_now: { label: "Replace now", tone: "danger", hint: "On a block list: it won't recover while it's sending" },
  replace: { label: "Replace", tone: "danger", hint: "Clearly worse than the other domains it sends with, over the last 7 days (14 for a domain that sends little)" },
  watch: { label: "Watch", tone: "warning", hint: "Worse than the other domains it sends with, but not by enough to replace yet. It moves to Replace if it repeats or gets worse" },
  fix: { label: "Fix first", tone: "warning", hint: "Its numbers are bad, but its own setup is failing: fix that before spending a replacement" },
  list: { label: "List problem", tone: "info", hint: "Its bounces are addresses that don't exist: re-verify the list, the domain is fine" },
};

export const REPLACE_RULES = {
  /** Sent in the week before the domain is judged on it. With less, the last 14 days are judged as one, and under this in 14 days it isn't judged at all. */
  minSent: 300,
  /** Bounces of a kind before their rate means anything. */
  minBounces: 5,
  /** Spam, policy and block list bounces against the others: Replace on one week. */
  replaceRatio: 3,
  /** The same, lower: Watch, and Replace when the week before was over it too. */
  watchRatio: 2,
  /** A tag weak on those bounces at watchRatio stays weak until it falls under this, so it doesn't flip its domains week to week. */
  tagKeepRatio: 1.5,
  /** Replies of any kind at or under this share of the others' rate. */
  replyRatio: 0.5,
  /** Standard errors apart before a gap counts as real. */
  z: 2.6,
  /** What the others on its tag must have sent in the week to compare with them; under it the client's others are used, then all live domains. */
  peerSent: 1000,
  /** Days of sending before the window began: replies trail sends, so a domain that has just started always looks quiet. */
  settledDays: 7,
};

/** Bounces that blame the sender. Addresses that don't exist blame the list, and full mailboxes nobody. */
export const SENDER_CAUSES = ["spam", "policy", "blocklist"] as const;

/** A domain's last two weeks: see REPLACE_STATS_SQL. */
export type ReplaceStat = {
  domainId: string; tld: string | null;
  /** Its inboxes' Smartlead tags, joined: the group it sends with. Null when it has none. */
  tags: string | null;
  sent7: number; replies7: number; sentPrev: number; repliesPrev: number; sent14: number; replies14: number;
  sender7: number; senderPrev: number; missing7: number; missingPrev: number; bounces7: number;
  /** Yesterday alone: sent, replies of any kind, every bounce, and the bounces that blame the sender. */
  sentY: number; repliesY: number; bouncesY: number; senderY: number;
  /** Days since it first sent anything. */ sendingDays: number | null;
  beingReplaced: boolean;
};

export type ReplaceItem = {
  domainId: string; name: string; tld: string | null; tags: string | null; status: string; clientId: string | null; clientName: string | null; clientHue: number | null; provider: string | null;
  call: ReplaceCall;
  /** The numbers behind the call, most important first. */ reasons: string[];
  /** The same in a few words, for one line of a table: "Spam/block bounces 2.3% vs 0.16% · 14.0×". */ short: string;
  next: string;
  /** Smaller things worth knowing that didn't decide the call. */ also: string[];
  sent7: number; perDay: number;
  /** Replace isn't offered while a replacement is already running. */ canReplace: boolean;
};

export type GroupNote = { kind: "client" | "provider" | "tag"; id: string; name: string; text: string };

/** Every live sending domain, with its call and its numbers, for the page that shows them all. */
export type DomainRow = {
  domainId: string; name: string; clientId: string | null; clientName: string | null; clientHue: number | null; tags: string | null;
  call: ReplaceCall | "keep" | "early";
  /** Why, in a few words: empty for a domain with nothing against it. */ short: string;
  /** Its own numbers are fine, but its whole tag is worse than everyone: what the tag shows. */ weakTag: string | null;
  sentY: number; repliesY: number; bouncesY: number; senderY: number;
  sent7: number; replies7: number; sender7: number; bounces7: number;
};

export type ReplaceList = {
  items: ReplaceItem[];
  notes: GroupNote[];
  /** Live sending domains looked at, those with nothing against them, and those that sent too little to judge. */
  judged: number; healthy: number; early: number;
  /** Every live domain's call, for the pages that show one domain. */
  /** tagNotes: what the domain's whole tag shows, when it's weak. Numbers only, no names, so it can go to the AI. */
  calls: Map<string, { call: ReplaceCall | "keep" | "early"; reasons: string[]; tagNotes?: string[] }>;
  /** Every live domain, worst first. */
  domains: DomainRow[];
  /** Tags weak on spam, policy and block list bounces now: keep them for the next run as wasWeak. */
  weakBounceTags: string[];
};

const R = REPLACE_RULES;
const n = (v: number) => Math.round(v).toLocaleString("en-US");
const p = (k: number, of: number) => { const v = of ? (100 * k) / of : 0; return `${v < 1 ? v.toFixed(2) : v.toFixed(1)}%`; };
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

type Sums = { domains: number; sent7: number; replies7: number; sentPrev: number; repliesPrev: number; sent14: number; replies14: number; sender7: number; senderPrev: number; missing7: number };
const zero = (): Sums => ({ domains: 0, sent7: 0, replies7: 0, sentPrev: 0, repliesPrev: 0, sent14: 0, replies14: 0, sender7: 0, senderPrev: 0, missing7: 0 });
const KEYS = ["sent7", "replies7", "sentPrev", "repliesPrev", "sent14", "replies14", "sender7", "senderPrev", "missing7"] as const;
const plus = (a: Sums, s: ReplaceStat) => { a.domains++; for (const k of KEYS) a[k] += s[k]; };
const minus = (a: Sums, s: ReplaceStat): Sums => { const out = { ...a, domains: a.domains - 1 }; for (const k of KEYS) out[k] -= s[k]; return out; };
const sub = (a: Sums, b: Sums): Sums => { const out = { ...a, domains: a.domains - b.domains }; for (const k of KEYS) out[k] -= b[k]; return out; };

/** The group a domain sends with: its client and its Smartlead tags. */
const tagKey = (f: FixFact, s: ReplaceStat) => (f.clientId && s.tags ? `${f.clientId}|${s.tags}` : null);

/** Sent enough to judge: in the week, or failing that across the fortnight. Half the fleet sends too little for a week alone. */
const judgeable = (s: ReplaceStat | undefined): s is ReplaceStat => !!s && (s.sent7 >= R.minSent || s.sent14 >= R.minSent);

/** A domain that's meant to be sending: connected, with a live order, and not already on its way out. */
const isLive = (f: FixFact) => f.standing === "active" && f.orderLive && (f.status === "active" || f.status === "warming") && f.connected > 0;

/** Clearly more of something than the others: over the ratio, enough of them to count, and too far apart to be chance. */
const over = (k: number, of: number, peerK: number, peerOf: number, ratio: number) =>
  of >= R.minSent && peerOf >= R.minSent && k >= R.minBounces && k / of >= ratio * (peerK / peerOf) && zScore(k, of, peerK, peerOf) >= R.z;
// Rounded down, so a Watch at 2.96 times never reads as the 3.0 that would have replaced it.
const times = (k: number, of: number, peerK: number, peerOf: number) => (peerK ? `${(Math.floor((10 * k * peerOf) / (of * peerK) + 1e-9) / 10).toFixed(1)}×` : "against none on");

/** Setup failures that explain bad numbers on their own: replacing wouldn't be judging the domain. */
const BLOCKING: FixKind[] = ["dns_down", "dns_records", "tenant", "disconnected"];

/**
 * The list. Each live sending domain is compared with its client's other live
 * domains over the same days; when those sent too little, with all live domains.
 */
/** wasWeak: the tags weak on bounces last time, which stay weak until they fall under tagKeepRatio. */
export function replaceList(facts: FixFact[], stats: ReplaceStat[], passes: 1 | 2 = 2, wasWeak: ReadonlySet<string> = new Set()): ReplaceList {
  const statOf = new Map(stats.map((s) => [s.domainId, s]));
  const live = facts.filter(isLive);
  const clientNames = new Map(live.filter((f) => f.clientId).map((f) => [f.clientId!, f.clientName ?? ""]));
  const totals = (skip: ReadonlySet<string>) => {
    const all = zero();
    const byClient = new Map<string, Sums>();
    const byTag = new Map<string, Sums>();
    const byProvider = new Map<string, Sums>();
    const into = (m: Map<string, Sums>, key: string | null, s: ReplaceStat) => {
      if (!key) return;
      if (!m.has(key)) m.set(key, zero());
      plus(m.get(key)!, s);
    };
    for (const f of live) {
      const s = statOf.get(f.domainId);
      if (!s || skip.has(f.domainId)) continue;
      plus(all, s);
      into(byClient, f.clientId, s);
      into(byTag, tagKey(f, s), s);
      into(byProvider, f.provider, s);
    }
    return { all, byClient, byTag, byProvider };
  };
  const everyone = totals(new Set());

  // Whole tags worse than everyone else. Spam, policy and block list bounces are set
  // against every other live domain: they blame the sender wherever it sends. Replies
  // are set against the client's other domains, which send its offer to its lists.
  // replies: what the tag shows, for its domains' rows. They aren't judged on it one by one.
  type WeakTag = { bounces: boolean; replies: string | null };
  const tagNotes: GroupNote[] = [];
  const weakTags = new Map<string, WeakTag>();
  const tagTexts = new Map<string, string[]>();
  const noteTag = (key: string, text: string) => tagTexts.set(key, [...(tagTexts.get(key) ?? []), text]);
  for (const [key, g] of everyone.byTag) {
    if (g.domains < 2 || g.sent7 < R.peerSent) continue;
    const clientId = key.slice(0, key.indexOf("|"));
    const fleet = sub(everyone.all, g);
    const own = everyone.byClient.get(clientId);
    const client = own ? sub(own, g) : null;
    const base = client && client.sent7 >= R.peerSent ? client : fleet;
    const name = `${clientNames.get(clientId) || "A client"} · ${key.slice(key.indexOf("|") + 1)}`;
    const fresh = over(g.sender7, g.sent7, fleet.sender7, fleet.sent7, R.watchRatio);
    const kept = !fresh && wasWeak.has(key) && over(g.sender7, g.sent7, fleet.sender7, fleet.sent7, R.tagKeepRatio);
    const bounces = g.sender7 >= 2 * R.minBounces && (fresh || kept);
    const replies = base.replies7 > 0 && base.sent7 >= R.peerSent && g.replies7 / g.sent7 <= R.replyRatio * (base.replies7 / base.sent7)
      && zScore(g.replies7, g.sent7, base.replies7, base.sent7) <= -R.z;
    if (!bounces && !replies) continue;
    weakTags.set(key, { bounces, replies: replies ? `Tag replies ${p(g.replies7, g.sent7)} vs ${p(base.replies7, base.sent7)}` : null });
    const across = `across its ${n(g.domains)} domains`;
    const before = g.sentPrev >= R.minSent ? ` (${p(g.senderPrev, g.sentPrev)} the week before)` : "";
    if (bounces) {
      tagNotes.push({ kind: "tag", id: key, name, text: `Spam, policy and block list bounces ${p(g.sender7, g.sent7)} ${across}${before}, ${times(g.sender7, g.sent7, fleet.sender7, fleet.sent7)} all other live domains (${p(fleet.sender7, fleet.sent7)}). Its domains are judged against the healthy tags instead of each other${kept ? `, and stay so until it falls under ${R.tagKeepRatio}×` : ""}. Check the links in its copy before replacing many of them` });
      noteTag(key, tagNotes[tagNotes.length - 1].text);
    }
    if (replies) {
      const quietBounces = g.sender7 / g.sent7 <= fleet.sender7 / Math.max(1, fleet.sent7);
      tagNotes.push({ kind: "tag", id: key, name, text: `Replies of any kind ${p(g.replies7, g.sent7)} ${across}, against ${p(base.replies7, base.sent7)} for ${base === client ? "the client's other domains" : "all other live domains"}.${quietBounces ? " With so few bounces the mail is delivered but not answered: likely the spam folder. Test placement on a few before replacing them all" : ""}` });
      noteTag(key, tagNotes[tagNotes.length - 1].text);
    }
  }
  // Left out of the healthy baseline: every domain on a weak tag, whichever way it's weak.
  const weakIds = new Set(live.filter((f) => { const s = statOf.get(f.domainId); const k = s ? tagKey(f, s) : null; return !!k && weakTags.has(k); }).map((f) => f.domainId));

  // What a domain's own numbers say, set against the others. Run twice: the
  // second time the others leave out every domain the first pass flagged, so
  // two bad domains in one client can't make each other look normal.
  type Perf = { perf: { call: "replace" | "watch"; reasons: string[]; short: string[]; weekly: boolean } | null; badList: { text: string; short: string } | null };
  const measure = (f: FixFact, s: ReplaceStat | undefined, sums: ReturnType<typeof totals>, skip: ReadonlySet<string>, clean: ReturnType<typeof totals>): Perf => {
    let perf: Perf["perf"] = null;
    let badList: Perf["badList"] = null;
    if (judgeable(s)) {
      const without = (g: Sums) => (skip.has(f.domainId) ? g : minus(g, s));
      // Like with like: the same tag first, then the client, then everyone.
      const enough = (g: Sums | undefined) => { const peers = g ? without(g) : null; return peers && peers.sent7 >= R.peerSent ? peers : null; };
      const key = tagKey(f, s);
      const onTag = key ? enough(sums.byTag.get(key)) : null;
      const inClient = onTag ? null : enough(f.clientId ? sums.byClient.get(f.clientId) : undefined);
      const peers = onTag ?? inClient ?? without(sums.all);
      const who = onTag ? "the other domains on its tag" : inClient ? "the client's other domains" : "all other live domains";
      // On a tag whose spam, policy and block list bounces are high all over, the others share
      // the problem: those are set against the healthy tags instead. Replies aren't, since a tag
      // can rightly get fewer (Outlook inboxes, a harder offer): a weak tag on replies only gets a note.
      const fair = !!key && !!weakTags.get(key)?.bounces && clean.all.sent7 >= R.peerSent;
      const bPeers = fair ? clean.all : peers, bWho = fair ? "live domains on healthy tags" : who;
      const rPeers = peers, rWho = who;

      const reasons: string[] = [];
      const short: string[] = [];
      const bounces = (text: string) => `Spam, policy and block list bounces ${text}`;
      // Too little in a week to say anything: the fortnight is judged as one window, by the same test.
      const weekly = s.sent7 >= R.minSent;
      const k = weekly ? s.sender7 : s.sender7 + s.senderPrev, of = weekly ? s.sent7 : s.sent14;
      const peerK = weekly ? bPeers.sender7 : bPeers.sender7 + bPeers.senderPrev, peerOf = weekly ? bPeers.sent7 : bPeers.sent14;
      const thisWeek = over(k, of, peerK, peerOf, R.watchRatio);
      const lastWeek = weekly && over(s.senderPrev, s.sentPrev, bPeers.senderPrev, bPeers.sentPrev, R.watchRatio);
      // On a thin fortnight a handful of bounces can be one strict company refusing five people, so it takes twice as many to replace.
      const heavy = over(k, of, peerK, peerOf, R.replaceRatio) && (weekly || k >= 2 * R.minBounces);
      if (thisWeek) {
        reasons.push(bounces(`${p(k, of)} of ${n(of)} sent in ${weekly ? 7 : 14} days, ${times(k, of, peerK, peerOf)} ${bWho} (${p(peerK, peerOf)})`));
        if (lastWeek) reasons.push(`The week before too: ${p(s.senderPrev, s.sentPrev)} against ${p(bPeers.senderPrev, bPeers.sentPrev)}`);
        short.push(`Spam/block bounces ${p(k, of)} vs ${p(peerK, peerOf)} · ${times(k, of, peerK, peerOf)}${weekly ? "" : " · 14 days"}${lastWeek ? " · 2 weeks running" : ""}`);
      }

      // Replies of any kind, out of office included: five times the signal of human replies, and they only come back from mail that landed.
      const quiet = (k: number, of: number, peerK: number, peerOf: number, days: number) =>
        of >= R.minSent && peerOf >= R.minSent && peerK > 0 && s.sendingDays != null && s.sendingDays >= days + R.settledDays
        && k / of <= R.replyRatio * (peerK / peerOf) && zScore(k, of, peerK, peerOf) <= -R.z;
      const quiet7 = weekly && quiet(s.replies7, s.sent7, rPeers.replies7, rPeers.sent7, 7);
      const quiet14 = !quiet7 && quiet(s.replies14, s.sent14, rPeers.replies14, rPeers.sent14, 14);
      if (quiet7) reasons.push(`Replies of any kind ${p(s.replies7, s.sent7)} of ${n(s.sent7)} sent in 7 days, ${rWho} got ${p(rPeers.replies7, rPeers.sent7)}`);
      if (quiet14) reasons.push(`Replies of any kind ${p(s.replies14, s.sent14)} of ${n(s.sent14)} sent in 14 days, ${rWho} got ${p(rPeers.replies14, rPeers.sent14)}`);
      if (quiet7) short.push(`Replies ${p(s.replies7, s.sent7)} vs ${p(rPeers.replies7, rPeers.sent7)}`);
      if (quiet14) short.push(`Replies ${p(s.replies14, s.sent14)} vs ${p(rPeers.replies14, rPeers.sent14)} · 14 days`);

      if (heavy || (thisWeek && lastWeek) || quiet7 || quiet14) perf = { call: "replace", reasons, short, weekly };
      else if (thisWeek) perf = { call: "watch", reasons, short, weekly };

      if (over(s.missing7, s.sent7, peers.missing7, peers.sent7, R.watchRatio) && s.missing7 >= 0.5 * s.bounces7) {
        badList = {
          text: `${plural(s.missing7, "bounce")} to addresses that don't exist, ${p(s.missing7, s.sent7)} of ${n(s.sent7)} sent against ${p(peers.missing7, peers.sent7)} for ${who}`,
          short: `Bad addresses ${p(s.missing7, s.sent7)} vs ${p(peers.missing7, peers.sent7)}`,
        };
      }
    }
    return { perf, badList };
  };
  const none = new Set<string>();
  const clean1 = weakIds.size ? totals(weakIds) : everyone;
  const worst = new Set(passes === 1 ? [] : live.filter((f) => measure(f, statOf.get(f.domainId), everyone, none, clean1).perf).map((f) => f.domainId));
  const rest = worst.size ? totals(worst) : everyone;
  const clean = worst.size || weakIds.size ? totals(new Set([...worst, ...weakIds])) : everyone;
  const domains: DomainRow[] = [];

  const items: ReplaceItem[] = [];
  const calls: ReplaceList["calls"] = new Map();
  let healthy = 0, early = 0;
  // Per client: how many domains sent enough to judge, and how many the numbers went against.
  const tally = new Map<string, { judged: number; flagged: number }>();

  for (const f of live) {
    const s = statOf.get(f.domainId);
    const base = {
      domainId: f.domainId, name: f.name, tld: s?.tld ?? null, tags: s?.tags ?? null, status: f.status, clientId: f.clientId, clientName: f.clientName, clientHue: f.clientHue, provider: f.provider,
      sent7: s?.sent7 ?? 0, perDay: f.daysSent ? Math.round(f.sent7 / f.daysSent) : 0, canReplace: !(s?.beingReplaced ?? false),
    };
    const put = (call: ReplaceCall, reasons: string[], shortList: string[], next: string, also: string[] = []) => {
      short = shortList.join(" · ");
      items.push({ ...base, call, reasons: reasons.slice(0, 3), short, next, also });
      const onWeak = k ? tagTexts.get(k) : undefined;
      calls.set(f.domainId, { call, reasons: reasons.slice(0, 3), ...(onWeak ? { tagNotes: onWeak } : {}) });
      row(call);
    };

    const { perf, badList } = measure(f, s, rest, worst, clean);
    const k = s ? tagKey(f, s) : null;
    // A tag high on bounces had its domains judged against the healthy tags already: only few replies is left to say.
    const weakTag = (k && weakTags.get(k)?.replies) || null;
    let short = "";
    const row = (call: DomainRow["call"]) => domains.push({
      domainId: f.domainId, name: f.name, clientId: f.clientId, clientName: f.clientName, clientHue: f.clientHue, tags: s?.tags ?? null, call, short, weakTag,
      sentY: s?.sentY ?? 0, repliesY: s?.repliesY ?? 0, bouncesY: s?.bouncesY ?? 0, senderY: s?.senderY ?? 0,
      sent7: s?.sent7 ?? 0, replies7: s?.replies7 ?? 0, sender7: s?.sender7 ?? 0, bounces7: s?.bounces7 ?? 0,
    });
    const fortnight = s?.sent14 ?? 0;
    if (f.clientId && judgeable(s)) {
      const t = tally.get(f.clientId) ?? { judged: 0, flagged: 0 };
      t.judged++;
      if (perf) t.flagged++;
      tally.set(f.clientId, t);
    }

    const problems = problemsOf(f);
    const blocking = problems.filter((x) => BLOCKING.includes(x.kind) && x.tier !== "watch");
    // A listed domain is Replace now, and says so in its reasons already.
    const minor = problems.filter((x) => !blocking.includes(x) && !(x.kind === "blocklisted" && f.listed > 0)).map((x) => x.label);
    const also = [...(badList && perf ? ["Bad list too"] : []), ...minor];

    if (f.listed > 0) {
      put("replace_now", [`On ${plural(f.listed, "block list")}`, ...(perf?.reasons ?? [])], [`On ${plural(f.listed, "block list")}`, ...(perf?.short ?? [])], "Replace it now, and check the links in the copy it was sending", also);
    } else if (perf && blocking.length) {
      put("fix", [...blocking.map((x) => `${x.label}: ${x.evidence}`), ...perf.reasons], [...blocking.map((x) => x.label), ...perf.short], `${blocking[0].next}. Then see whether its numbers recover`, also);
    } else if (perf?.call === "replace") {
      put("replace", perf.reasons, perf.short, "Replace it this week", also);
    } else if (perf) {
      put("watch", perf.reasons, perf.short, perf.weekly ? "Leave it sending. It moves to Replace if next week is the same" : "Leave it sending. It sends too little to be sure yet, and moves to Replace if the bounces keep coming", also);
    } else if (badList) {
      put("list", [badList.text], [badList.short], "Re-verify the list it's sending to. The domain itself looks fine", minor);
    } else if (!judgeable(s)) {
      early++;
      calls.set(f.domainId, { call: "early", reasons: [`${n(fortnight)} sent in 14 days, under the ${n(R.minSent)} needed to judge it`] });
      short = `${n(fortnight)} sent in 14 days`;
      row("early");
    } else {
      healthy++;
      calls.set(f.domainId, { call: "keep", reasons: [s.sent7 >= R.minSent ? `Nothing against it on ${n(s.sent7)} sent in 7 days` : `Nothing against it on ${n(s.sent14)} sent in 14 days`] });
      row("keep");
    }
  }

  const rank = new Map(CALLS.map((c, i) => [c, i]));
  items.sort((a, b) => rank.get(a.call)! - rank.get(b.call)! || b.perDay - a.perDay || a.name.localeCompare(b.name));

  // A change everyone shares isn't any one domain's fault. The flagged domains are
  // left out, so one bad domain can't pass for a change across the whole client.
  const notes: GroupNote[] = [...tagNotes];
  const shared = (kind: GroupNote["kind"], id: string, name: string, g: Sums, whole: number) => {
    if (g.domains < 2 || g.sent7 < R.peerSent || g.sentPrev < R.peerSent) return;
    const across = `across ${kind === "client" ? "its" : "all"} ${n(g.domains)} ${g.domains < whole ? "other " : ""}domains`;
    if (g.repliesPrev > 0 && g.replies7 / g.sent7 <= R.replyRatio * (g.repliesPrev / g.sentPrev) && zScore(g.replies7, g.sent7, g.repliesPrev, g.sentPrev) <= -R.z) {
      notes.push({ kind, id, name, text: `Replies of any kind fell from ${p(g.repliesPrev, g.sentPrev)} to ${p(g.replies7, g.sent7)} ${across}. Check the list and copy before replacing domains` });
    }
    if (g.sender7 >= 2 * R.minBounces && g.sender7 / g.sent7 >= R.watchRatio * (g.senderPrev / g.sentPrev) && zScore(g.sender7, g.sent7, g.senderPrev, g.sentPrev) >= R.z) {
      notes.push({ kind, id, name, text: `Spam, policy and block list bounces rose from ${p(g.senderPrev, g.sentPrev)} to ${p(g.sender7, g.sent7)} ${across}. That points at ${kind === "client" ? "the list or copy" : "the provider"}, not single domains` });
    }
  };
  for (const [id, g] of rest.byClient) shared("client", id, clientNames.get(id) || "A client", g, everyone.byClient.get(id)!.domains);
  // Many of one client's domains going wrong together is rarely the domains.
  for (const [id, t] of tally) {
    if (t.flagged >= 3 && t.flagged * 3 >= t.judged) {
      notes.push({ kind: "client", id, name: clientNames.get(id) || "A client", text: `${n(t.flagged)} of its ${n(t.judged)} sending domains are flagged at once. Check which campaign they share before replacing them: it's more likely the list or copy` });
    }
  }
  for (const [id, g] of rest.byProvider) shared("provider", id, id, g, everyone.byProvider.get(id)!.domains);

  domains.sort((a, b) => severity(a) - severity(b) || b.sent7 - a.sent7 || a.name.localeCompare(b.name));
  const weakBounceTags = [...weakTags].filter(([, w]) => w.bounces).map(([k]) => k);
  return { items, notes, judged: live.length, healthy, early, calls, domains, weakBounceTags };
}

/** How bad a domain's standing is, worst first: its call, then a weak tag, then nothing against it, then too little to judge. */
export type Severity = ReplaceCall | "weak" | "ok" | "early";
export const SEVERITY_ORDER: Severity[] = ["replace_now", "replace", "fix", "watch", "weak", "list", "ok", "early"];
export const SEVERITY_META: Record<Severity, { label: string; tone: "danger" | "warning" | "info" | "success" | "faint"; hint: string }> = {
  ...CALL_META,
  weak: { label: "Weak tag", tone: "warning", hint: "Its own numbers are like its tag's, but the whole tag is clearly worse than everyone else. See the note at the top" },
  ok: { label: "OK", tone: "success", hint: "Nothing against it over the last 7 days" },
  early: { label: "Too little", tone: "faint", hint: "Sent too little in 14 days to judge" },
};
export const severityOf = (d: Pick<DomainRow, "call" | "weakTag">): Severity => (d.call === "keep" ? (d.weakTag ? "weak" : "ok") : d.call);
const severity = (d: DomainRow) => SEVERITY_ORDER.indexOf(severityOf(d));

/** How many domains got each call. */
export function replaceSummary(items: ReplaceItem[]) {
  const counts = Object.fromEntries(CALLS.map((c) => [c, { count: 0, perDay: 0 }])) as Record<ReplaceCall, { count: number; perDay: number }>;
  for (const i of items) { counts[i.call].count++; counts[i.call].perDay += i.perDay; }
  return counts;
}

/** CSV of the list, as it's filtered. */
export function replaceCsv(items: ReplaceItem[]) {
  const esc = (v: string | number | null) => { const s = v == null ? "" : String(v); return /^[=+\-@]/.test(s) ? `'${s}` : /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ["Domain", "Client", "Tag", "Provider", "Call", "Why", "Next step", "Sent in 7 days", "Sends a day", "Also"];
  return [head.join(","), ...items.map((i) => [i.name, i.clientName, i.tags, i.provider, CALL_META[i.call].label, i.reasons.join("; "), i.next, i.sent7, i.perDay, i.also.join("; ")].map(esc).join(","))].join("\n");
}

/**
 * Every domain that sent in the last 14 days: this week, the week before, and
 * what its bounces blamed. Plain SQL with no parameters, so it runs the same in
 * the app and the tests.
 */
export const REPLACE_STATS_SQL = `
  with t as (
    select z, (now() at time zone z)::date as today
    from (select coalesce((select value #>> '{}' from settings where key = 'stats_timezone'), 'UTC') as z) x
  ), s as (
    select s.domain_id,
      coalesce(sum(s.sent) filter (where s.day > t.today - 7), 0)::int as sent7,
      coalesce(sum(s.replies) filter (where s.day > t.today - 7), 0)::int as replies7,
      coalesce(sum(s.sent) filter (where s.day <= t.today - 7), 0)::int as sent_prev,
      coalesce(sum(s.replies) filter (where s.day <= t.today - 7), 0)::int as replies_prev,
      coalesce(sum(s.sent), 0)::int as sent14, coalesce(sum(s.replies), 0)::int as replies14,
      coalesce(sum(s.sent) filter (where s.day = t.today - 1), 0)::int as sent_y,
      coalesce(sum(s.replies) filter (where s.day = t.today - 1), 0)::int as replies_y,
      coalesce(sum(s.bounces) filter (where s.day = t.today - 1), 0)::int as bounces_y
    from domain_daily_stats s cross join t where s.day > t.today - 14 and s.day <= t.today group by 1
  ), f as (
    select domain_id, min(day) as first_sent from domain_daily_stats where sent > 0 group by 1
  ), tg as (
    -- The tags that say which group it sends with, without the ones that only mark where it is in its life.
    select i.domain_id, array_to_string(array_agg(distinct lower(trim(tag)) order by lower(trim(tag))), ' + ') as tags
    from inboxes i cross join lateral unnest(i.smartlead_tags) tag
    where i.status <> 'removed' and trim(tag) <> '' and lower(trim(tag)) not in ('replaced', 'new', 'free')
    group by 1
  ), ev as (
    select e.domain_id,
      (count(*) filter (where e.recent and e.sender))::int as sender7,
      (count(*) filter (where not e.recent and e.sender))::int as sender_prev,
      (count(*) filter (where e.recent and e.bounce_cause = 'missing'))::int as missing7,
      (count(*) filter (where not e.recent and e.bounce_cause = 'missing'))::int as missing_prev,
      (count(*) filter (where e.recent))::int as bounces7,
      (count(*) filter (where e.yesterday and e.sender))::int as sender_y
    from (
      select e.domain_id, e.bounce_cause, e.occurred_at >= ((t.today - 6)::timestamp at time zone t.z) as recent,
        e.occurred_at >= ((t.today - 1)::timestamp at time zone t.z) and e.occurred_at < (t.today::timestamp at time zone t.z) as yesterday,
        coalesce(e.bounce_cause in (${SENDER_CAUSES.map((c) => `'${c}'`).join(", ")}), false) as sender
      from email_events e cross join t
      where e.kind = 'bounce' and e.domain_id is not null and e.occurred_at >= ((t.today - 13)::timestamp at time zone t.z)
    ) e group by 1
  )
  select s.domain_id, d.tld, tg.tags, s.sent7, s.replies7, s.sent_prev, s.replies_prev, s.sent14, s.replies14,
    coalesce(ev.sender7, 0) as sender7, coalesce(ev.sender_prev, 0) as sender_prev, coalesce(ev.missing7, 0) as missing7,
    coalesce(ev.missing_prev, 0) as missing_prev, coalesce(ev.bounces7, 0) as bounces7,
    s.sent_y, s.replies_y, s.bounces_y, coalesce(ev.sender_y, 0) as sender_y,
    (t.today - f.first_sent)::int as sending_days, domain_being_replaced(d.id) as being_replaced
  from s join domains d on d.id = s.domain_id cross join t
  left join f on f.domain_id = s.domain_id
  left join ev on ev.domain_id = s.domain_id
  left join tg on tg.domain_id = s.domain_id
  where s.sent14 > 0`;

/** A past replacement: the old domain's last 14 days against the new one's first six weeks. See REPLACE_OUTCOMES_SQL. */
export type OutcomeRow = {
  oldId: string; oldName: string; newId: string; newName: string; clientName: string | null; clientHue: number | null; day: string;
  oldSent: number; oldReplies: number; oldBounces: number; newSent: number; newReplies: number; newBounces: number;
};
export type Outcome = "better" | "worse" | "mixed" | "same" | "early";
export const OUTCOME_META: Record<Outcome, { label: string; tone: "success" | "danger" | "warning" | "faint" }> = {
  better: { label: "Better", tone: "success" },
  worse: { label: "Worse", tone: "danger" },
  mixed: { label: "Mixed", tone: "warning" },
  same: { label: "No real change", tone: "faint" },
  early: { label: "Too early", tone: "faint" },
};

/** Whether the new domain did better than the one it replaced, once both have sent enough to tell. */
export function outcomeOf(r: OutcomeRow): Outcome {
  if (r.oldSent < R.minSent || r.newSent < R.minSent) return "early";
  const bounces = zScore(r.newBounces, r.newSent, r.oldBounces, r.oldSent);
  const replies = zScore(r.newReplies, r.newSent, r.oldReplies, r.oldSent);
  const good = bounces <= -2 || replies >= 2, bad = bounces >= 2 || replies <= -2;
  return good && bad ? "mixed" : good ? "better" : bad ? "worse" : "same";
}

export const REPLACE_OUTCOMES_SQL = `
  select i.old_domain_id as old_id, od.name as old_name, i.new_domain_id as new_id, nd.name as new_name, c.name as client_name, c.hue as client_hue,
    to_char(x.day, 'YYYY-MM-DD') as day,
    coalesce(o.sent, 0)::int as old_sent, coalesce(o.replies, 0)::int as old_replies, coalesce(o.bounces, 0)::int as old_bounces,
    coalesce(w.sent, 0)::int as new_sent, coalesce(w.replies, 0)::int as new_replies, coalesce(w.bounces, 0)::int as new_bounces
  from replacement_items i
  join replacement_batches b on b.id = i.batch_id and b.status <> 'cancelled'
  join domains od on od.id = i.old_domain_id
  join domains nd on nd.id = i.new_domain_id
  left join clients c on c.id = coalesce(nd.client_id, od.client_id)
  cross join lateral (select coalesce(i.completed_at, i.created_at)::date as day) x
  left join lateral (
    select sum(s.sent) as sent, sum(s.replies) as replies, sum(s.bounces) as bounces from domain_daily_stats s
    where s.domain_id = i.old_domain_id and s.day >= x.day - 14 and s.day < x.day
  ) o on true
  left join lateral (
    select sum(s.sent) as sent, sum(s.replies) as replies, sum(s.bounces) as bounces from domain_daily_stats s
    where s.domain_id = i.new_domain_id and s.day >= x.day and s.day < x.day + 42
  ) w on true
  where i.created_at > now() - interval '90 days'
  order by x.day desc, od.name`;
