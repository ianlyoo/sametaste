/**
 * The SameTaste agent run: a streaming tool loop (AI SDK generateText with
 * tools) plus guards: <= 12 tool turns, <= 40 Qloo calls, per-run cost
 * ceiling, global spend ledger, deterministic plan fallback.
 */
import { generateText, hasToolCall, isStepCount, type LanguageModel, type LanguageModelUsage, type StopCondition } from "ai";
import { AgentRequestSchema, type AgentEvent, type ParsedAgentRequest } from "../contract";
import { CallBudget, QlooClient } from "../qloo/client";
import type { QlooEntity } from "../qloo/types";
import { DEFAULT_LIMITS, type AgentLimits } from "./config";
import { EventSink } from "./events";
import { checkSuggestions, llmSuggest, type BaselineMerchant } from "./baseline";
import { normalizeByRules } from "./normalize";
import { pickResolution, toRef } from "./resolve";
import { costUsd } from "./pricing";
import { proofSide, scorePick } from "./proof";
import { SYSTEM_PROMPT, userPrompt } from "./prompt";
import { scriptedModel } from "./scripted";
import type { SpendLedger } from "./spend";
import { RunState } from "./state";
import { coverAndFinalize, createTools, finalizePlan, type AgentTools } from "./tools";

export interface RunDeps {
  /** Main model; omit together with scripted=true for the no-LLM driver. */
  model?: LanguageModel;
  modelId?: string;
  normalizerModel?: LanguageModel;
  normalizerModelId?: string;
  scripted?: boolean;
  qloo?: (budget: CallBudget) => QlooClient;
  ledger?: SpendLedger;
  limits?: Partial<AgentLimits>;
  runId?: string;
  abortSignal?: AbortSignal;
  write?: (ev: AgentEvent) => void;
  /** Marks run_started as served from a cache or built-in snapshot. */
  fromCache?: boolean;
  /** Server-side error hook (never forwarded to the client). */
  onError?: (err: unknown) => void;
}

export interface RunResult {
  runId: string;
  events: AgentEvent[];
  state: RunState;
}

export async function runAgent(input: ParsedAgentRequest | unknown, deps: RunDeps): Promise<RunResult> {
  const req = AgentRequestSchema.parse(input);
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const runId = deps.runId ?? crypto.randomUUID();
  const sink = new EventSink(runId, deps.write);
  const budget = new CallBudget(limits.maxQlooCalls);
  const qloo = deps.qloo ? deps.qloo(budget) : new QlooClient({ budget });
  const state = new RunState(runId, req, qloo, budget, sink, limits);

  // one place under two descriptors merges before any event, so no row changes mid-run
  state.mergeDuplicates((m) => {
    const n = normalizeByRules(m.agg);
    return n.skip ? undefined : n.name;
  });
  const merges = state.merges();
  sink.emit({ type: "run_started", mode: req.mode, qlooMock: qloo.mock, fromCache: deps.fromCache ?? false, ...(merges.length ? { merges } : {}) });

  const recordUsage = async (modelId: string, usage: LanguageModelUsage | undefined) => {
    const c = costUsd(modelId, usage);
    state.costUsd += c;
    if (deps.ledger && c > 0) {
      try {
        const s = await deps.ledger.record(c);
        // a cap crossed by the step that wrote the plan does not cut the run short
        if (s.blocked && !state.plan) state.stopReason = "spend_cap";
      } catch (err) {
        // fail closed: spend we cannot record stops the run
        deps.onError?.(err);
        state.stopReason = "spend_cap";
      }
    }
    if (state.costUsd >= limits.perRunCostCapUsd && !state.plan) state.stopReason ??= "run_cost_cap";
  };

  let failed = false;
  try {
    if (req.mode === "llm_only") {
      await runBaseline(state, deps, recordUsage);
    } else {
      await applyRequestContext(state);
      await runLoop(state, deps, limits, recordUsage);
    }
  } catch (err) {
    failed = true;
    deps.onError?.(err);
    sink.emit({
      type: "error",
      code: isAbort(err) ? "internal" : "model_error",
      message: isAbort(err) ? "The run was cancelled." : "The agent hit an error; showing what it found so far.",
      retryable: true,
    });
  }

  if (req.mode === "sametaste" && !state.plan) {
    sink.emit({ type: "status", phase: "planning", message: "Finishing the plan from what I found." });
    if (deps.abortSignal?.aborted) finalizePlan(state);
    else await coverAndFinalize(state);
  }

  const awaiting = state.questions.length > 0;
  sink.emit({
    type: "done",
    reason: failed ? "error" : state.stopReason ? "limit_reached" : awaiting ? "awaiting_answer" : "complete",
    usage: { toolTurns: state.toolTurns, qlooCalls: qloo.calls, costUsd: Math.round(state.costUsd * 10_000) / 10_000 },
  });
  return { runId, events: sink.events, state };
}

function isAbort(err: unknown) {
  return err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message));
}

