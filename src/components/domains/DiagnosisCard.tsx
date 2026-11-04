"use client";

import { Check, RefreshCw, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { markDiagnosis } from "@/app/actions";
import { Badge } from "@/components/ui";
import { DIAGNOSIS_ACTIONS, DIAGNOSIS_VERDICTS, diagnosisCost, type StoredDiagnosis } from "@/lib/diagnose";
import { ago } from "@/lib/format";

/** Asks the AI why this domain is or isn't performing. It only advises: nothing here changes the domain. */
export function DiagnosisCard({ domainId, initial }: { domainId: string; initial: StoredDiagnosis | null }) {
  const [diagnosis, setDiagnosis] = useState(initial);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/domains/${domainId}/diagnose`, { method: "POST" });
      const body = await res.json().catch(() => null) as { ok: true; diagnosis: StoredDiagnosis; reused: boolean } | { ok: false; error: string } | null;
      if (!body) setError("Something went wrong. Nothing was saved.");
      else if (!body.ok) setError(body.error);
      else {
        setDiagnosis(body.diagnosis);
        if (body.reused) toast("Nothing has changed since this answer, so it wasn't run again");
      }
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setRunning(false);
    }
  };

  const mark = async (feedback: "right" | "wrong") => {
    if (!diagnosis) return;
    const next = diagnosis.feedback === feedback ? null : feedback;
    const before = diagnosis;
    setDiagnosis({ ...diagnosis, feedback: next });
    const r = await markDiagnosis({ id: diagnosis.id, feedback: next });
    if (!r.ok) { setDiagnosis(before); toast.error(r.error); }
  };

  const button = (
    <button type="button" className="btn btn-sm" disabled={running} onClick={run}>
      {diagnosis ? <RefreshCw size={13} strokeWidth={1.75} aria-hidden="true" className={running ? "dx-spin" : undefined} /> : <Sparkles size={13} strokeWidth={1.75} aria-hidden="true" className={running ? "dx-spin" : undefined} />}
      {running ? "Reading the numbers…" : diagnosis ? "Run again" : "Diagnose"}
    </button>
  );
  const r = diagnosis?.result;
  const cost = diagnosis ? diagnosisCost(diagnosis) : null;

  return (
    <section className="card" aria-label="Diagnosis">
      <div className="card-head">
        <span className="card-title">Diagnosis</span>
        <span className="dx-head-action">{button}</span>
      </div>
      <div className="card-body dx-body">
        {error ? <p className="dx-error" role="alert">{error}</p> : null}
        {!r ? (
          <p className="dx-intro">Reads this domain&apos;s numbers against the client&apos;s other domains and says why it is or isn&apos;t performing, with the numbers behind each reason. It only advises, and can take up to a minute.</p>
        ) : (
          <>
            <div className="dx-verdict">
              <Badge tone={DIAGNOSIS_VERDICTS[r.verdict].tone}>{DIAGNOSIS_VERDICTS[r.verdict].label}</Badge>
              {diagnosis.model ? <span className="dx-sure">{r.confidence === "high" ? "Fairly sure" : r.confidence === "medium" ? "Somewhat sure" : "Not very sure"}</span> : null}
            </div>
            <p className="dx-headline">{r.headline}</p>

            {r.reasons.length ? (
              <ul className="dx-reasons">
                {r.reasons.map((reason, i) => (
                  <li key={i}>
                    <span>{reason.claim}</span>
                    <span className="dx-facts">
                      {reason.facts.map((f) => <span key={f.path} className="dx-fact">{f.label} <b>{f.value}</b></span>)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            <dl className="dx-plan">
              <div><dt>What to do</dt><dd><b>{DIAGNOSIS_ACTIONS[r.action]}.</b> {r.next}</dd></div>
              <div><dt>What would prove this wrong</dt><dd>{r.wouldChange}</dd></div>
              {r.cannotSee.length ? <div><dt>What it can&apos;t see</dt><dd>{r.cannotSee.join("; ")}</dd></div> : null}
            </dl>

            <div className="dx-foot">
              <span>
                {diagnosis.model ? "AI" : "Rules, no AI used"} · {ago(diagnosis.createdAt)}
                {cost != null ? ` · about $${cost < 0.01 ? "0.01" : cost.toFixed(2)}` : ""}
              </span>
              {diagnosis.model ? (
                <span className="dx-mark" role="group" aria-label="Was this right?">
                  <span>Was this right?</span>
                  <button type="button" className="btn btn-sm" aria-pressed={diagnosis.feedback === "right"} onClick={() => mark("right")}><Check size={13} strokeWidth={1.75} aria-hidden="true" />Right</button>
                  <button type="button" className="btn btn-sm" aria-pressed={diagnosis.feedback === "wrong"} onClick={() => mark("wrong")}><X size={13} strokeWidth={1.75} aria-hidden="true" />Wrong</button>
                </span>
              ) : null}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
