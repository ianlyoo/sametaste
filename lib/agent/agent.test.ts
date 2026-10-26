import { readFileSync } from "node:fs";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { AgentEventSchema, type AgentEvent, type Plan } from "../contract";
import { PERSONAS, aggregateTransactions, parseCsv } from "../../personas";
import { MemoryCache } from "../qloo/cache";
import { QlooClient } from "../qloo/client";
import { createMockFetch } from "../qloo/mock/fetch";
import { MemoryKV } from "./kv";
import { normalizeMerchants, normalizeByRules } from "./normalize";
import { costUsd } from "./pricing";
import { rateLimit } from "./rateLimit";
import { runAgent, type RunDeps } from "./run";
import { SpendLedger } from "./spend";

// whole scripted runs; the shared box can be slow under load
vi.setConfig({ testTimeout: 20_000 });

const persona = (id: string) => {
  const p = PERSONAS.find((x) => x.id === id)!;
  return { location: p.location, merchants: aggregateTransactions(parseCsv(readFileSync(`personas/${p.file}`, "utf8"))) };
};
const mockQloo: RunDeps["qloo"] = (budget) => new QlooClient({ mock: true, budget });
const planOf = (events: AgentEvent[]): Plan => {
  const ev = events.filter((e) => e.type === "plan_ready").at(-1);
  if (!ev || ev.type !== "plan_ready") throw new Error("no plan");
  return ev.plan;
};
const doneOf = (events: AgentEvent[]) => {
  const d = events.at(-1)!;
  if (d.type !== "done") throw new Error("last event is not done");
  return d;
};

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});
const toolCall = (id: string, toolName: string, input: unknown) => ({
  type: "tool-call" as const,
  toolCallId: id,
  toolName,
  input: JSON.stringify(input),
});

