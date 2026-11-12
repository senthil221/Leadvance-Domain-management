import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { answerWithoutAi, buildFacts, checkDiagnosis, DEFAULT_DIAGNOSIS_MODEL, DIAGNOSIS_SYSTEM, factLabel, gapBetween, resolveFacts, sent28, type DiagnosisInput, type DiagnosisRaw } from "../src/lib/diagnose";
import { diagnosisCost, modelName } from "../src/lib/diagnose-meta";
import type { FixFact } from "../src/lib/fix-queue";

vi.mock("../src/lib/db", () => ({ sql: Object.assign(() => ({}), { json: (v: unknown) => v }) }));
vi.mock("../src/lib/queries", () => ({ getDiagnosisInput: vi.fn() }));
const { askAi, DiagnosisError } = await import("../src/lib/diagnose-ai");

const fact = (over: Partial<FixFact> = {}): FixFact => ({
  domainId: "d-1", name: "madeupsender.com", status: "active", standing: "active", current: true, orderLive: true, orderState: "active", provider: "Hypertide",
  graceLeft: null, clientId: "c-1", clientName: "Client One", clientHue: 200, connected: 3, disconnected: 0, capacity: 45, lostCapacity: 0,
  warmupOff: 0, warmupBlocked: 0, lowRep: 0, rep: 98.26, sent7: 700, replies7: 7, daysSent: 7, daysSinceSent: 0,
  bounces7: 7, dnsBounces: 0, senderBounces: 0, blockBounces: 0, spamBounces: 0,
  nameserversAnswering: true, dnsSpf: true, dnsDkim: true, dnsDmarc: true, dnsMx: true, listed: 0, daysToExpiry: 200, autoRenew: null, orderProblem: null, ...over,
});
const week = (week: number, sent: number, humanReplies = 0, bounces = 0) => ({ week, sent, daysSent: 7, humanReplies, allReplies: humanReplies + 1, ooo: 1, bounces });
const input = (over: Partial<DiagnosisInput> = {}): DiagnosisInput => ({
  fact: fact(),
  own: { tld: "com", ageDays: 120, daysInSmartlead: 90 },
  weeks: [week(0, 700, 0, 40), week(1, 700, 7, 5), week(2, 700, 7, 5), week(3, 700, 7, 5)],
  causes: [{ cause: "blocklist", last7: 30, last28: 35 }, { cause: "missing", last7: 0, last28: 4 }],
  peers: [
    { grp: "client", week: 0, domains: 12, sent: 8000, humanReplies: 80, bounces: 80 },
    { grp: "client", week: 1, domains: 11, sent: 8000, humanReplies: 80, bounces: 80 },
    { grp: "all", week: 0, domains: 90, sent: 60000, humanReplies: 600, bounces: 600 },
  ],
  changes: [{ from: "warming", to: "active", daysAgo: 30 }],
  ...over,
});
const raw = (over: Partial<DiagnosisRaw> = {}): DiagnosisRaw => ({
  verdict: "underperforming", headline: "It's falling behind the client.", confidence: "high",
  reasons: [{ claim: "Block list bounces began this week.", facts: ["bounces7.blocklist", "gaps.bouncesThisWeekVsBefore"] }],
  action: "rest", next: "Rest it for a week.", wouldChange: "Bounces settling on their own.", cannotSee: ["Inbox placement"], ...over,
});

describe("the facts", () => {
  const facts = buildFacts(input(), fact());

  it("adds up each week and works out rates", () => {
    expect(facts.week1).toMatchObject({ sent: 700, humanReplies: 0, bounces: 40, humanReplyRate: 0, bounceRate: 5.71 });
    expect(facts.week2.humanReplyRate).toBe(1);
    expect(sent28(facts)).toBe(2800);
    expect(facts.bounces7).toEqual({ blocklist: 30 });
    expect(facts.bounces28).toEqual({ blocklist: 35, missing: 4 });
  });

  it("pools the other domains, and leaves out a group with none", () => {
    expect(facts.peers.client).toMatchObject({ domains: 12, sent28: 16000, humanReplyRate28: 1, humanReplyRateWeek1: 1 });
    expect(facts.peers.tag).toBeNull();
    expect(facts.gaps.humanRepliesVsTag).toBe("too_little_data");
  });

  it("marks a gap as real only when it's too big to be chance", () => {
    expect(gapBetween(1, 299, 100, 1000)).toBe("too_little_data");
    expect(gapBetween(10, 1000, 11, 1000)).toBe("same");
    expect(gapBetween(5, 1000, 60, 1000)).toBe("below");
    expect(gapBetween(60, 1000, 5, 1000)).toBe("above");
    expect(facts.gaps.bouncesThisWeekVsBefore).toBe("above");
  });

  it("never names the domain or the client", () => {
    const text = JSON.stringify(facts);
    for (const secret of ["madeupsender", "Client One", "d-1", "c-1"]) expect(text).not.toContain(secret);
  });

  it("passes on what the rules already found", () => {
    expect(buildFacts(input(), fact({ listed: 2 })).rules.problems[0]).toContain("Block listed");
  });

  it("says when the domain's whole tag is weak", () => {
    const facts = buildFacts(input({ replace: { call: "Replace", reasons: ["r"], tagNotes: ["Spam, policy and block list bounces 1.2% across its 5 domains"] } }), fact());
    expect(facts.rules.tagNotes).toEqual(["Spam, policy and block list bounces 1.2% across its 5 domains"]);
    expect(buildFacts(input(), fact()).rules.tagNotes).toEqual([]);
    expect(factLabel("rules.tagNotes.0")).toBe("Its whole tag");
  });
});

