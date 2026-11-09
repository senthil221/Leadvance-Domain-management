"use client";

import { ArrowLeftRight, CircleCheck, Download, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useMemo, useState } from "react";
import { toast } from "sonner";
import { DomainLink } from "@/components/domains/DomainLink";
import { ReplaceDialog } from "@/components/domains/ReplaceDialog";
import { Select } from "@/components/Select";
import { Badge, ClientCell, Empty } from "@/components/ui";
import { DIAGNOSIS_ACTIONS, diagnosisCost, type DiagnosisAction, type StoredDiagnosis } from "@/lib/diagnose";
import { ago, int } from "@/lib/format";
import type { AiOpinion, ReplaceListData } from "@/lib/queries";
import { CALL_META, CALLS, OUTCOME_META, outcomeOf, REPLACE_RULES, replaceCsv, replaceSummary, type ReplaceCall, type ReplaceItem } from "@/lib/replace-list";

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

/** The AI's last word on a domain, set against the call the rules made. */
function AiSays({ item, opinion }: { item: ReplaceItem; opinion: AiOpinion | undefined }) {
  if (!opinion) return <span className="zero">Not reviewed</span>;
  const agrees = AGREES[item.call].includes(opinion.action);
  const sooner = item.call === "watch" && (opinion.action === "replace" || opinion.action === "rest");
  return (
    <span className="rp-ai" title={opinion.headline}>
      <Badge tone={agrees ? "success" : "warning"}>{agrees ? "Agrees" : sooner ? "Would act now" : "Disagrees"}</Badge>
      <span className="rp-ai-text"><b>{DIAGNOSIS_ACTIONS[opinion.action]}.</b> {opinion.headline}</span>
      <span className="rp-ai-when">{ago(opinion.createdAt)}</span>
    </span>
  );
}