describe("scripted agent on the personas (mock Qloo)", () => {
  for (const p of PERSONAS) {
    it(`${p.id}: valid stream, cheaper swaps, receipt and fingerprint`, async () => {
      const lines: string[] = [];
      const { events } = await runAgent(persona(p.id), { scripted: true, qloo: mockQloo, write: (e) => lines.push(JSON.stringify(e)) });
      expect(lines.length).toBe(events.length);
      events.forEach((e, i) => {
        expect(AgentEventSchema.safeParse(JSON.parse(lines[i])).success).toBe(true);
        expect(e.seq).toBe(i);
      });
      expect(events[0].type).toBe("run_started");
      const done = doneOf(events);
      expect(["complete", "awaiting_answer"]).toContain(done.reason);
      expect(done.usage.qlooCalls).toBeLessThanOrEqual(40);
      expect(done.usage.toolTurns).toBeLessThanOrEqual(12);
      expect(done.usage.costUsd).toBe(0);

      const plan = planOf(events);
      expect(plan.swaps.length).toBeGreaterThan(0);
      for (const s of plan.swaps) {
        // honest twins: exactly one level down, at least one shared taste tag
        expect(s.to.entity.priceLevel).toBe(s.from.entity!.priceLevel! - 1);
        expect(s.to.evidence.sharedTagIds?.length).toBeGreaterThan(0);
        expect(s.savings.monthlySavings).toBeGreaterThan(0);
        expect(s.keepReason).toBeTruthy();
        // short evidence line: at most 40 chars, without the merchant names
        expect(s.crossDomainNote).toMatch(/^Also love: /);
        expect(s.crossDomainNote!.length).toBeLessThanOrEqual(40);
        expect(s.crossDomainNote).not.toContain(s.from.name);
        expect(s.crossDomainNote).not.toContain(s.to.entity.name);
      }
      // one twin per place, and a different bridge per swap
      expect(new Set(plan.swaps.map((s) => s.to.entity.id)).size).toBe(plan.swaps.length);
      const bridges = plan.swaps.map((s) => s.to.evidence.crossDomain?.[0]?.entity.name);
      expect(new Set(bridges).size).toBe(plan.swaps.length);
      expect(plan.totals.monthlyAfter).toBeLessThan(plan.totals.monthlyBefore);
      expect(plan.weeks).toHaveLength(4);
      expect(plan.fingerprint?.affinities.length).toBeGreaterThan(0);
      const receipt = plan.receipt!;
      expect(receipt.lines.filter((l) => l.status === "swapped")).toHaveLength(plan.swaps.length);
      expect(receipt.monthlySavings).toBeCloseTo(plan.totals.monthlySavings, 2);
      for (const l of receipt.lines) expect(l.keepReason).toBeTruthy();
      // bills and transfers never reach Qloo
      const resolved = events.flatMap((e) => (e.type === "merchants_resolved" ? e.resolutions : []));
      expect(resolved.some((r) => /RENT|VENMO|ZELLE|MTA|CONED/i.test(r.rawMerchant))).toBe(false);
    });
  }

  it("asks which Joe's and re-plans with the answer, keeping earlier swaps", async () => {
    const req = persona("dev-flatiron");
    const first = await runAgent(req, { scripted: true, qloo: mockQloo });
    expect(doneOf(first.events).reason).toBe("awaiting_answer");
    const q = first.events.find((e) => e.type === "question");
    if (q?.type !== "question") throw new Error("no question");
    expect(q.question.kind).toBe("ambiguous_merchant");
    expect(q.question.options.length).toBeGreaterThanOrEqual(2);
    const plan1 = planOf(first.events);

    const pick = q.question.options.find((o) => /Joe Coffee/.test(o.label)) ?? q.question.options[0];
    const second = await runAgent(
      { ...req, previousPlan: plan1, answers: [{ questionId: q.question.id, merchantKey: q.question.merchantKey, optionId: pick.id, entityId: pick.entityId }] },
      { scripted: true, qloo: mockQloo },
    );
    expect(doneOf(second.events).reason).toBe("complete");
    const res = second.events.flatMap((e) => (e.type === "merchants_resolved" ? e.resolutions : []));
    const joe = res.find((r) => r.merchantKey === q.question.merchantKey)!;
    expect(joe.status).toBe("resolved");
    expect(joe.source).toBe("user_answer");
    expect(joe.entity?.id).toBe(pick.entityId);
    const plan2 = planOf(second.events);
    for (const s of plan1.swaps) expect(plan2.swaps.some((x) => x.id === s.id)).toBe(true);
    expect(plan2.unswapped.some((u) => u.reason === "Waiting for your answer")).toBe(false);
    expect(plan2.fingerprint).toEqual(plan1.fingerprint);
    expect(plan2.receipt!.lines.find((l) => l.merchantKey === q.question.merchantKey)?.name).toBe(pick.label);
  });

  it("re-plans a rejected swap with a different twin and never re-proposes it", async () => {
    const req = persona("maya-williamsburg");
    const first = await runAgent(req, { scripted: true, qloo: mockQloo });
    const plan1 = planOf(first.events);
    const rejected = plan1.swaps[0];
    const second = await runAgent(
      {
        ...req,
        previousPlan: plan1,
        feedback: [{ swapId: rejected.id, merchantKey: rejected.merchantKey, candidateEntityId: rejected.to.entity.id, verdict: "reject", reason: "too far from me" }],
      },
      { scripted: true, qloo: mockQloo },
    );
    const plan2 = planOf(second.events);
    const redo = plan2.swaps.filter((s) => s.merchantKey === rejected.merchantKey);
    expect(redo.every((s) => s.to.entity.id !== rejected.to.entity.id)).toBe(true);
    // re-priced from the new twin, and the total moves
    const next = redo.find((s) => s.status !== "rejected");
    if (next) {
      expect(next.to.entity.priceLevel).toBe(rejected.from.entity!.priceLevel! - 1);
      expect(next.savings.monthlySavings).not.toBe(rejected.savings.monthlySavings);
      expect(plan2.totals.monthlySavings).not.toBe(plan1.totals.monthlySavings);
    }
    for (const s of plan1.swaps.slice(1)) expect(plan2.swaps.some((x) => x.id === s.id)).toBe(true);
    // only the rejected merchant was re-worked: a handful of Qloo calls (fresh cache)
    const fresh = await runAgent(
      { ...req, previousPlan: plan1, feedback: [{ swapId: rejected.id, merchantKey: rejected.merchantKey, candidateEntityId: rejected.to.entity.id, verdict: "reject" }] },
      { scripted: true, qloo: (budget) => new QlooClient({ mock: true, budget, cache: new MemoryCache() }) },
    );
    expect(doneOf(fresh.events).usage.qlooCalls).toBeGreaterThan(0);
    expect(doneOf(fresh.events).usage.qlooCalls).toBeLessThanOrEqual(6);
  });

  it("never proposes another branch of a place the user already goes to, on any re-plan", async () => {
    const { normName } = await import("./text");
    const req = persona("maya-williamsburg");
    const plan1 = planOf((await runAgent(req, { scripted: true, qloo: mockQloo })).events);
    const own = new Set(plan1.receipt!.lines.map((l) => normName(l.name)));
    for (const s of plan1.swaps) expect(own.has(normName(s.to.entity.name))).toBe(false);
    for (const rejected of plan1.swaps) {
      const plan2 = planOf(
        (
          await runAgent(
            { ...req, previousPlan: { ...plan1, swaps: plan1.swaps.map((x) => (x.id === rejected.id ? { ...x, status: "rejected" as const } : x)) }, feedback: [{ swapId: rejected.id, merchantKey: rejected.merchantKey, candidateEntityId: rejected.to.entity.id, verdict: "reject" }] },
            { scripted: true, qloo: mockQloo },
          )
        ).events,
      );
      for (const s of plan2.swaps.filter((x) => x.merchantKey === rejected.merchantKey && x.status !== "rejected")) expect(own.has(normName(s.to.entity.name)), `${rejected.from.name} -> ${s.to.entity.name}`).toBe(false);
    }
  });

  it("llm_only mode verifies model guesses against Qloo /search", async () => {
    const { events } = await runAgent({ ...persona("sam-eastvillage"), mode: "llm_only" }, { scripted: true, qloo: mockQloo });
    const b = events.find((e) => e.type === "baseline_ready");
    if (b?.type !== "baseline_ready") throw new Error("no baseline");
    expect(b.suggestions.length).toBeGreaterThan(3);
    expect(b.suggestions.some((s) => !s.existsInQloo)).toBe(true);
    expect(events.some((e) => e.type === "plan_ready")).toBe(false);
    expect(doneOf(events).reason).toBe("complete");
  });
});