describe("answers that need no AI", () => {
  it("says so for a domain that isn't in use", () => {
    expect(answerWithoutAi(null, null)).toMatchObject({ verdict: "not_enough_data", action: "wait_for_data" });
  });

  it("won't judge too little mail, but still shows what the rules see", () => {
    const f = fact({ nameserversAnswering: false });
    const thin = buildFacts(input({ weeks: [week(0, 10)], fact: f }), f);
    const a = answerWithoutAi(f, thin)!;
    expect(a).toMatchObject({ verdict: "not_enough_data", action: "fix_setup" });
    expect(a.headline).toContain("10 emails");
    expect(a.next).toContain("nameservers");
    expect(a.reasons[0].facts[0].label).toBe("Rule check");
  });

  it("leaves real volume to the AI", () => {
    expect(answerWithoutAi(fact(), buildFacts(input(), fact()))).toBeNull();
  });
});

describe("checking the answer", () => {
  const facts = buildFacts(input(), fact());

  it("shows the real value, whatever the AI said", () => {
    expect(resolveFacts(["week1.bounceRate"], facts)).toEqual([{ path: "week1.bounceRate", label: "Last 7 days: bounce rate", value: "5.71%" }]);
    expect(resolveFacts(["setup.spf"], facts)[0].value).toBe("yes");
    expect(resolveFacts(["statusChanges.0.to"], facts)[0].value).toBe("active");
  });

  it("drops citations that don't exist or aren't one value", () => {
    expect(resolveFacts(["week9.sent", "week1", "peers", "constructor", "week1.sent.toFixed", "__proto__.x"], facts)).toEqual([]);
    expect(resolveFacts(["week1.sent", "week1.sent"], facts)).toHaveLength(1);
  });

  it("drops a claim with nothing real behind it, and keeps the rest", () => {
    const d = checkDiagnosis(raw({ reasons: [{ claim: "Made up.", facts: ["week9.sent"] }, { claim: "Real.", facts: ["week1.sent"] }] }), facts);
    expect(d.reasons.map((r) => r.claim)).toEqual(["Real."]);
    expect(d.confidence).toBe("high");
  });

  it("warns and lowers its confidence when no claim holds up", () => {
    const d = checkDiagnosis(raw({ reasons: [{ claim: "Made up.", facts: ["nothing.here"] }] }), facts);
    expect(d.reasons).toEqual([]);
    expect(d.confidence).toBe("low");
    expect(d.headline).toContain("treat this with care");
  });

  it("keeps only the first few reasons that hold up", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ claim: `Reason ${i}.`, facts: i === 0 ? ["week9.sent"] : ["week1.sent"] }));
    const d = checkDiagnosis(raw({ reasons: many }), facts);
    expect(d.reasons.map((r) => r.claim)).toEqual(["Reason 1.", "Reason 2.", "Reason 3.", "Reason 4.", "Reason 5."]);
    expect(DIAGNOSIS_SYSTEM).toContain("at most 5 reasons");
  });

  it("leaves an answer with no reasons alone", () => {
    expect(checkDiagnosis(raw({ reasons: [], verdict: "healthy" }), facts).confidence).toBe("high");
  });

  it("labels facts in words", () => {
    expect(factLabel("peers.client.humanReplyRate28")).toBe("Client's other domains: human reply rate, 28 days");
    expect(factLabel("gaps.bouncesVsClient")).toBe("Compared: bounces against the client");
    expect(factLabel("rules.problems.0")).toBe("Rule check");
    expect(factLabel("bounces7.blocklist")).toBe("Bounces, 7 days: blocklist");
  });
});

