import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { sql } from "./db";
import { answerWithoutAi, buildFacts, checkDiagnosis, DIAGNOSIS_MODEL, DIAGNOSIS_SYSTEM, DiagnosisSchema, type DiagnosisFacts, type DiagnosisRaw, type StoredDiagnosis } from "./diagnose";
import { getDiagnosisInput } from "./queries";

/** A refusal worded for people, shown as is. */
export class DiagnosisError extends Error {}

export type AiAnswer = { raw: DiagnosisRaw; model: string; inputTokens: number; outputTokens: number };

/** Asks Claude to read the facts. Advice only: nothing here changes a domain. */
export async function askClaude(facts: DiagnosisFacts, client: Anthropic): Promise<AiAnswer> {
  const response = await client.beta.messages.parse({
    model: DIAGNOSIS_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "high", format: betaZodOutputFormat(DiagnosisSchema) },
    system: DIAGNOSIS_SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(facts) }],
  });
  if (response.stop_reason === "refusal") throw new DiagnosisError("The AI declined to answer this one. Nothing was saved.");
  if (response.stop_reason === "max_tokens") throw new DiagnosisError("The answer ran too long and was cut off. Nothing was saved, so try again.");
  if (!response.parsed_output) throw new DiagnosisError("The answer came back in the wrong shape. Nothing was saved, so try again.");
  return { raw: response.parsed_output, model: response.model, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
}

function explain(e: unknown): Error {
  if (e instanceof DiagnosisError) return e;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new DiagnosisError("Anthropic refused the API key. Check ANTHROPIC_API_KEY in the server's .env.");
  if (e instanceof Anthropic.RateLimitError) return new DiagnosisError("Anthropic is rate limiting this key. Try again in a minute.");
  if (e instanceof Anthropic.APIConnectionError) return new DiagnosisError("Couldn't reach Anthropic. Try again in a minute.");
  if (e instanceof Anthropic.APIError && e.status === 402) return new DiagnosisError("The Anthropic account is out of credit.");
  if (e instanceof Anthropic.APIError) return new DiagnosisError(`Anthropic couldn't answer (error ${e.status}). Nothing was saved.`);
  return e instanceof Error ? e : new Error(String(e));
}

const STORED = sql`id, created_at, created_by, model, result, input_tokens, output_tokens, feedback`;

/**
 * Diagnoses one domain and keeps the answer. It only pays for the AI when it has
 * to: too little data is answered by the rules, and unchanged facts reuse the last answer.
 */
export async function runDiagnosis(domainId: string, actor: string, client?: Anthropic): Promise<{ diagnosis: StoredDiagnosis; reused: boolean }> {
  const input = await getDiagnosisInput(domainId);
  if (!input) throw new DiagnosisError("This domain no longer exists.");
  const facts = input.fact ? buildFacts(input, input.fact) : null;

  const [same] = facts ? await sql<StoredDiagnosis[]>`
    select ${STORED} from domain_diagnoses
    where domain_id = ${domainId} and facts = ${sql.json(facts as never)}
    order by id desc limit 1` : [];
  if (same) return { diagnosis: same, reused: true };

  const save = async (result: unknown, model: string | null, inputTokens: number | null, outputTokens: number | null) => {
    const [row] = await sql<StoredDiagnosis[]>`
      insert into domain_diagnoses (domain_id, created_by, model, facts, result, input_tokens, output_tokens)
      values (${domainId}, ${actor}, ${model}, ${facts ? sql.json(facts as never) : null}, ${sql.json(result as never)}, ${inputTokens}, ${outputTokens})
      returning ${STORED}`;
    return { diagnosis: row, reused: false };
  };

  const local = answerWithoutAi(input.fact, facts);
  if (local || !facts) return save(local, null, null, null);

  if (!client && !process.env.ANTHROPIC_API_KEY) throw new DiagnosisError("AI diagnosis isn't set up yet. Add ANTHROPIC_API_KEY to the server's .env.");
  try {
    const answer = await askClaude(facts, client ?? new Anthropic({ timeout: 120_000, maxRetries: 1 }));
    return await save(checkDiagnosis(answer.raw, facts), answer.model, answer.inputTokens, answer.outputTokens);
  } catch (e) {
    throw explain(e);
  }
}