describe("guards", () => {
  it("stops at the Qloo call budget and still writes a plan", async () => {
    const { events } = await runAgent(persona("maya-williamsburg"), { scripted: true, qloo: mockQloo, limits: { maxQlooCalls: 6 } });
    expect(doneOf(events).usage.qlooCalls).toBeLessThanOrEqual(6);
    expect(events.some((e) => e.type === "plan_ready")).toBe(true);
  });

  it("caps tool turns and forces plan_writer on the last turn", async () => {
    const { events } = await runAgent(persona("maya-williamsburg"), { scripted: true, qloo: mockQloo, limits: { maxToolTurns: 3 } });
    expect(doneOf(events).usage.toolTurns).toBeLessThanOrEqual(3);
    const steps = events.filter((e) => e.type === "tool_step" && e.state === "finished").map((e) => (e.type === "tool_step" ? e.tool : ""));
    expect(steps.at(-1)).toBe("plan_writer");
  });

  it("stops on the per-run cost cap and records spend in the ledger", async () => {
    const kv = new MemoryKV();
    const ledger = new SpendLedger(kv, { totalCapUsd: 100, dailyCapUsd: 15 });
    // every step costs 100k in + 10k out on Sonnet = $0.30
    const model = new MockLanguageModelV4({
      modelId: "claude-sonnet-5-5",
      doGenerate: async () => ({
        content: [toolCall(crypto.randomUUID(), "normalize_merchants", {})],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: usage(100_000, 10_000),
        warnings: [],
      }),
    });
    const { events } = await runAgent(persona("maya-williamsburg"), { model, modelId: "claude-sonnet-5-5", qloo: mockQloo, ledger });
    const done = doneOf(events);
    expect(done.reason).toBe("limit_reached");
    expect(done.usage.toolTurns).toBe(2);
    expect(done.usage.costUsd).toBeCloseTo(0.6, 4);
    expect((await ledger.status()).totalUsd).toBeCloseTo(0.6, 4);
    expect(events.some((e) => e.type === "error" && e.code === "limit_reached")).toBe(true);
    expect(events.some((e) => e.type === "plan_ready")).toBe(true);
  });

  it("ledger blocks at the total and daily caps and without persistence in production", async () => {
    const kv = new MemoryKV();
    const l = new SpendLedger(kv, { totalCapUsd: 1, dailyCapUsd: 0.5 });
    expect((await l.status()).blocked).toBe(false);
    expect((await l.record(0.5)).reason).toBe("daily_cap");
    expect((await new SpendLedger(kv, { totalCapUsd: 0.4, dailyCapUsd: 5 }).status()).reason).toBe("total_cap");
    expect((await new SpendLedger(new MemoryKV(), { totalCapUsd: 1, dailyCapUsd: 1, requirePersistent: true }).status()).reason).toBe(
      "no_persistent_ledger",
    );
  });

  it("rate-limits per IP in a fixed window", async () => {
    const kv = new MemoryKV();
    const now = 1_800_000_000_000;
    const r = [];
    for (let i = 0; i < 4; i++) r.push(await rateLimit(kv, "203.0.113.9", { max: 3, windowS: 60, now }));
    expect(r.map((x) => x.ok)).toEqual([true, true, true, false]);
    expect((await rateLimit(kv, "198.51.100.1", { max: 3, windowS: 60, now })).ok).toBe(true);
    expect((await rateLimit(kv, "203.0.113.9", { max: 3, windowS: 60, now: now + 61_000 })).ok).toBe(true);
  });

  it("prices usage per model", () => {
    expect(costUsd("claude-sonnet-5-5", { inputTokens: 1_000_000, outputTokens: 100_000 } as never)).toBeCloseTo(3, 6);
    expect(costUsd("claude-haiku-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 } as never)).toBeCloseTo(0.6, 6);
    expect(costUsd("claude-sonnet-5-5", undefined)).toBe(0);
  });
});

describe("model paths (AI SDK mock model, no live calls)", () => {
  it("drives the real tool loop from model tool calls", async () => {
    const req = persona("maya-williamsburg");
    let step = 0;
    const model = new MockLanguageModelV4({
      modelId: "claude-sonnet-5-5",
      doGenerate: async () => {
        step++;
        const content =
          step === 1
            ? [{ type: "text" as const, text: "Reading your statement." }, toolCall("a", "normalize_merchants", {})]
            : step === 2
              ? [toolCall("b", "qloo_search", { items: [{ merchantKey: req.merchants.find((m) => /LILIA/.test(m.rawMerchant))!.key }] })]
              : [toolCall("c", "plan_writer", { summary: "One swap to start." })];
        return { content, finishReason: { unified: "tool-calls", raw: undefined }, usage: usage(2000, 200), warnings: [] };
      },
    });
    const { events } = await runAgent(req, { model, modelId: "claude-sonnet-5-5", qloo: mockQloo });
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(model.doGenerateCalls[0].tools?.map((t) => t.name).sort()).toContain("qloo_insights");
    const done = doneOf(events);
    expect(done.reason).toBe("complete");
    expect(done.usage.toolTurns).toBe(3);
    expect(done.usage.costUsd).toBeCloseTo(3 * (2000 * 2 + 200 * 10) / 1e6, 6);
    expect(events.some((e) => e.type === "message" && e.text === "Reading your statement.")).toBe(true);
    // the model never searched twins: the coverage pass checks every merchant,
    // and the summary is rebuilt from the data rather than the model's stale one
    const plan = planOf(events);
    expect(plan.swaps.length).toBeGreaterThan(1);
    expect(plan.unswapped.some((u) => /not analysed/i.test(u.reason))).toBe(false);
    for (const s of plan.swaps) expect(s.rationale).toMatch(/one price level down\.$/);
    expect(plan.summary).toMatch(/one price level down/);
  });

  it("keeps the model's summary when it covered every merchant itself", async () => {
    const plan = planOf((await runAgent(persona("sam-eastvillage"), { scripted: true, qloo: mockQloo })).events);
    const model = new MockLanguageModelV4({
      modelId: "claude-sonnet-5-5",
      doGenerate: async () => ({ content: [toolCall("z", "plan_writer", { summary: "Nothing to do." })], finishReason: { unified: "tool-calls", raw: undefined }, usage: usage(10, 10), warnings: [] }),
    });
    // nothing resolved, so nothing to cover: the model's words stand
    const { events } = await runAgent(persona("sam-eastvillage"), { model, modelId: "claude-sonnet-5-5", qloo: mockQloo });
    expect(planOf(events).summary).toBe("Nothing to do.");
    expect(plan.summary).toBeTruthy();
  });

  const scriptedSteps = (steps: { name: string; input: unknown }[]) => {
    let i = 0;
    return new MockLanguageModelV4({
      modelId: "claude-sonnet-5-5",
      doGenerate: async () => {
        const st = steps[Math.min(i, steps.length - 1)];
        i++;
        return { content: [toolCall(`t${i}`, st.name, st.input)], finishReason: { unified: "tool-calls", raw: undefined }, usage: usage(1000, 100), warnings: [] };
      },
    });
  };

  it("covers merchants the model skipped and still asks about ambiguous ones", async () => {
    const req = persona("dev-flatiron");
    const cote = req.merchants.find((m) => /COTE/.test(m.rawMerchant))!.key;
    const model = scriptedSteps([
      { name: "normalize_merchants", input: { keys: [cote] } },
      { name: "qloo_search", input: { items: [{ merchantKey: cote }] } },
      { name: "plan_writer", input: { summary: "Done." } },
    ]);
    const { events, state } = await runAgent(req, { model, modelId: "claude-sonnet-5-5", qloo: mockQloo });
    const plan = planOf(events);
    // every taste merchant is on the receipt, every one was searched
    expect(plan.receipt!.lines).toHaveLength(state.focus().length);
    expect(state.focus().every((m) => m.searched)).toBe(true);
    const q = events.find((e) => e.type === "question");
    expect(q?.type === "question" && /Joe/.test(q.question.prompt)).toBe(true);
    expect(doneOf(events).reason).toBe("awaiting_answer");
  });

  it("merges two statement lines for the same place into one swap and one receipt line", async () => {
    const req = persona("maya-williamsburg");
    const keys = req.merchants.filter((m) => /BLUE B/.test(m.rawMerchant)).map((m) => m.key);
    expect(keys).toHaveLength(2);
    const spend = req.merchants.filter((m) => keys.includes(m.key)).reduce((a, m) => a + m.totalSpend, 0);
    const model = scriptedSteps([
      { name: "normalize_merchants", input: {} },
      { name: "qloo_search", input: { items: keys.map((merchantKey) => ({ merchantKey })) } },
      { name: "qloo_insights", input: { queries: [{ merchantKey: keys[0] }] } },
      { name: "propose_swap", input: { merchantKey: keys[0], candidateId: "c1", rationale: "Close match.", keepReason: "Same pour-over" } },
      { name: "plan_writer", input: { summary: "Done." } },
    ]);
    const { events } = await runAgent(req, { model, modelId: "claude-sonnet-5-5", qloo: mockQloo });
    const plan = planOf(events);
    const swaps = plan.swaps.filter((s) => keys.includes(s.merchantKey));
    expect(swaps).toHaveLength(1);
    expect([swaps[0].merchantKey, ...(swaps[0].mergedKeys ?? [])].sort()).toEqual([...keys].sort());
    const lines = plan.receipt!.lines.filter((l) => /Blue Bottle/.test(l.name));
    expect(lines).toHaveLength(1);
    expect(lines[0].mergedKeys).toHaveLength(1);
    expect(lines[0].monthlySpend).toBeCloseTo(spend, 1);
    // a proposal under the merged-away key lands on the merged line
    const other = swaps[0].mergedKeys![0];
    const model2 = scriptedSteps([
      { name: "normalize_merchants", input: {} },
      { name: "qloo_search", input: { items: [{ merchantKey: other }] } },
      { name: "qloo_insights", input: { queries: [{ merchantKey: other }] } },
      { name: "propose_swap", input: { merchantKey: other, candidateId: "c1", rationale: "Close match.", keepReason: "Same pour-over" } },
      { name: "plan_writer", input: { summary: "Done." } },
    ]);
    const plan2 = planOf((await runAgent(req, { model: model2, modelId: "claude-sonnet-5-5", qloo: mockQloo })).events);
    const line2 = plan2.receipt!.lines.find((l) => /Blue Bottle/.test(l.name))!;
    expect(line2.status).toBe("swapped");
    expect(plan2.swaps.find((s) => s.id === line2.swapId)?.merchantKey).toBe(line2.merchantKey);
    // every request key is still accounted for in the resolutions
    const res = events.flatMap((e) => (e.type === "merchants_resolved" ? e.resolutions : []));
    for (const k of keys) expect(res.some((r) => r.merchantKey === k)).toBe(true);
  });

  it("waits for a swap proposed in the same step as plan_writer", async () => {
    const req = persona("maya-williamsburg");
    const lilia = req.merchants.find((m) => /LILIA/.test(m.rawMerchant))!.key;
    const steps = [
      [toolCall("a", "normalize_merchants", {})],
      [toolCall("b", "qloo_search", { items: [{ merchantKey: lilia }] })],
      [toolCall("c", "qloo_insights", { queries: [{ merchantKey: lilia }] })],
      [
        toolCall("d", "propose_swap", { merchantKey: lilia, candidateId: "c1", rationale: "Close match.", keepReason: "Same pasta" }),
        toolCall("e", "plan_writer", { summary: "Done." }),
      ],
    ];
    let i = 0;
    const model = new MockLanguageModelV4({
      modelId: "claude-sonnet-5-5",
      doGenerate: async () => ({ content: steps[Math.min(i++, steps.length - 1)], finishReason: { unified: "tool-calls", raw: undefined }, usage: usage(1000, 100), warnings: [] }),
    });
    // the model's swap is still looking up its cross-domain bridge when plan_writer runs
    const inner = createMockFetch();
    let first = true;
    const slowFetch: typeof fetch = async (url, init) => {
      if (first && /filter\.type=urn(%3A|:)entity(%3A|:)(?!place)/.test(String(url))) {
        first = false;
        await new Promise((r) => setTimeout(r, 1000));
      }
      return inner(url, init);
    };
    const qloo: RunDeps["qloo"] = (budget) => new QlooClient({ mock: true, budget, fetch: slowFetch });
    const { events } = await runAgent(req, { model, modelId: "claude-sonnet-5-5", qloo });
    const proposed = events.find((e) => e.type === "swap_proposed");
    expect(proposed?.type === "swap_proposed" && proposed.swap.merchantKey).toBe(lilia);
    const plan = planOf(events);
    expect(plan.swaps.some((s) => s.merchantKey === lilia && s.to.entity.id === (proposed?.type === "swap_proposed" ? proposed.swap.to.entity.id : ""))).toBe(true);
    expect(events.findIndex((e) => e.type === "swap_proposed")).toBeLessThan(events.findIndex((e) => e.type === "plan_ready"));
  });

  it("batches low-confidence descriptors into one normaliser call", async () => {
    const merchants = [
      { key: "SQ KFFE BR", rawMerchant: "SQ *KFFE BR 0091", count: 6, totalSpend: 40, currency: "USD" },
      { key: "TST PNKY S", rawMerchant: "TST* PNKY S", count: 2, totalSpend: 70, currency: "USD" },
      { key: "RENT", rawMerchant: "RENT PAYMENT OCT", count: 1, totalSpend: 2400, currency: "USD" },
    ];
    expect(normalizeByRules(merchants[0]).confidence).toBeLessThan(0.7);
    const model = new MockLanguageModelV4({
      modelId: "claude-haiku-5-5",
      doGenerate: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              merchants: [
                { key: "SQ KFFE BR", name: "Kaffe Bar", category: "coffee", entityType: "place", skip: false, confidence: 0.8 },
                { key: "TST PNKY S", name: "PNKY S", category: "other", entityType: "place", skip: false, confidence: 0.2 },
              ],
            }),
          },
        ],
        finishReason: { unified: "stop", raw: undefined },
        usage: usage(500, 100),
        warnings: [],
      },
    });
    const res = await normalizeMerchants(merchants, { model, modelId: "claude-haiku-5-5" });
    expect(model.doGenerateCalls).toHaveLength(1);
    const byKey = new Map(res.merchants.map((m) => [m.key, m]));
    expect(byKey.get("SQ KFFE BR")).toMatchObject({ name: "Kaffe Bar", category: "coffee", source: "model" });
    expect(byKey.get("TST PNKY S")?.source).toBe("rules");
    expect(byKey.get("RENT")?.skip).toBe(true);
    expect(res.usage).toBeDefined();
  });
});