/** Which sending domains to replace this week, with the numbers behind each call. */
export function ReplaceList({ data }: { data: ReplaceListData }) {
  const router = useRouter();
  const [client, setClient] = useState("");
  const [provider, setProvider] = useState("");
  const [call, setCall] = useState<ReplaceCall | "all">("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [review, setReview] = useState<{ done: number; total: number } | null>(null);

  const scoped = useMemo(() => data.items.filter((i) =>
    (!client || i.clientId === client) && (!provider || i.provider === provider) && (!search || i.name.includes(search.trim().toLowerCase()))),
  [data.items, client, provider, search]);
  const summary = useMemo(() => replaceSummary(scoped), [scoped]);
  const shown = useMemo(() => scoped.filter((i) => call === "all" || i.call === call), [scoped, call]);
  const opinions = useMemo(() => new Map(data.opinions.map((o) => [o.domainId, o])), [data.opinions]);

  const clients = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of data.items) if (i.clientId) m.set(i.clientId, i.clientName ?? "");
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data.items]);
  const providers = useMemo(() => [...new Set(data.items.map((i) => i.provider).filter((x): x is string => !!x))].sort(), [data.items]);

  const picked = data.items.filter((i) => selected.has(i.domainId) && i.canReplace);
  const toReplace = shown.filter((i) => (i.call === "replace_now" || i.call === "replace") && i.canReplace);
  const allPicked = toReplace.length > 0 && toReplace.every((i) => selected.has(i.domainId));
  const toggle = (id: string) => setSelected((s) => { const next = new Set(s); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  // The AI only looks at the short list: the calls it could change.
  const candidates = shown.filter((i) => i.call === "replace_now" || i.call === "replace" || i.call === "watch");
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

  const calls = CALLS.filter((c) => shown.some((i) => i.call === c));
  const filtered = call !== "all" || client || provider || search;
  const judged = data.outcomes.map((o) => ({ ...o, outcome: outcomeOf(o) }));
  const settled = judged.filter((o) => o.outcome !== "early");

  return (
    <>
      <div className="stats is-5">
        {CALLS.map((c) => (
          <button key={c} type="button" className={`stat fx-stat${call === c ? " is-on" : ""}`} aria-pressed={call === c} onClick={() => setCall(call === c ? "all" : c)} title={CALL_META[c].hint}>
            <span className="stat-label"><span className={`fx-mark rp-mark is-${CALL_META[c].tone}`} aria-hidden="true" />{CALL_META[c].label}</span>
            <span className="stat-value">{int(summary[c].count)}</span>
            <span className="stat-foot">{summary[c].perDay ? `${int(summary[c].perDay)} emails a day` : "None"}</span>
          </button>
        ))}
      </div>

      {data.notes.length ? (
        <ul className="rp-notes" aria-label="Changes shared by a whole client or provider">
          {data.notes.map((g) => (
            <li key={`${g.kind}|${g.id}|${g.text}`}><b>{g.name}</b>{g.text}</li>
          ))}
        </ul>
      ) : null}

      <section className="card" aria-labelledby="rp-title">
        <div className="fx-bar">
          <Select className="select fx-select" aria-label="Client" value={client} onChange={(e) => setClient(e.target.value)}>
            <option value="">All clients</option>
            {clients.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </Select>
          <Select className="select fx-select" aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="">All providers</option>
            {providers.map((x) => <option key={x} value={x}>{x}</option>)}
          </Select>
          <input className="input fx-search" type="search" placeholder="Find a domain" aria-label="Find a domain" value={search} onChange={(e) => setSearch(e.target.value)} />
          <span className="fx-actions">
            <button type="button" className="btn btn-sm" disabled={!candidates.length || !!review || !data.aiReady}
              title={!data.aiReady ? "Add OPENROUTER_API_KEY to the server's .env to turn this on" : "Ask the AI for a second opinion on the Replace and Watch domains shown. Unchanged numbers cost nothing to ask again"}
              onClick={runReview}>
              <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" className={review ? "dx-spin" : undefined} />
              {review ? `Reviewing ${int(review.done)} of ${int(review.total)}…` : `Review with AI (${int(candidates.length)})`}
            </button>
            <button type="button" className="btn btn-sm" disabled={!shown.length} onClick={() => download("replace-list.csv", replaceCsv(shown))}>
              <Download size={14} strokeWidth={1.75} aria-hidden="true" />CSV
            </button>
          </span>
        </div>

        <p className="rp-meta">
          Looked at {int(data.judged)} live sending domains over the last 7 days (14 for those that send little), each against the other domains on its own Smartlead tag.{" "}
          <b>{int(data.healthy)}</b> have nothing against them and <b>{int(data.early)}</b> sent under {int(REPLACE_RULES.minSent)} in 14 days, too few to judge.
        </p>

        <h2 id="rp-title" className="sr-only">Domains to replace or watch</h2>

        {shown.length ? (
          <div className="table-scroll">
            <table className="data-table fx-table rp-table">
              <thead>
                <tr>
                  <th className="col-check">
                    <input type="checkbox" className="checkbox" aria-label="Select every domain to replace" disabled={!toReplace.length} checked={allPicked}
                      onChange={() => setSelected((s) => { const next = new Set(s); toReplace.forEach((i) => (allPicked ? next.delete(i.domainId) : next.add(i.domainId))); return next; })} />
                  </th>
                  <th>Domain</th><th>Why</th><th>Next step</th>
                  <th className="is-num" title="What it sends on a day it sends">Sends a day</th>
                  <th>AI second opinion</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c) => (
                  <Fragment key={c}>
                    <tr className="fx-tier"><th colSpan={6} scope="rowgroup"><span className={`fx-mark rp-mark is-${CALL_META[c].tone}`} aria-hidden="true" />{CALL_META[c].label}<span className="fx-tier-hint">{CALL_META[c].hint}</span></th></tr>
                    {shown.filter((i) => i.call === c).map((i) => (
                      <tr key={i.domainId} data-selected={selected.has(i.domainId)}>
                        <td className="col-check">
                          <input type="checkbox" className="checkbox" aria-label={`Select ${i.name}`} disabled={!i.canReplace} title={i.canReplace ? undefined : "A replacement is already running for it"}
                            checked={selected.has(i.domainId)} onChange={() => toggle(i.domainId)} />
                        </td>
                        <td className="fx-domain">
                          <DomainLink id={i.domainId} className="fx-name">{i.name}</DomainLink>
                          <span className="fx-sub">
                            {i.clientId ? <Link href={`/clients/${i.clientId}`} className="hover:underline"><ClientCell name={i.clientName} hue={i.clientHue} /></Link> : <span className="zero">No client</span>}
                            {i.tags ? <span className="fx-provider" title="Its Smartlead tag: the group it's compared with">{i.tags}</span> : i.provider ? <span className="fx-provider">{i.provider}</span> : null}
                          </span>
                        </td>
                        <td className="fx-problem rp-why">
                          <ul>{i.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
                          {i.also.length ? <span className="fx-also">{i.also.map((a) => <span key={a} className="fx-chip">{a}</span>)}</span> : null}
                        </td>
                        <td className="fx-next rp-next">{i.canReplace ? i.next : "A replacement is already running for it"}</td>
                        <td className="is-num"><span className="num">{int(i.perDay)}</span></td>
                        <td className="rp-ai-cell"><AiSays item={i} opinion={opinions.get(i.domainId)} /></td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={CircleCheck} title={filtered ? "Nothing matches" : "Nothing to replace"}>
            {filtered ? "Nothing here with these filters." : "No live domain is clearly worse this week than the others it sends with."}
          </Empty>
        )}
      </section>

      <section className="card" aria-labelledby="rp-out-title">
        <div className="card-head">
          <h2 id="rp-out-title" className="card-title">Did past replacements pay off?</h2>
          <span className="card-sub">
            {settled.length
              ? `${int(settled.filter((o) => o.outcome === "better").length)} better, ${int(settled.filter((o) => o.outcome === "worse").length)} worse, ${int(settled.filter((o) => o.outcome === "same" || o.outcome === "mixed").length)} about the same`
              : "the old domain's last 14 days against the new one's first six weeks"}
            {judged.length > settled.length ? ` · ${int(judged.length - settled.length)} too early to tell` : ""}
          </span>
        </div>
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
          <p className="rp-meta">
            {judged.length
              ? `None of the ${int(judged.length)} replacements in the last 90 days can be judged yet: the new domain needs ${int(REPLACE_RULES.minSent)} emails sent, and so did the old one in its last 14 days.`
              : "No replacements in the last 90 days."}
          </p>
        )}
      </section>

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
