"use client";

import { ArrowLeftRight, ChevronDown, CircleCheck, Download, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { Fragment, useMemo, useState } from "react";
import { toast } from "sonner";
import { DomainLink } from "@/components/domains/DomainLink";
import { ReplaceDialog } from "@/components/domains/ReplaceDialog";
import { AllDomains } from "@/components/replace/AllDomains";
import { Select } from "@/components/Select";
import { Badge, ClientCell } from "@/components/ui";
import { DIAGNOSIS_ACTIONS, diagnosisCost, type DiagnosisAction, type StoredDiagnosis } from "@/lib/diagnose-meta";
import { ago, int } from "@/lib/format";
import type { AiOpinion, ReplaceListData } from "@/lib/queries";
import { OUTCOME_META, outcomeOf, REPLACE_RULES, replaceCsv, type GroupNote, type ReplaceCall, type ReplaceItem, type ReplyRate } from "@/lib/replace-list";

function download(name: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

const pct = (k: number, of: number) => { const v = of ? (100 * k) / of : 0; return `${v < 1 ? v.toFixed(2) : v.toFixed(1)}%`; };

// What the AI would have to say to back each call.
const AGREES: Record<ReplaceCall, DiagnosisAction[]> = {
  replace_now: ["replace", "rest"], replace: ["replace", "rest"],
  // Watch means "not yet": any step short of replacing backs it, checking the lists or the setup included.
  watch: ["lower_volume", "keep_sending", "wait_for_data", "check_lists", "fix_setup"], fix: ["fix_setup"], list: ["check_lists"],
};

type Verdict = "agrees" | "disagrees" | "sooner";
const verdictOf = (item: ReplaceItem, opinion: AiOpinion | undefined): Verdict | null => {
  if (!opinion) return null;
  if (AGREES[item.call].includes(opinion.action)) return "agrees";
  return item.call === "watch" && (opinion.action === "replace" || opinion.action === "rest") ? "sooner" : "disagrees";
};
const VERDICT: Record<Verdict, { label: string; tone: "success" | "warning" | "danger" }> = {
  agrees: { label: "Agrees", tone: "success" },
  disagrees: { label: "Disagrees", tone: "warning" },
  sooner: { label: "Replace now", tone: "danger" },
};

type GroupKey = "replace" | "watch" | "fix" | "running";
/** The groups the table is made of. Replace now sits with Replace, List problem with Fix first, and a domain already being replaced sits apart, never counted twice. */
const GROUPS: { key: GroupKey; title: string; tone: "danger" | "warning" | "info" | "faint"; calls: ReplaceCall[]; what: string; ai: boolean }[] = [
  { key: "replace", title: "Replace", tone: "danger", calls: ["replace_now", "replace"], ai: true, what: "Clearly worse than the domains it's compared with" },
  { key: "watch", title: "Watch", tone: "warning", calls: ["watch"], ai: true, what: "Worse, not by enough yet. Moves to Replace on its own if it carries on" },
  { key: "fix", title: "Fix first", tone: "info", calls: ["fix", "list"], ai: false, what: "Don't replace: fix the setup, or re-verify the lead list" },
  { key: "running", title: "Being replaced", tone: "faint", calls: [], ai: false, what: "A replacement is already running, so it can't be picked again" },
];
const COLS = 7;

/** Human and out-of-office replies against the others': the replies that show its mail is reaching people. */
function Replies({ r }: { r: ReplyRate | null }) {
  if (!r) return <span className="rq-faint">Too little mail</span>;
  const good = r.human + r.ooo, peer = r.peerHuman + r.peerOoo;
  const share = r.peerSent && peer ? good / r.sent / (peer / r.peerSent) : null;
  const tone = r.healthy ? "is-success" : share != null && share <= REPLACE_RULES.replyRatio ? "is-danger" : "";
  const title = `${int(r.human)} human and ${int(r.ooo)} out-of-office ${good === 1 ? "reply" : "replies"} on ${int(r.sent)} sent in ${r.days} days. `
    + `${r.who[0].toUpperCase()}${r.who.slice(1)}: ${pct(peer, r.peerSent)} (${pct(r.peerHuman, r.peerSent)} human, ${pct(r.peerOoo, r.peerSent)} out-of-office)`
    + (r.healthy ? ". As good as the others or better, so its mail is landing" : "");
  return (
    <span className="rq-replies" title={title}>
      <span className={`rq-head ${tone}`}>{pct(good, r.sent)}<span className="rq-vs">vs {pct(peer, r.peerSent)}</span></span>
      <span className="rq-sub">{pct(r.human, r.sent)} human · {pct(r.ooo, r.sent)} OOO{r.days === 14 ? " · 14d" : ""}</span>
    </span>
  );
}

function Row({ item, opinion, ai, picked, onPick }: { item: ReplaceItem; opinion: AiOpinion | undefined; ai: boolean; picked: boolean; onPick?: () => void }) {
  const [open, setOpen] = useState(false);
  const verdict = verdictOf(item, opinion);
  return (
    <>
      <tr className="rq-row" data-open={open || undefined} data-selected={picked || undefined} onClick={(e) => { if (!(e.target as HTMLElement).closest("a,input,button")) setOpen(!open); }}>
        <td className="col-check">
          {onPick ? <input type="checkbox" className="checkbox" aria-label={`Select ${item.name}`} checked={picked} onChange={onPick} /> : null}
        </td>
        <td className="rq-domain">
          <DomainLink id={item.domainId} className="rq-name">{item.name}</DomainLink>
          <span className="rq-sub rq-who">
            {item.clientId ? <ClientCell name={item.clientName} hue={item.clientHue} /> : "No client"}
            {item.tags ? <span className="rq-tag" title="Its Smartlead tag: the domains it's compared with">{item.tags}</span> : null}
          </span>
        </td>
        <td className="rq-signal">
          {item.signals.length ? item.signals.map((s) => (
            <span key={s.head} className="rq-sig">
              <span className={`rq-head is-${s.tone}`}>{s.head}</span>
              <span className="rq-sub">{s.detail}</span>
            </span>
          )) : <span className="rq-sub">{item.short}</span>}
        </td>
        <td className="rq-reply-cell"><Replies r={item.replies} /></td>
        <td className="is-num num rq-day">{int(item.perDay)}</td>
        <td className="rq-ai" title={opinion ? `${DIAGNOSIS_ACTIONS[opinion.action]}. ${opinion.headline}` : undefined}>
          {!ai ? null : verdict && opinion ? (
            <>
              <Badge tone={VERDICT[verdict].tone}>{VERDICT[verdict].label}</Badge>
              <span className="rq-sub">{DIAGNOSIS_ACTIONS[opinion.action]}</span>
            </>
          ) : <span className="rq-faint">Not reviewed</span>}
        </td>
        <td className="rq-toggle-cell">
          <button type="button" className="btn btn-sm btn-icon btn-ghost rq-toggle" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} details for ${item.name}`} onClick={() => setOpen(!open)}>
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </td>
      </tr>
      {open ? (
        <tr className="rq-detail">
          <td />
          <td colSpan={COLS - 1}>
            <dl>
              <dt>Numbers</dt>
              <dd>{item.signals.length ? item.signals.map((s) => <span key={s.head} className="rq-line"><b>{s.head}</b> · {s.detail}</span>) : item.reasons.join(". ")}</dd>
              {item.replies ? <><dt>Replies</dt><dd>{int(item.replies.human)} human and {int(item.replies.ooo)} out-of-office on {int(item.replies.sent)} sent in {item.replies.days} days: {pct(item.replies.human + item.replies.ooo, item.replies.sent)}, against {pct(item.replies.peerHuman + item.replies.peerOoo, item.replies.peerSent)} for {item.replies.who}</dd></> : null}
              <dt>Next step</dt><dd>{item.canReplace ? item.next : "A replacement is already running for it"}</dd>
              {item.also.length ? <><dt>Also</dt><dd>{item.also.join(" · ")}</dd></> : null}
              {opinion ? <><dt>AI says</dt><dd><b>{DIAGNOSIS_ACTIONS[opinion.action]}.</b> {opinion.headline} <span className="rq-faint">{ago(opinion.createdAt)}</span></dd></> : null}
            </dl>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** Whole tags and clients doing badly: one line each, the full note on opening it. */
function Alerts({ notes }: { notes: GroupNote[] }) {
  if (!notes.length) return null;
  return (
    <div className="rq-alerts" aria-label="Whole tags and clients">
      <div className="rq-label">Whole tags and clients <span>{int(notes.length)}</span></div>
      {notes.map((g) => (
        <div key={`${g.kind}|${g.id}|${g.short}`} className="rq-alert">
          <div className="rq-alert-line">
            <span className={`rq-dot is-${g.kind === "tag" ? "danger" : "warning"}`} aria-hidden="true" />
            <b>{g.name}</b>
            <span className="rq-alert-what">{g.short}</span>
            <span className="rq-alert-do">{g.action}</span>
          </div>
          <p>{g.text}</p>
        </div>
      ))}
    </div>
  );
}

/** Which sending domains to replace, from the last 7 days up to today. */
export function ReplaceList({ data }: { data: ReplaceListData }) {
  const router = useRouter();
  const [client, setClient] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [review, setReview] = useState<{ done: number; total: number } | null>(null);
  // What needs doing, or every live domain with yesterday beside the last 7 days.
  const [view, setView] = useState<"act" | "all">("act");
  // One group only, picked from its tile.
  const [focus, setFocus] = useState<GroupKey | null>(null);

  const everyDomain = useMemo(() => data.domains.filter((d) => !client || d.clientId === client), [data.domains, client]);
  const shown = useMemo(() => data.items.filter((i) => !client || i.clientId === client), [data.items, client]);
  const opinions = useMemo(() => new Map(data.opinions.map((o) => [o.domainId, o])), [data.opinions]);
  const clients = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of data.items) if (i.clientId) m.set(i.clientId, i.clientName ?? "");
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data.items]);
  const notes = data.notes.filter((g) => !client || (g.kind !== "client" && g.kind !== "tag") || g.id === client || g.id.startsWith(`${client}|`));

  const groups = GROUPS.map((g) => ({
    ...g,
    items: shown.filter((i) => (g.key === "running" ? !i.canReplace : i.canReplace && g.calls.includes(i.call))),
  }));
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g])) as Record<GroupKey, (typeof groups)[number]>;
  const { replace, watch } = byKey;
  const picked = data.items.filter((i) => selected.has(i.domainId) && i.canReplace);
  const agreed = replace.items.filter((i) => verdictOf(i, opinions.get(i.domainId)) === "agrees");
  const toggle = (id: string) => setSelected((s) => { const next = new Set(s); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const agreeCount = (items: ReplaceItem[]) => items.filter((i) => verdictOf(i, opinions.get(i.domainId)) === "agrees").length;
  const reviewedCount = (items: ReplaceItem[]) => items.filter((i) => opinions.has(i.domainId)).length;

  // The AI only looks at Replace and Watch: the calls it could change.
  const candidates = [...replace.items, ...watch.items];
  const unreviewed = candidates.filter((i) => !opinions.has(i.domainId)).length;
  const runReview = async () => {
    const queue = [...candidates];
    let done = 0, cost = 0, asked = 0, failed = "";
    setReview({ done, total: queue.length });
    const worker = async () => {
      for (let item = queue.shift(); item && !failed; item = queue.shift()) {
        try {
          const res = await fetch(`/api/domains/${item.domainId}/diagnose`, { method: "POST" });
          const body = await res.json().catch(() => null) as { ok: true; diagnosis: StoredDiagnosis; reused: boolean } | { ok: false; error: string } | null;
          if (!body) failed = "Something went wrong. Try again.";
          else if (!body.ok) failed = body.error;
          else if (!body.reused && body.diagnosis.model) { asked++; cost += body.diagnosis.costUsd ?? 0; }
        } catch {
          failed = "Couldn't reach the server. Try again.";
        }
        setReview({ done: ++done, total: candidates.length });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    setReview(null);
    if (failed) toast.error(failed);
    else toast.success(asked ? `Reviewed ${int(candidates.length)} domains${diagnosisCost(cost) ? ` for ${diagnosisCost(cost)}` : ""}` : "Nothing has changed since the last review, so it cost nothing");
    router.refresh();
  };

  const judged = data.outcomes.map((o) => ({ ...o, outcome: outcomeOf(o) }));
  const settled = judged.filter((o) => o.outcome !== "early");
  const tileSub: Record<GroupKey, string> = {
    replace: replace.items.length ? (reviewedCount(replace.items) ? `AI agrees with ${int(agreeCount(replace.items))}` : "Not reviewed by AI yet") : "Nothing to replace",
    watch: watch.items.length ? (reviewedCount(watch.items) ? `AI agrees with ${int(agreeCount(watch.items))}` : "Leave sending for now") : "Nothing to watch",
    fix: byKey.fix.items.length ? "Setup or list first" : "Nothing to fix",
    running: "Already in progress",
  };
  const visible = groups.filter((g) => (focus ? g.key === focus : g.items.length || g.key !== "running"));

  return (
    <>
      <section className="card rq" aria-label="Replace list">
        <div className="rq-top">
          <span className="view-tabs rq-tabs" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={view === "act"} className={view === "act" ? "is-on" : undefined} onClick={() => setView("act")}>To act on</button>
            <button type="button" role="tab" aria-selected={view === "all"} className={view === "all" ? "is-on" : undefined} onClick={() => setView("all")}>All domains <span>{int(everyDomain.length)}</span></button>
          </span>
          <span className="rq-sync" title="Every number is the last 7 days up to today, so the list is current whatever day you check">
            Last 7 days{data.slSyncedAt ? ` · synced ${ago(data.slSyncedAt)}` : ""}
          </span>
          <span className="rq-actions">
            <Select className="select fx-select" aria-label="Client" value={client} onChange={(e) => setClient(e.target.value)}>
              <option value="">All clients</option>
              {clients.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </Select>
            <button type="button" className="btn btn-sm btn-primary" disabled={!candidates.length || !!review || !data.aiReady}
              title={!data.aiReady ? "Add OPENROUTER_API_KEY to the server's .env to turn this on" : "A second opinion on every Replace and Watch domain. Unchanged numbers cost nothing to ask again"}
              onClick={runReview}>
              <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" className={review ? "dx-spin" : undefined} />
              {review ? `${int(review.done)} of ${int(review.total)}…` : `Review with AI${unreviewed ? ` (${int(unreviewed)})` : ""}`}
            </button>
          </span>
        </div>

        {view === "all" ? <AllDomains domains={everyDomain} /> : (
          <>
            <div className="rq-tiles" role="group" aria-label="Show one group">
              {groups.filter((g) => g.key !== "running" || g.items.length).map((g) => (
                <div key={g.key} className={`rq-tile is-${g.tone}`} data-on={focus === g.key || undefined}>
                  <button type="button" className="rq-tile-main" aria-pressed={focus === g.key} title={g.what} onClick={() => setFocus(focus === g.key ? null : g.key)}>
                    <span className="rq-tile-title">{g.title}</span>
                    <span className="rq-tile-n">{int(g.items.length)}</span>
                    <span className="rq-tile-sub">{tileSub[g.key]}</span>
                  </button>
                  {g.key === "replace" && agreed.length ? (
                    <button type="button" className="btn btn-sm rq-tile-act" title="Tick every Replace domain the AI agrees with" onClick={() => setSelected(new Set(agreed.map((i) => i.domainId)))}>
                      <CircleCheck size={14} strokeWidth={1.75} aria-hidden="true" />Select {int(agreed.length)} agreed
                    </button>
                  ) : null}
                </div>
              ))}
            </div>

            <Alerts notes={notes} />

            <div className="table-scroll">
              <table className="data-table rq-table">
                <thead>
                  <tr>
                    <th className="col-check" />
                    <th>Domain</th>
                    <th title="What's wrong, and the number it's compared with: its Smartlead tag, the client's other domains, or the healthy tags when its whole tag is bad">What&apos;s wrong</th>
                    <th title="Human and out-of-office replies, share of sent, against the others it's compared with. Green: as good as the others or better, so its mail is landing and its bounces alone won't replace it">Replies</th>
                    <th className="is-num" title="What it sends on a day it sends">A day</th>
                    <th title="The AI's second opinion. Hover for what it said">AI</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((g) => (
                    <Fragment key={g.key}>
                      <tr className="rq-group">
                        <th colSpan={COLS} scope="rowgroup">
                          <span className={`rq-dot is-${g.tone}`} aria-hidden="true" />{g.title}<span className="rq-group-n">{int(g.items.length)}</span>
                          <span className="rq-group-what">{g.what}</span>
                        </th>
                      </tr>
                      {g.items.length ? g.items.map((i) => (
                        <Row key={i.domainId} item={i} opinion={opinions.get(i.domainId)} ai={g.ai}
                          picked={selected.has(i.domainId)} onPick={g.key === "replace" ? () => toggle(i.domainId) : undefined} />
                      )) : (
                        <tr><td /><td colSpan={COLS - 1} className="rq-faint rq-none">None</td></tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <details className="card rs-details">
        <summary>How domains get here, CSV and past replacements</summary>
        <div className="rs-details-body">
          <ul className="rs-rules">
            <li>Every live domain is compared with the other domains on its own Smartlead tag, over the last 7 days (14 for one that sends under {int(REPLACE_RULES.minSent)} a week). When the whole tag is bad, with the healthy tags instead. {int(data.healthy)} are fine and {int(data.early)} sent too little to judge.</li>
            <li><b>Replace</b>: spam, policy and block list bounces at {REPLACE_RULES.replaceRatio}× the others, or replies of any kind at half or less, or the domain is on a block list.</li>
            <li><b>Watch</b>: those bounces at {REPLACE_RULES.watchRatio}× the others. Two weeks running moves it to Replace.</li>
            <li><b>Replies holding up</b>: a domain whose human and out-of-office replies are as good as the others&apos; (at least {int(REPLACE_RULES.minGoodReplies)} of them) is reaching people, so high bounces alone keep it on Watch instead of replacing it. A block list, few replies, or bounces at {REPLACE_RULES.severeRatio}× the others or more still replace it.</li>
            <li><b>Fix first</b>: bad numbers, but its DNS, records or inboxes are failing. Or the bounces are addresses that don&apos;t exist, which is the list, not the domain.</li>
            <li><b>Being replaced</b>: a replacement is already running. A domain whose replacement finished is draining or burned, so it never comes back here.</li>
            <li>Warm-up reputation, domain age and a few quiet days never put a domain here. The AI never makes the call: it reads the same numbers and says whether it agrees.</li>
          </ul>
          <button type="button" className="btn btn-sm" disabled={!shown.length} onClick={() => download("replace-list.csv", replaceCsv(shown))}>
            <Download size={14} strokeWidth={1.75} aria-hidden="true" />Download CSV
          </button>

          <h3 className="rs-h3">Did past replacements pay off?</h3>
          {settled.length ? (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr><th>Replaced</th><th>Old domain</th><th>New domain</th><th className="is-num">Bounces</th><th className="is-num">Replies of any kind</th><th>Result</th></tr>
                </thead>
                <tbody>
                  {settled.map((o) => (
                    <tr key={`${o.oldId}|${o.newId}`}>
                      <td className="num">{new Date(`${o.day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}</td>
                      <td><DomainLink id={o.oldId} className="hover:underline">{o.oldName}</DomainLink></td>
                      <td><DomainLink id={o.newId} className="hover:underline">{o.newName}</DomainLink></td>
                      <td className="is-num num" title={`${int(o.oldSent)} sent before, ${int(o.newSent)} since`}>{pct(o.oldBounces, o.oldSent)} → {pct(o.newBounces, o.newSent)}</td>
                      <td className="is-num num">{pct(o.oldReplies, o.oldSent)} → {pct(o.newReplies, o.newSent)}</td>
                      <td><Badge tone={OUTCOME_META[o.outcome].tone}>{OUTCOME_META[o.outcome].label}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="rs-note">
              {judged.length
                ? `None of the ${int(judged.length)} replacements in the last 90 days can be judged yet: the new domain needs ${int(REPLACE_RULES.minSent)} emails sent first.`
                : "No replacements in the last 90 days."}
            </p>
          )}
        </div>
      </details>

      {selected.size > 0 ? (
        <div className="bulk-bar" role="toolbar" aria-label="Selected domains">
          <span className="bulk-count">{int(selected.size)} selected</span>
          <button type="button" className="btn btn-sm btn-primary" disabled={!picked.length} title="Swap the selected domains for free ones" onClick={() => setReplaceOpen(true)}>
            <ArrowLeftRight size={14} /> Replace{picked.length ? ` (${int(picked.length)})` : ""}
          </button>
          <span className="sep" />
          <button type="button" className="btn btn-sm" aria-label="Clear selection" onClick={() => setSelected(new Set())}><X size={14} /></button>
        </div>
      ) : null}

      <ReplaceDialog
        open={replaceOpen}
        onOpenChange={setReplaceOpen}
        defaultReason={picked.some((i) => i.reasons[0]?.startsWith("Replies")) && !picked.some((i) => !i.reasons[0]?.startsWith("Replies")) ? "low_replies" : "high_bounce"}
        targets={picked.map((i) => ({ id: i.domainId, name: i.name, tld: i.tld, clientName: i.clientName, clientHue: i.clientHue }))}
        onDone={() => { setSelected(new Set()); router.refresh(); }}
      />
    </>
  );
}
