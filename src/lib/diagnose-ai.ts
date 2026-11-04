import { z } from "zod";
import { sql } from "./db";
import { answerWithoutAi, buildFacts, checkDiagnosis, DEFAULT_DIAGNOSIS_MODEL, DIAGNOSIS_SYSTEM, DiagnosisSchema, type DiagnosisFacts, type DiagnosisRaw, type StoredDiagnosis } from "./diagnose";
import { getDiagnosisInput } from "./queries";

/** A refusal worded for people, shown as is. */
export class DiagnosisError extends Error {}

export type AiSetup = { apiKey: string; baseUrl: string; model: string };
export type AiAnswer = { raw: DiagnosisRaw; model: string; inputTokens: number | null; outputTokens: number | null; costUsd: number | null };

const OPENROUTER_URL = "https://openrouter.ai/api/v1";

// Keeps the bill small even if the cheapest hosts are down. Dollars per million tokens.
const MAX_PRICE = { prompt: 1, completion: 2 };

// Some hosts refuse a schema that carries its own "$schema" line.
const ANSWER_SHAPE = { ...z.toJSONSchema(DiagnosisSchema), $schema: undefined };

const STATUS_WORDS: Record<number, string> = {
  401: "OpenRouter refused the API key. Check OPENROUTER_API_KEY in the server's .env.",
  402: "The OpenRouter account is out of credit.",
  404: "No host for this model meets the privacy and price limits right now. Try again later, or change OPENROUTER_MODEL.",
  429: "OpenRouter is rate limiting this key. Try again in a minute.",
};

type Completion = {
  model?: string;
  error?: { code?: number; message?: string };
  choices?: { finish_reason?: string | null; error?: { message?: string }; message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
};

/** Asks the model to read the facts. Advice only: nothing here changes a domain. */
export async function askAi(facts: DiagnosisFacts, setup: AiSetup): Promise<AiAnswer> {
  let res: Response;
  try {
    res = await fetch(`${setup.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${setup.apiKey}` },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: setup.model,
        max_tokens: 8000,
        reasoning: { effort: "medium", exclude: true },
        messages: [{ role: "system", content: DIAGNOSIS_SYSTEM }, { role: "user", content: JSON.stringify(facts) }],
        response_format: { type: "json_schema", json_schema: { name: "diagnosis", strict: true, schema: ANSWER_SHAPE } },
        // Hosts that don't keep or train on the data, cheapest first, and only ones that can return this shape.
        provider: { data_collection: "deny", require_parameters: true, sort: "price", max_price: MAX_PRICE },
      }),
    });
  } catch {
    throw new DiagnosisError("Couldn't reach OpenRouter. Try again in a minute.");
  }
  if (!res.ok) throw new DiagnosisError(STATUS_WORDS[res.status] ?? `OpenRouter couldn't answer (error ${res.status}). Nothing was saved.`);

  const body = (await res.json().catch(() => null)) as Completion | null;
  const choice = body?.choices?.[0];
  if (!body || body.error || choice?.error) {
    const code = body?.error?.code;
    throw new DiagnosisError((code && STATUS_WORDS[code]) || "The model couldn't answer this time. Nothing was saved, so try again.");
  }
  if (choice?.finish_reason === "length") throw new DiagnosisError("The answer ran too long and was cut off. Nothing was saved, so try again.");

  let parsed: unknown;
  try {
    // Not every host holds to the shape strictly, and some wrap the JSON in a code fence.
    parsed = JSON.parse((choice?.message?.content ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    parsed = null;
  }
  const raw = DiagnosisSchema.safeParse(parsed);
  if (!raw.success) throw new DiagnosisError("The answer came back in the wrong shape. Nothing was saved, so try again.");

  return {
    raw: raw.data,
    model: body.model ?? setup.model,
    inputTokens: body.usage?.prompt_tokens ?? null,
    outputTokens: body.usage?.completion_tokens ?? null,
    costUsd: body.usage?.cost ?? null,
  };
}

const STORED = sql`id, created_at, created_by, model, result, input_tokens, output_tokens, cost_usd::float8 as cost_usd, feedback`;

/**
 * Diagnoses one domain and keeps the answer. It only pays for the AI when it has
 * to: too little data is answered by the rules, and unchanged facts reuse the last answer.
 */
export async function runDiagnosis(domainId: string, actor: string): Promise<{ diagnosis: StoredDiagnosis; reused: boolean }> {
  const input = await getDiagnosisInput(domainId);
  if (!input) throw new DiagnosisError("This domain no longer exists.");
  const facts = input.fact ? buildFacts(input, input.fact) : null;

  const [same] = facts ? await sql<StoredDiagnosis[]>`
    select ${STORED} from domain_diagnoses
    where domain_id = ${domainId} and facts = ${sql.json(facts as never)}
    order by id desc limit 1` : [];
  if (same) return { diagnosis: same, reused: true };

  const save = async (result: unknown, answer: Omit<AiAnswer, "raw"> | null) => {
    const [row] = await sql<StoredDiagnosis[]>`
      insert into domain_diagnoses (domain_id, created_by, model, facts, result, input_tokens, output_tokens, cost_usd)
      values (${domainId}, ${actor}, ${answer?.model ?? null}, ${facts ? sql.json(facts as never) : null}, ${sql.json(result as never)},
        ${answer?.inputTokens ?? null}, ${answer?.outputTokens ?? null}, ${answer?.costUsd ?? null})
      returning ${STORED}`;
    return { diagnosis: row, reused: false };
  };

  const local = answerWithoutAi(input.fact, facts);
  if (local || !facts) return save(local, null);

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new DiagnosisError("AI diagnosis isn't set up yet. Add OPENROUTER_API_KEY to the server's .env.");
  const answer = await askAi(facts, {
    apiKey,
    baseUrl: process.env.OPENROUTER_BASE_URL || OPENROUTER_URL,
    model: process.env.OPENROUTER_MODEL || DEFAULT_DIAGNOSIS_MODEL,
  });
  return save(checkDiagnosis(answer.raw, facts), answer);
}