async function runLoop(
  state: RunState,
  deps: RunDeps,
  limits: AgentLimits,
  recordUsage: (modelId: string, u: LanguageModelUsage | undefined) => Promise<void>,
) {
  const model = deps.scripted || !deps.model ? scriptedModel(state) : deps.model;
  const tools = createTools(state, {
    normalizerModel: deps.scripted ? undefined : deps.normalizerModel,
    normalizerModelId: deps.normalizerModelId,
    onUsage: (id, u) => void recordUsage(id, u),
    abortSignal: deps.abortSignal,
  });
  const costStop: StopCondition<AgentTools> = () => state.stopReason !== undefined;

  state.sink.emit({ type: "status", phase: "normalizing", message: "Reading your statement." });
  await generateText({
    model,
    instructions: SYSTEM_PROMPT,
    prompt: userPrompt(state),
    tools,
    stopWhen: [isStepCount(limits.maxToolTurns), hasToolCall("plan_writer"), costStop],
    prepareStep: ({ stepNumber }) =>
      stepNumber >= limits.maxToolTurns - 1 && !state.plan
        ? { toolChoice: { type: "tool", toolName: "plan_writer" } as const }
        : {},
    onStepEnd: async (step) => {
      state.toolTurns++;
      await recordUsage(step.model.modelId, step.usage);
      const text = step.text?.trim();
      if (text) state.sink.emit({ type: "message", text: text.slice(0, 600) });
      const phase = phaseFor(step.toolCalls.map((c) => c.toolName));
      if (phase) state.sink.emit({ type: "status", phase, message: PHASE_TEXT[phase] });
    },
    maxRetries: 1,
    abortSignal: deps.abortSignal,
  });
  if (state.stopReason) {
    state.sink.emit({
      type: "error",
      code: state.stopReason === "spend_cap" ? "spend_cap" : "limit_reached",
      message:
        state.stopReason === "spend_cap"
          ? "The demo's spending cap was reached mid-run; here is what I found."
          : "This run reached its cost limit; here is what I found.",
      retryable: false,
    });
  }
}

const PHASE_TEXT = {
  normalizing: "Reading your statement.",
  resolving: "Matching merchants to the Qloo taste graph.",
  ranking: "Ranking where a swap is worth it.",
  searching: "Searching taste twins.",
  scoring: "Scoring swaps and savings.",
  planning: "Writing your 30-day plan.",
  done: "Done.",
} as const;

function phaseFor(tools: string[]): keyof typeof PHASE_TEXT | undefined {
  if (tools.includes("plan_writer")) return "done";
  if (tools.includes("propose_swap")) return "planning";
  if (tools.includes("qloo_insights")) return "scoring";
  if (tools.includes("qloo_taste_profile") || tools.includes("ask_user")) return "searching";
  if (tools.includes("qloo_search")) return "ranking";
  if (tools.includes("normalize_merchants")) return "resolving";
  return undefined;
}

/** Applies previous plan, swap feedback and answers before the loop. */
export async function applyRequestContext(state: RunState) {
  const { req } = state;
  const fb = new Map((req.feedback ?? []).map((f) => [f.swapId, f]));
  for (const f of req.feedback ?? []) {
    const m = state.get(f.merchantKey);
    if (!m || f.verdict !== "reject") continue;
    m.excludeIds.add(f.candidateEntityId);
    m.rejectedReason = f.reason;
    const r = (f.reason ?? "").toLowerCase();
    if (/far|distance|close|walk|commute/.test(r)) m.radiusM = Math.max(500, Math.round(state.loc.radiusM / 2));
    // "too pricey": twins stay exactly one level down (honest twins), so only the exclusion applies
  }
  for (const s of req.previousPlan?.swaps ?? []) {
    const m = state.get(s.merchantKey);
    if (!m) continue;
    const f = fb.get(s.id);
    if (f?.verdict === "reject" || s.status === "rejected") continue;
    m.carried = { ...s, status: f?.verdict === "accept" || s.status === "accepted" ? "accepted" : s.status };
    m.needsWork = false;
  }
  if (req.previousPlan?.fingerprint) {
    // keep the taste fingerprint stable across re-plans (and save Qloo calls)
    state.fingerprint = req.previousPlan.fingerprint;
    state.fingerprintTried = true;
  }
  if (req.previousPlan) {
    // merchants analysed before without a swap and without feedback stay done
    for (const u of req.previousPlan.unswapped) {
      const m = state.get(u.merchantKey);
      const answered = req.answers?.some((a) => a.merchantKey === u.merchantKey || a.questionId === `q:${u.merchantKey}`);
      if (m && !answered && !/not analysed/i.test(u.reason)) m.needsWork = false;
    }
  }
  for (const a of req.answers ?? []) {
    const key = a.merchantKey ?? a.questionId.replace(/^q:/, "");
    const m = state.get(key);
    if (!m) continue;
    const norm = normalizeByRules(m.agg);
    if (a.optionId === "none" && !a.text) {
      m.norm = norm;
      m.searched = true;
      m.needsWork = false;
      m.resolution = { merchantKey: key, rawMerchant: m.agg.rawMerchant, normalizedName: norm.name, category: norm.category, status: "unresolved", confidence: 1, source: "user_answer" };
      continue;
    }
    const query = a.text?.trim() || norm.name;
    try {
      const results = await state.qloo.search({ query, types: [norm.entityType], lat: state.loc.lat, lon: state.loc.lon, radiusMiles: 15, take: 6 });
      const chosen = a.entityId ? results.find((e) => e.id === a.entityId) : undefined;
      m.norm = { ...norm, name: a.text?.trim() || norm.name };
      m.searched = true;
      m.needsWork = true;
      if (chosen) {
        m.norm = { ...m.norm, name: chosen.name };
        m.entity = chosen;
        m.resolution = { merchantKey: key, rawMerchant: m.agg.rawMerchant, normalizedName: chosen.name, category: norm.category, entityType: chosen.type, status: "resolved", entity: toRef(chosen), confidence: 1, source: "user_answer" };
      } else {
        const o = pickResolution(m.norm, results, state.loc);
        m.entity = o.entity;
        m.options = o.options;
        m.resolution = { ...o.resolution, source: "user_answer" };
        m.asked = true;
      }
    } catch {
      // leave it for the loop
    }
  }
  if (req.answers?.length || req.feedback?.length) {
    const resolutions = [...state.merchants.values()].map((m) => m.resolution).filter((r) => !!r);
    if (resolutions.length) state.sink.emit({ type: "merchants_resolved", resolutions });
  }
}