describe("normaliser guards", () => {
  it("rejects a low-confidence guess that adds words, keeps clean expansions", async () => {
    const { derivable } = await import("./normalize");
    expect(derivable("Joe's Coffee", "SQ *JOE'S NYC")).toBe(false);
    expect(derivable("Joe's", "SQ *JOE'S NYC")).toBe(true);
    expect(derivable("Kaffe 1668", "SQ *KAFFE 1668")).toBe(true);
    expect(derivable("Llama Inn", "TST* LLAMA INN BROOKLYN")).toBe(true);
    const merchants = [{ key: "SQ JOE'S NYC", rawMerchant: "SQ *JOE'S NYC", count: 3, totalSpend: 20, currency: "USD" }];
    const model = (confidence: number) =>
      new MockLanguageModelV4({
        doGenerate: {
          content: [{ type: "text", text: JSON.stringify({ merchants: [{ key: "SQ JOE'S NYC", name: "Joe's Coffee", category: "coffee", entityType: "place", skip: false, confidence }] }) }],
          finishReason: { unified: "stop", raw: undefined },
          usage: usage(100, 20),
          warnings: [],
        },
      });
    expect((await normalizeMerchants(merchants, { model: model(0.7) })).merchants[0].name).toBe("Joe's");
    expect((await normalizeMerchants(merchants, { model: model(0.9) })).merchants[0].name).toBe("Joe's Coffee");
  });
});

