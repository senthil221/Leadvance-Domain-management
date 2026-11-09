"use client";

import { ArrowLeftRight, ChevronDown, CircleCheck, Download, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DomainLink } from "@/components/domains/DomainLink";
import { ReplaceDialog } from "@/components/domains/ReplaceDialog";
import { Select } from "@/components/Select";
import { Badge, ClientCell, Empty } from "@/components/ui";
import { DIAGNOSIS_ACTIONS, diagnosisCost, type DiagnosisAction, type StoredDiagnosis } from "@/lib/diagnose";
import { ago, int } from "@/lib/format";
import type { AiOpinion, ReplaceListData } from "@/lib/queries";
import { CALL_META, OUTCOME_META, outcomeOf, REPLACE_RULES, replaceCsv, type ReplaceCall, type ReplaceItem } from "@/lib/replace-list";

function download(name: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

const pct = (k: number, of: number) => { const v = of ? (100 * k) / of : 0; return `${v < 1 ? v.toFixed(2) : v.toFixed(1)}%`; };

// What the AI would have to say to back each call.
const AGREES: Record<ReplaceCall, DiagnosisAction[]> = {
  replace_now: ["replace", "rest"], replace: ["replace", "rest"], watch: ["lower_volume", "keep_sending", "wait_for_data"], fix: ["fix_setup"], list: ["check_lists"],
};

type Verdict = "agrees" | "disagrees" | "sooner" | null;
const verdictOf = (item: ReplaceItem, opinion: AiOpinion | undefined): Verdict => {
  if (!opinion) return null;
  if (AGREES[item.call].includes(opinion.action)) return "agrees";
  return item.call === "watch" && (opinion.action === "replace" || opinion.action === "rest") ? "sooner" : "disagrees";
};
const VERDICT: Record<Exclude<Verdict, null>, { label: string; tone: "success" | "warning" | "danger" }> = {
  agrees: { label: "AI agrees", tone: "success" },
  disagrees: { label: "AI disagrees", tone: "warning" },
  sooner: { label: "AI: replace now", tone: "danger" },
};

/** The three lists the page is made of. Replace now sits with Replace, and List problem with Fix first. */
const GROUPS: { key: string; title: string; calls: ReplaceCall[]; what: string; ai: boolean }[] = [
  { key: "replace", title: "Replace", calls: ["replace_now", "replace"], ai: true,
    what: "Clearly worse than the other domains on its Smartlead tag. Tick the ones the AI agrees on and replace them." },
  { key: "watch", title: "Watch", calls: ["watch"], ai: true,
    what: "Worse than the others, but not by enough yet. Leave them sending: they move to Replace on their own if it carries on." },
  { key: "fix", title: "Fix first", calls: ["fix", "list"], ai: false,
    what: "Don't replace these. Fix the setup, or re-verify the lead list, and the domain can stay." },
];

function Row({ item, opinion, ai, picked, onPick }: { item: ReplaceItem; opinion: AiOpinion | undefined; ai: boolean; picked: boolean; onPick?: () => void }) {
  const [open, setOpen] = useState(false);
  const verdict = verdictOf(item, opinion);
  const tag = item.call === "replace_now" || item.call === "list" ? CALL_META[item.call] : null;
  return (
    <li className="rs-row" data-open={open || undefined} data-selected={picked || undefined}>
      <span className="rs-check">
        {onPick ? (
          <input type="checkbox" className="checkbox" aria-label={`Select ${item.name}`} disabled={!item.canReplace}
            title={item.canReplace ? undefined : "A replacement is already running for it"} checked={picked} onChange={onPick} />
        ) : null}
      </span>
      <span className="rs-domain">
        <DomainLink id={item.domainId} className="fx-name">{item.name}</DomainLink>
        <span className="fx-sub">
          {item.clientId ? <Link href={`/clients/${item.clientId}`} className="hover:underline"><ClientCell name={item.clientName} hue={item.clientHue} /></Link> : <span className="zero">No client</span>}
          {item.tags ? <span className="fx-provider" title="Its Smartlead tag: the domains it's compared with">{item.tags}</span> : null}
        </span>
      </span>
      <span className="rs-why">
        {tag ? <Badge tone={tag.tone}>{tag.label}</Badge> : null}
        {item.reasons[0]}
      </span>
      <span className="rs-ai">
        {!ai ? null : verdict ? <Badge tone={VERDICT[verdict].tone}>{VERDICT[verdict].label}</Badge> : <span className="zero">Not reviewed</span>}
      </span>
      <button type="button" className="btn btn-icon btn-ghost rs-toggle" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} details for ${item.name}`} onClick={() => setOpen(!open)}>
        <ChevronDown size={15} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open ? (
        <div className="rs-more">
          <dl>
            <dt>Numbers</dt>
            <dd><ul>{item.reasons.map((r) => <li key={r}>{r}</li>)}</ul></dd>
            <dt>Next step</dt>
            <dd>{item.canReplace ? item.next : "A replacement is already running for it"}</dd>
            <dt>Sends</dt>
            <dd>{int(item.perDay)} a day</dd>
            {item.also.length ? <><dt>Also</dt><dd>{item.also.join(" · ")}</dd></> : null}
            {opinion ? <><dt>AI says</dt><dd><b>{DIAGNOSIS_ACTIONS[opinion.action]}.</b> {opinion.headline} <span className="rs-when">{ago(opinion.createdAt)}</span></dd></> : null}
          </dl>
        </div>
      ) : null}
    </li>
  );
}

/** Which sending domains to replace, from the last 7 days up to today. */
export function ReplaceList({ data }: { data: ReplaceListData }) {
  const router = useRouter();
  const [client, setClient] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [review, setReview] = useState<{ done: number; total: number } | null>(null);

  const shown = useMemo(() => data.items.filter((i) => !client || i.clientId === client), [data.items, client]);
  const opinions = useMemo(() => new Map(data.opinions.map((o) => [o.domainId, o])), [data.opinions]);
  const clients = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of data.items) if (i.clientId) m.set(i.clientId, i.clientName ?? "");
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data.items]);

  const groups = GROUPS.map((g) => ({ ...g, items: shown.filter((i) => g.calls.includes(i.call)) }));
  const [replace, watch, fix] = groups;
  const picked = data.items.filter((i) => selected.has(i.domainId) && i.canReplace);
  const agreed = replace.items.filter((i) => i.canReplace && verdictOf(i, opinions.get(i.domainId)) === "agrees");
  const toggle = (id: string) => setSelected((s) => { const next = new Set(s); if (next.has(id)) next.delete(id); else next.add(id); return next; });

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

  return (
    <>
      <section className="card rs-top" aria-label="Summary">
        <div className="rs-counts">
          <span><b className="is-danger">{int(replace.items.length)}</b> to replace</span>
          <span><b className="is-warning">{int(watch.items.length)}</b> to watch</span>
          <span><b>{int(fix.items.length)}</b> to fix first</span>
        </div>
        <p className="rs-sub">
          From the last 7 days up to today, so it&apos;s current whatever day you check
          {data.slSyncedAt ? <> · Smartlead synced {ago(data.slSyncedAt)}</> : null}
          {" "}· {int(data.healthy)} other domains are fine
        </p>
        <div className="rs-actions">
          <Select className="select fx-select" aria-label="Client" value={client} onChange={(e) => setClient(e.target.value)}>
            <option value="">All clients</option>
            {clients.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </Select>
          <button type="button" className="btn btn-primary" disabled={!candidates.length || !!review || !data.aiReady}
            title={!data.aiReady ? "Add OPENROUTER_API_KEY to the server's .env to turn this on" : "A second opinion on the Replace and Watch domains. Unchanged numbers cost nothing to ask again"}
            onClick={runReview}>
            <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" className={review ? "dx-spin" : undefined} />
            {review ? `Reviewing ${int(review.done)} of ${int(review.total)}…` : `Review with AI${unreviewed ? ` (${int(unreviewed)} new)` : ""}`}
          </button>
          {agreed.length ? (
            <button type="button" className="btn" title="Tick every Replace domain the AI agrees with" onClick={() => setSelected(new Set(agreed.map((i) => i.domainId)))}>
              <CircleCheck size={14} strokeWidth={1.75} aria-hidden="true" />Select the {int(agreed.length)} the AI agrees on
            </button>
          ) : null}
        </div>
      </section>

      {data.notes.length ? (
        <ul className="rp-notes" aria-label="Changes shared by a whole client or provider">
          {data.notes.map((g) => <li key={`${g.kind}|${g.id}|${g.text}`}><b>{g.name}</b>{g.text}</li>)}
        </ul>
      ) : null}

      {groups.map((g) => (
        <section key={g.key} className="card" aria-labelledby={`rs-${g.key}`}>
          <div className="card-head rs-head">
            <span className={`fx-mark rp-mark is-${g.key === "replace" ? "danger" : g.key === "watch" ? "warning" : "info"}`} aria-hidden="true" />
            <h2 id={`rs-${g.key}`} className="card-title">{g.title} <span className="num">{int(g.items.length)}</span></h2>
            <span className="card-sub">{g.what}</span>
          </div>
          {g.items.length ? (
            <ul className="rs-list">
              {g.items.map((i) => (
                <Row key={i.domainId} item={i} opinion={opinions.get(i.domainId)} ai={g.ai}
                  picked={selected.has(i.domainId)} onPick={g.key === "replace" ? () => toggle(i.domainId) : undefined} />
              ))}
            </ul>
          ) : (
            <p className="rp-meta">{g.key === "replace" ? "Nothing to replace right now." : "None."}</p>
          )}
        </section>
      ))}

      {!shown.length && !client ? (
        <Empty icon={CircleCheck} title="Nothing to replace">No live domain is clearly worse than the others it sends with.</Empty>
      ) : null}

      <details className="card rs-details">
        <summary>How domains get here, CSV and past replacements</summary>
        <div className="rs-details-body">
          <ul className="rs-rules">
            <li>Every live domain is compared with the other domains on its own Smartlead tag, over the last 7 days (14 for one that sends under {int(REPLACE_RULES.minSent)} a week).</li>
            <li><b>Replace</b>: spam, policy and block list bounces at {REPLACE_RULES.replaceRatio}× the others, or replies of any kind at half or less, or the domain is on a block list.</li>
            <li><b>Watch</b>: those bounces at {REPLACE_RULES.watchRatio}× the others. Two weeks running moves it to Replace.</li>
            <li><b>Fix first</b>: bad numbers, but its DNS, records or inboxes are failing. Or the bounces are addresses that don&apos;t exist, which is the list, not the domain.</li>
            <li>Warm-up reputation, domain age and a few quiet days never put a domain here. {int(data.early)} domains sent too little to judge.</li>
            <li>The AI never makes the call. It reads the same numbers and says whether it agrees.</li>
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