async function runBaseline(
  state: RunState,
  deps: RunDeps,
  recordUsage: (modelId: string, u: LanguageModelUsage | undefined) => Promise<void>,
) {
  const { sink } = state;
  sink.emit({ type: "status", phase: "normalizing", message: "Asking the model alone, without Qloo." });
  // the same merchant list the SameTaste run works on (rules normalisation, merged duplicate lines)
  for (const m of state.merchants.values()) m.norm ??= normalizeByRules(m.agg);
  state.mergeDuplicates();
  const merchants = state
    .focus()
    .map((m) => ({ m, n: m.norm! }))
    // three Qloo calls per line: the original, the pick, the pick's affinity to the original
    .slice(0, Math.min(state.limits.maxMerchants, Math.floor(state.limits.maxQlooCalls / 3)));
  const list: (BaselineMerchant & { entity?: QlooEntity })[] = merchants.map(({ m, n }) => ({
    key: m.agg.key,
    name: n.name,
    category: n.category,
    rawMerchant: m.agg.rawMerchant,
    visitsPerMonth: m.visitsPerMonth,
    monthlySpend: m.monthlySpend,
  }));
  const suggestions = await llmSuggest(list, state.req.location.label, {
    model: deps.scripted ? undefined : deps.model,
    onUsage: (u) => void recordUsage(deps.modelId ?? "unknown", u),
    abortSignal: deps.abortSignal,
  });
  sink.emit({ type: "status", phase: "resolving", message: "Checking each suggestion against Qloo." });
  // resolve the originals, as the SameTaste run does: price level, tags, the proof's signal
  for (const x of list) {
    const n = merchants.find((y) => y.m.agg.key === x.key)!.n;
    try {
      const res = await state.qloo.search({ query: n.name, types: ["place"], lat: state.loc.lat, lon: state.loc.lon, radiusMiles: 15, take: 5 });
      x.entity = pickResolution(n, res, state.loc).entity;
    } catch {
      // unresolved: its pick is listed but cannot be scored
    }
  }
  const checked = await checkSuggestions(state.qloo, suggestions, new Map(list.map((x) => [x.key, x])), state.loc);
  // the model's side of the measured proof: the same Qloo calls as our twins (lib/agent/proof.ts)
  const picks = [];
  for (const c of checked) {
    const x = list.find((y) => y.key === c.suggestion.merchantKey)!;
    const m = merchants.find((y) => y.m.agg.key === x.key)!.m;
    picks.push(
      await scorePick(state.qloo, state.loc, {
        merchantKey: x.key,
        fromName: x.name,
        category: x.category,
        count: m.agg.count,
        totalSpend: m.agg.totalSpend,
        windowDays: m.agg.windowDays,
        currency: m.agg.currency,
        from: x.entity,
        pickName: c.suggestion.suggestedName,
        pick: c.hit,
        exists: c.exists,
        claimedHood: c.suggestion.suggestedNeighborhood,
        searchedKm: c.searchedKm,
      }),
    );
  }
  sink.emit({ type: "baseline_ready", suggestions: checked.map((c) => c.suggestion), proof: proofSide(picks, list.length, state.qloo.mock, undefined, { nearestBranch: true }) });
  state.toolTurns = 1;
}