describe("billed failures", () => {
  const truncated = () =>
    new MockLanguageModelV4({
      modelId: "claude-sonnet-5-5",
      doGenerate: {
        content: [{ type: "text", text: '{"merchants": [{"key": "A", "na' }],
        finishReason: { unified: "length", raw: "max_tokens" },
        usage: usage(1000, 3000),
        warnings: [],
      },
    });

  it("the normaliser falls back to rules and still reports usage", async () => {
    const res = await normalizeMerchants([{ key: "SQ KFFE BR", rawMerchant: "SQ *KFFE BR 0091", count: 6, totalSpend: 40, currency: "USD" }], {
      model: truncated(),
      modelId: "claude-haiku-5-5",
    });
    expect(res.merchants[0].source).toBe("rules");
    expect(res.usage?.outputTokens).toBe(3000);
  });

  it("the baseline reports usage of an unparseable answer before failing", async () => {
    const { llmSuggest } = await import("./baseline");
    let seen = 0;
    await expect(
      llmSuggest([{ key: "A", name: "Lilia", category: "restaurant" }], "New York, NY", { model: truncated(), onUsage: (u) => (seen += u.outputTokens ?? 0) }),
    ).rejects.toThrow();
    expect(seen).toBe(3000);
  });
});

describe("honest twins and a fair baseline", () => {
  it("keeps a merchant when nothing one level down shares a taste tag", async () => {
    const { findTwins, isHonestTwin } = await import("./tools");
    const { RunState } = await import("./state");
    const { EventSink } = await import("./events");
    const { DEFAULT_LIMITS } = await import("./config");
    const { CallBudget } = await import("../qloo/client");
    const { AgentRequestSchema } = await import("../contract");
    const budget = new CallBudget(40);
    const qloo = new QlooClient({ mock: true, budget });
    const req = AgentRequestSchema.parse({ location: { label: "Williamsburg, Brooklyn, NY", lat: 40.7081, lon: -73.9571, radiusM: 2500 }, merchants: [{ key: "LILIA", rawMerchant: "LILIA", count: 2, totalSpend: 300, currency: "USD" }] });
    const state = new RunState("r-test-1", req, qloo, budget, new EventSink("r-test-1"), DEFAULT_LIMITS);
    const m = state.get("LILIA")!;
    const [lilia] = (await qloo.search({ query: "Lilia", types: ["place"], lat: 40.7081, lon: -73.9571, radiusMiles: 15, take: 3 })).filter((e) => e.name === "Lilia");
    // an original with a style no candidate shares
    const odd = { ...lilia, tags: [...lilia.tags.filter((t) => /:category:/.test(t.id)), { id: "urn:tag:style:place:nothing_like_it", name: "Nothing like it" }] };
    const res = await findTwins(state, m, odd, { merchantKey: "LILIA" }, new Set());
    expect(res.candidates).toHaveLength(0);
    expect(res.out.note).toMatch(/one price level down/);
    // and the rule itself
    const real = await findTwins(state, m, lilia, { merchantKey: "LILIA" }, new Set());
    for (const c of real.candidates) expect(isHonestTwin(lilia, c)).toBe(true);
    expect(isHonestTwin(lilia, { ...real.candidates[0], entity: { ...real.candidates[0].entity, priceLevel: 1 } })).toBe(false);
  });

  it("the plan names the places it keeps and why", async () => {
    const plan = planOf((await runAgent(persona("sam-eastvillage"), { scripted: true, qloo: mockQloo })).events);
    for (const l of plan.receipt!.lines.filter((x) => x.status === "kept")) expect(l.keepReason).toMatch(/stays|keep/i);
    expect(plan.summary).toMatch(/one price level down/);
  });

  it("baseline: named places with a neighbourhood, Qloo checks pending on the mock", async () => {
    const req = { ...persona("maya-williamsburg"), mode: "llm_only" as const };
    const { events } = await runAgent(req, { scripted: true, qloo: mockQloo });
    const b = events.find((e) => e.type === "baseline_ready");
    if (b?.type !== "baseline_ready") throw new Error("no baseline");
    expect(b.suggestions.length).toBeGreaterThan(5);
    for (const s of b.suggestions) {
      expect(s.suggestedName).not.toMatch(/cheaper local spot|^a |^any |nearby/i);
      expect(s.suggestedNeighborhood).toBeTruthy();
      expect(s.verification).toBe("pending_key");
    }
    // one line per place, like the SameTaste run
    expect(b.suggestions.filter((s) => s.fromName === "Blue Bottle Coffee")).toHaveLength(1);
  });

  it("baseline: the live model gets the same per-line input and is asked for a venue and neighbourhood", async () => {
    const { llmSuggest } = await import("./baseline");
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: "text", text: JSON.stringify({ suggestions: [{ merchantKey: "LILIA", suggestedName: "Misi", neighborhood: "Williamsburg" }] }) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: usage(100, 20),
        warnings: [],
      },
    });
    const out = await llmSuggest([{ key: "LILIA", name: "Lilia", category: "restaurant", rawMerchant: "TST* LILIA - BROOKLYN", visitsPerMonth: 2, monthlySpend: 300 }], "Williamsburg, Brooklyn, NY", { model });
    expect(out[0]).toEqual({ merchantKey: "LILIA", suggestedName: "Misi", neighborhood: "Williamsburg" });
    const call = JSON.stringify(model.doGenerateCalls[0].prompt);
    expect(call).toContain("TST* LILIA - BROOKLYN");
    expect(call).toContain("$300/mo");
    expect(call).toMatch(/neighbourhood/);
  });
});

