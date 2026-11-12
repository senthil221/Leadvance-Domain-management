// What the diagnosis card and the Replace list show: labels, the stored shape
// and the cost line. Kept apart from diagnose.ts so the browser doesn't load
// its schema library (zod) and the rules behind a diagnosis.

export const VERDICT_KEYS = ["healthy", "watch", "underperforming", "failing", "not_enough_data"] as const;
export type DiagnosisVerdict = (typeof VERDICT_KEYS)[number];
export const DIAGNOSIS_VERDICTS: Record<DiagnosisVerdict, { label: string; tone: "success" | "info" | "warning" | "danger" | "faint" }> = {
  healthy: { label: "Healthy", tone: "success" },
  watch: { label: "Keep an eye on it", tone: "info" },
  underperforming: { label: "Underperforming", tone: "warning" },
  failing: { label: "Failing", tone: "danger" },
  not_enough_data: { label: "Not enough data", tone: "faint" },
};

export const ACTION_KEYS = ["keep_sending", "lower_volume", "rest", "replace", "fix_setup", "check_lists", "wait_for_data"] as const;
export type DiagnosisAction = (typeof ACTION_KEYS)[number];
export const DIAGNOSIS_ACTIONS: Record<DiagnosisAction, string> = {
  keep_sending: "Keep sending",
  lower_volume: "Lower its volume",
  rest: "Rest it",
  replace: "Replace it",
  fix_setup: "Fix the setup",
  check_lists: "Check the lists and copy",
  wait_for_data: "Wait for more data",
};

export type CitedFact = { path: string; label: string; value: string };

/** A checked answer: every reason points at the numbers it rests on. diagnose.ts's schema must match it. */
export type Diagnosis = {
  verdict: DiagnosisVerdict;
  headline: string;
  confidence: "low" | "medium" | "high";
  reasons: { claim: string; facts: CitedFact[] }[];
  action: DiagnosisAction;
  next: string;
  wouldChange: string;
  cannotSee: string[];
};

export type StoredDiagnosis = {
  id: number;
  createdAt: Date;
  createdBy: string;
  /** Null when the rules answered without asking the AI. */
  model: string | null;
  result: Diagnosis;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  feedback: "right" | "wrong" | null;
};

/** What a run cost, as OpenRouter reported it. */
export function diagnosisCost(costUsd: number | null | undefined) {
  if (costUsd == null) return null;
  if (costUsd < 0.001) return "under $0.001";
  return `$${costUsd.toFixed(costUsd < 0.01 ? 3 : 2)}`;
}

/** "deepseek/deepseek-v4.1-flash" reads as "deepseek-v4.1-flash". */
export const modelName = (model: string) => model.split("/").pop()!;