describe("cost", () => {
  it("shows what OpenRouter reported, in words that fit small amounts", () => {
    expect(diagnosisCost(0.0004)).toBe("under $0.001");
    expect(diagnosisCost(0.0027)).toBe("$0.003");
    expect(diagnosisCost(0.042)).toBe("$0.04");
    expect(diagnosisCost(null)).toBeNull();
    expect(modelName(DEFAULT_DIAGNOSIS_MODEL)).toBe("deepseek-v4.1-flash-1017");
  });
});

describe("asking the AI", () => {
  let server: Server;
  let setup: { apiKey: string; baseUrl: string; model: string };
  let seen: { body: Record<string, never>; auth: string | undefined; url: string | undefined } | null = null;
  let status = 200;
  let reply: Record<string, unknown> = {};
  const answer = (content: string, finish = "stop") => ({ choices: [{ finish_reason: finish, message: { role: "assistant", content } }] });

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen = { body: JSON.parse(body), auth: req.headers.authorization, url: req.url };
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "gen-1", model: DEFAULT_DIAGNOSIS_MODEL, usage: { prompt_tokens: 900, completion_tokens: 300, cost: 0.0002 }, ...reply }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    setup = { apiKey: "made-up-for-tests", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: DEFAULT_DIAGNOSIS_MODEL };
  });
  afterAll(() => { server.close(); });

  const facts = buildFacts(input(), fact());

  it("sends only the facts, asks for the right shape, and reads the answer", async () => {
    status = 200;
    reply = answer(JSON.stringify(raw()));
    const a = await askAi(facts, setup);
    expect(a).toMatchObject({ model: DEFAULT_DIAGNOSIS_MODEL, inputTokens: 900, outputTokens: 300, costUsd: 0.0002 });
    expect(a.raw.verdict).toBe("underperforming");
    const { body, auth, url } = seen!;
    expect(url).toBe("/chat/completions");
    expect(auth).toBe("Bearer made-up-for-tests");
    expect(body).toMatchObject({ model: DEFAULT_DIAGNOSIS_MODEL, provider: { data_collection: "deny", require_parameters: true, sort: "price" } });
    expect((body.messages as { content: string }[])[1].content).toBe(JSON.stringify(facts));
    expect(JSON.stringify(body)).not.toContain("madeupsender");
  });

  it("asks for a schema strict hosts will accept", async () => {
    status = 200;
    reply = answer(JSON.stringify(raw()));
    await askAi(facts, setup);
    const format = (seen!.body.response_format as { json_schema: { strict: boolean; schema: { additionalProperties: boolean; required: string[]; properties: { reasons: { items: { additionalProperties: boolean } } } } } }).json_schema;
    expect(format.strict).toBe(true);
    expect(format.schema).not.toHaveProperty("$schema");
    expect(format.schema.additionalProperties).toBe(false);
    expect(format.schema.required).toContain("wouldChange");
    expect(format.schema.properties.reasons.items.additionalProperties).toBe(false);
  });

  it("reads an answer wrapped in a code fence", async () => {
    status = 200;
    reply = answer("```json\n" + JSON.stringify(raw()) + "\n```");
    expect((await askAi(facts, setup)).raw.verdict).toBe("underperforming");
  });

  it("copes when the cost isn't reported", async () => {
    status = 200;
    reply = { ...answer(JSON.stringify(raw())), usage: undefined };
    expect(await askAi(facts, setup)).toMatchObject({ inputTokens: null, costUsd: null });
  });

  it("won't accept a cut-off, malformed or wrong-shaped answer", async () => {
    status = 200;
    reply = answer("{\"verdict\":", "length");
    await expect(askAi(facts, setup)).rejects.toThrow("cut off");
    reply = answer("not json");
    await expect(askAi(facts, setup)).rejects.toThrow("wrong shape");
    reply = answer(JSON.stringify({ ...raw(), verdict: "great" }));
    await expect(askAi(facts, setup)).rejects.toThrow("wrong shape");
    reply = { error: { code: 402, message: "no credit" } };
    await expect(askAi(facts, setup)).rejects.toThrow("out of credit");
    await expect(askAi(facts, setup)).rejects.toBeInstanceOf(DiagnosisError);
  });

  it("explains a refused key, no credit and no suitable host", async () => {
    reply = {};
    for (const [code, words] of [[401, "refused the API key"], [402, "out of credit"], [404, "privacy and price limits"], [429, "rate limiting"], [500, "error 500"]] as const) {
      status = code;
      await expect(askAi(facts, setup)).rejects.toThrow(words);
    }
    status = 200;
  });
});