describe("the measured proof (contract 1.3)", () => {
  it("scores our twins and the model's picks with the same Qloo calls, on one scale", async () => {
    const req = persona("maya-williamsburg");
    const ours = planOf((await runAgent(req, { scripted: true, qloo: mockQloo })).events);
    const base = (await runAgent({ ...req, mode: "llm_only" }, { scripted: true, qloo: mockQloo })).events.find((e) => e.type === "baseline_ready");
    const theirs = base?.type === "baseline_ready" ? base.proof! : undefined!;
    const p = ours.proof!;
    expect(p.of).toBe(theirs.of);
    expect(p.picks).toBe(ours.swaps.filter((s) => s.status !== "rejected").length);
    expect(theirs.picks).toBe(base?.type === "baseline_ready" ? base.suggestions.length : -1);
    // the mock can't say whether a place exists: both sides say so, neither claims it
    expect(p.exists).toBeUndefined();
    expect(theirs.exists).toBeUndefined();
    // every row is measured: per-pick Qloo affinities, not one constant
    for (const side of [p, theirs]) {
      expect(side.tasteScored).toBe(side.picks);
      const affs = side.perMerchant.map((x) => x.affinity!);
      expect(new Set(affs).size).toBeGreaterThan(1);
      expect(side.tasteLink).toBeCloseTo(affs.reduce((a, b) => a + b, 0) / affs.length, 3);
      expect(side.sharedTags).toBe(side.perMerchant.filter((x) => x.sharedTagIds.length).length);
      expect(side.cheaper).toBe(side.perMerchant.filter((x) => x.priceLevel! < x.fromPriceLevel!).length);
      expect(side.qlooMock).toBe(true);
    }
    // our side restates the plan: honest twins, and the SAVED total
    expect(p.sharedTags).toBe(p.picks);
    expect(p.cheaper).toBe(p.picks);
    expect(p.monthlySavings).toBeCloseTo(ours.totals.monthlySavings, 1);
    // the yardstick is the original alone, not the twin search's fingerprint signals
    for (const x of p.perMerchant) expect(x.affinity).toBeGreaterThan(0);
  });

  it("mock stand-ins for the model's picks are scored but never become twins", async () => {
    const req = persona("maya-williamsburg");
    const base = (await runAgent({ ...req, mode: "llm_only" }, { scripted: true, qloo: mockQloo })).events.find((e) => e.type === "baseline_ready");
    const picks = base?.type === "baseline_ready" ? base.proof!.perMerchant.filter((p) => p.entity) : [];
    expect(picks.length).toBeGreaterThan(0);
    const { CallBudget } = await import("../qloo/client");
    const qloo = new QlooClient({ mock: true, budget: new CallBudget(20) });
    const [lilia] = (await qloo.search({ query: "Lilia", types: ["place"], lat: 40.7081, lon: -73.9571, radiusMiles: 15, take: 3 })).filter((e) => e.name === "Lilia");
    const ids = new Set(picks.map((p) => p.entity!.id));
    const open = await qloo.placeInsights({ signalEntityIds: [lilia.id], lat: 40.7081, lon: -73.9571, radiusM: 30_000, take: 50 });
    const { mockEntityById } = await import("../qloo/mock/world");
    expect(open.filter((e) => ids.has(e.id) && mockEntityById(e.id)?.standIn)).toHaveLength(0);
    const standIn = picks.find((p) => mockEntityById(p.entity!.id)?.standIn)!;
    const only = await qloo.placeInsights({ signalEntityIds: [lilia.id], lat: 40.7081, lon: -73.9571, radiusM: 30_000, onlyEntityIds: [standIn.entity!.id], take: 1 });
    expect(only.map((e) => e.id)).toEqual([standIn.entity!.id]);
    // and a re-plan after the model-alone run proposes none of them
    const plan1 = planOf((await runAgent(req, { scripted: true, qloo: mockQloo })).events);
    for (const s of plan1.swaps) expect(ids.has(s.to.entity.id) && mockEntityById(s.to.entity.id)?.standIn).toBeFalsy();
  });

  it("aggregates honestly, including a row the model wins", async () => {
    const { proofSide } = await import("./proof");
    const pick = (aff: number | undefined, tags: number, from: 1 | 2 | 3 | 4, to: 1 | 2 | 3 | 4, save: number) => ({
      merchantKey: `k${save}`, fromName: "A", pickName: "B", affinity: aff, sharedTagIds: Array.from({ length: tags }, (_, i) => `t${i}`), fromPriceLevel: from, priceLevel: to, cheaper: to < from, monthlySavings: save,
    });
    const side = proofSide([pick(0.5, 0, 3, 1, 200), pick(undefined, 1, 2, 3, -20)], 3, false);
    expect(side).toMatchObject({ of: 3, picks: 2, tasteLink: 0.5, tasteScored: 1, sharedTags: 1, cheaper: 1, monthlySavings: 180 });
    expect(side.exists).toBeUndefined();
  });

  it("writes one long hero bridge and short per-swap notes", async () => {
    const plan = planOf((await runAgent(persona("maya-williamsburg"), { scripted: true, qloo: mockQloo })).events);
    const hero = plan.heroBridge!;
    const s = plan.swaps.find((x) => x.id === hero.swapId)!;
    expect(s.merchantKey).toBe(hero.merchantKey);
    expect(hero.text.length).toBeLessThanOrEqual(72);
    expect(hero.text).toContain(s.from.name);
    // the hero swap is the one with the bridge entity Qloo rates most popular across all swaps
    const all = plan.swaps.flatMap((x) => x.to.evidence.crossDomain ?? []).filter((c) => c.entity.popularity !== undefined);
    const top = all.sort((a, b) => b.entity.popularity! - a.entity.popularity!)[0];
    expect(hero.text).toContain(top.entity.name);
    expect(s.to.evidence.crossDomain!.some((c) => c.entity.id === top.entity.id)).toBe(true);
    for (const x of plan.swaps) expect(x.crossDomainNote!.length).toBeLessThanOrEqual(40);
  });

  it("announces merged lines in the first event, before any row is resolved", async () => {
    const { events } = await runAgent(persona("maya-williamsburg"), { scripted: true, qloo: mockQloo });
    const start = events[0];
    expect(start.type === "run_started" && start.merges).toEqual([{ merchantKey: "SQ BLUE BTL", mergedKeys: ["SQ BLUE BOTTLE COFFE"] }]);
    const line = planOf(events).receipt!.lines.find((l) => l.merchantKey === "SQ BLUE BTL")!;
    expect(line.mergedKeys).toEqual(["SQ BLUE BOTTLE COFFE"]);
    // the first merchants_resolved already lists the merged-away key under the merged line
    const first = events.find((e) => e.type === "merchants_resolved");
    expect(first?.type === "merchants_resolved" && first.resolutions.filter((r) => /BLUE B/.test(r.merchantKey)).map((r) => r.entity?.id)).toEqual(
      expect.arrayContaining([expect.any(String), expect.any(String)]),
    );
  });

  it("scripted model-alone guesses are the recorded fair baseline's own picks", async () => {
    const { SNAPSHOTS } = await import("../../personas/snapshots");
    const { llmSuggest } = await import("./baseline");
    const snap = SNAPSHOTS["maya-williamsburg"];
    const base = snap.llm_only.find((e) => e.type === "baseline_ready");
    const recorded = base?.type === "baseline_ready" ? base.suggestions : [];
    expect(recorded.length).toBeGreaterThan(0);
    const out = await llmSuggest(recorded.map((s) => ({ key: s.merchantKey, name: s.fromName, category: "restaurant" as const })), "Williamsburg, Brooklyn, NY", {});
    expect(out.map((s) => s.suggestedName)).toEqual(recorded.map((s) => s.suggestedName));
  });
});
