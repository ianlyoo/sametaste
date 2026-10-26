// Synthetic events for tests. Invented data only; no Qloo responses.
import type { AgentEvent, Plan, Swap } from "../../contract";

let seq = 0;
const base = (runId = "r1") => ({ runId, seq: seq++, ts: "2026-10-22T07:00:00.000Z" });

export function swap(id: string, merchantKey: string, to: string, monthlySavings = 50): Swap {
  return {
    id,
    merchantKey,
    category: "restaurant",
    from: { name: merchantKey, visitsPerMonth: 3, monthlySpend: 300, avgTicket: 100 },
    to: {
      candidateId: `c-${id}`,
      merchantKey,
      entity: { id: `e-${to}`, name: to, type: "place", priceLevel: 2 },
      evidence: { entityId: `e-${to}`, signalEntityId: `e-${merchantKey}`, affinity: 0.87, tags: [], query: "place near Williamsburg" },
      score: 0.8,
      reasons: ["Loved by the same fans"],
    },
    savings: {
      currency: "USD",
      visitsPerMonth: 3,
      ticketBefore: 100,
      ticketAfter: 50,
      swapShare: 0.75,
      monthlyBefore: 300,
      monthlyAfter: 300 - monthlySavings,
      monthlySavings,
      annualSavings: monthlySavings * 12,
      method: "observed_ticket",
      confidence: "medium",
      notes: [],
    },
    rationale: "Same handmade pasta, half the ticket.",
    status: "proposed",
  };
}

export function plan(swaps: Swap[]): Plan {
  const monthlySavings = swaps.reduce((a, s) => a + s.savings.monthlySavings, 0);
  return {
    id: "p1",
    createdAt: "2026-10-22T07:00:00.000Z",
    horizonDays: 30,
    currency: "USD",
    location: { label: "Williamsburg, Brooklyn, NY" },
    swaps,
    weeks: [{ week: 1, title: "Start small", actions: [{ text: "Coffee at Variety" }], expectedSavings: monthlySavings / 4 }],
    totals: { monthlyBefore: 1000, monthlyAfter: 1000 - monthlySavings, monthlySavings, annualSavings: monthlySavings * 12, savingsRate: monthlySavings / 1000 },
    unswapped: [],
    summary: "Two swaps.",
  };
}

export const ev = {
  started: (runId = "r1", mode: "sametaste" | "llm_only" = "sametaste"): AgentEvent => ({ ...base(runId), type: "run_started", mode, qlooMock: true, fromCache: false }),
  step: (stepId: string, state: "started" | "finished", qlooCalls?: number): AgentEvent => ({
    ...base(),
    type: "tool_step",
    stepId,
    tool: "qloo_insights",
    state,
    summary: "Asked Qloo",
    ...(qlooCalls !== undefined ? { qlooCalls } : {}),
  }),
  swap: (s: Swap): AgentEvent => ({ ...base(), type: "swap_proposed", swap: s }),
  plan: (p: Plan): AgentEvent => ({ ...base(), type: "plan_ready", plan: p }),
  question: (): AgentEvent => ({
    ...base(),
    type: "question",
    question: { id: "q1", kind: "ambiguous_merchant", merchantKey: "LEO", prompt: "Which Leo?", options: [{ id: "a", label: "Leo, Williamsburg" }], allowFreeText: false },
  }),
  baseline: (): AgentEvent => ({
    ...base("b1"),
    type: "baseline_ready",
    suggestions: [{ merchantKey: "LILIA", fromName: "Lilia", suggestedName: "Bella Napoli", existsInQloo: false }],
  }),
  fingerprint: (): AgentEvent => ({
    ...base(),
    type: "taste_fingerprint",
    fingerprint: {
      sourceEntityIds: ["e-LILIA"],
      sourceNames: ["Lilia"],
      affinities: [{ domain: "artist", entity: { id: "e-a", name: "Mitski", type: "artist" }, affinity: 0.8 }],
      topTags: [{ id: "t1", name: "natural wine" }],
      headline: "Natural-wine bars, indie folk",
    },
  }),
  error: (): AgentEvent => ({ ...base(), type: "error", code: "qloo_error", message: "Qloo timed out", retryable: true }),
  done: (reason: "complete" | "awaiting_answer" | "error" = "complete", runId = "r1"): AgentEvent => ({
    ...base(runId),
    type: "done",
    reason,
    usage: { toolTurns: 4, qlooCalls: 9, costUsd: 0.02 },
  }),
};

/** A fetch that streams the given NDJSON chunks. */
export function fakeFetch(chunks: string[], init: { status?: number; capture?: { body?: unknown } } = {}): typeof fetch {
  return (async (_url: RequestInfo | URL, req?: RequestInit) => {
    if (init.capture) init.capture.body = JSON.parse(String(req?.body));
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
    return new Response(body, { status: init.status ?? 200, headers: { "content-type": "application/x-ndjson" } });
  }) as typeof fetch;
}

export const ndjson = (events: AgentEvent[]) => events.map((e) => JSON.stringify(e) + "\n").join("");
