/**
 * Scripted model: a deterministic LanguageModel that drives the same tool
 * loop without an LLM. Used in dev and tests when no Anthropic key is set
 * (AGENT_SCRIPTED=1, or no key outside production). It reads the run state
 * and emits the next batch of tool calls.
 */
import type { LanguageModel } from "ai";
import { estimateSwapSavings } from "../savings/engine";
import { defaultKeepReason } from "./candidates";
import type { MerchantState, RunState } from "./state";

type V4Model = Extract<LanguageModel, { specificationVersion: "v4" }>;
type Call = { toolName: string; input: Record<string, unknown> };

const chunk = <T,>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

export function nextScriptedCalls(state: RunState, tried: Set<string>): { text?: string; calls: Call[] } {
  if (!state.normalized) return { text: "Reading your statement.", calls: [{ toolName: "normalize_merchants", input: {} }] };
  const focus = state.focus().filter((m) => m.needsWork);

  const unsearched = focus.filter((m) => !m.searched && !m.resolution);
  if (unsearched.length) {
    return {
      text: `Looking up your top ${unsearched.length} merchants in Qloo.`,
      calls: chunk(unsearched, 15).map((ms) => ({ toolName: "qloo_search", input: { items: ms.map((m) => ({ merchantKey: m.agg.key })) } })),
    };
  }

  const calls: Call[] = [];
  for (const m of focus.filter((x) => x.resolution?.status === "ambiguous" && !x.asked)) {
    calls.push({ toolName: "ask_user", input: { merchantKey: m.agg.key, prompt: `Which ${m.norm?.name ?? m.agg.rawMerchant} did you mean?` } });
  }
  if (!state.fingerprintTried && focus.some((m) => m.entity)) calls.push({ toolName: "qloo_taste_profile", input: {} });
  if (calls.length) return { text: "Reading your taste across music, film and brands.", calls };

  const fresh = focus.filter((m) => m.entity && m.insightsAttempts === 0 && !m.swap);
  if (fresh.length) {
    return {
      text: "Searching for taste twins one price level down.",
      calls: chunk(fresh, 8).map((ms) => ({
        toolName: "qloo_insights",
        input: { queries: ms.map((m) => ({ merchantKey: m.agg.key, ...(m.radiusM ? { radiusM: m.radiusM } : {}) })) },
      })),
    };
  }

  const retry = focus.filter(
    (m) => m.entity && m.insightsAttempts === 1 && !m.candidates.length && m.entity.priceLevel !== 1 && !m.swap,
  );
  if (retry.length && state.budget.remaining >= retry.length) {
    return {
      text: "Widening the search radius for the rest.",
      calls: chunk(retry, 8).map((ms) => ({
        toolName: "qloo_insights",
        input: {
          queries: ms.map((m) => ({
            merchantKey: m.agg.key,
            radiusM: Math.min(20_000, Math.round((m.radiusM ?? state.loc.radiusM) * 2.5)),
          })),
        },
      })),
    };
  }

  const toPropose = focus.filter((m) => m.candidates.length && !m.swap && !tried.has(m.agg.key));
  if (toPropose.length) {
    const out: Call[] = [];
    // one twin per place across the plan
    const taken = new Set(state.allSwaps().filter((s) => s.status !== "rejected").map((s) => s.to.entity.id));
    for (const m of toPropose) {
      tried.add(m.agg.key);
      const best = bestSaving(m, taken);
      if (!best) continue;
      taken.add(best.entity.id);
      const alts = m.candidates.filter((c) => c.candidateId !== best.candidateId).slice(0, 2).map((c) => c.candidateId);
      out.push({
        toolName: "propose_swap",
        input: {
          merchantKey: m.agg.key,
          candidateId: best.candidateId,
          rationale: `${best.entity.name} scores ${best.evidence.affinity?.toFixed(2) ?? "high"} on Qloo affinity with ${m.entity!.name}${best.reasons[0] ? `; ${best.reasons[0].toLowerCase()}` : ""}.`,
          keepReason: defaultKeepReason(best),
          alternativeCandidateIds: alts,
        },
      });
    }
    if (out.length) return { text: "Here are the swaps worth making.", calls: out };
  }

  return { text: "Writing your 30-day plan.", calls: [{ toolName: "plan_writer", input: { summary: "" } }] };
}

function bestSaving(m: MerchantState, taken: Set<string>) {
  return m.candidates.find(
    (c) =>
      !taken.has(c.entity.id) &&
      estimateSwapSavings({
        category: m.norm?.category ?? "other",
        count: m.agg.count,
        totalSpend: m.agg.totalSpend,
        windowDays: m.agg.windowDays,
        fromPriceLevel: m.entity?.priceLevel,
        toPriceLevel: c.entity.priceLevel,
        distanceKm: c.evidence.distanceKm,
        affinity: c.evidence.affinity,
      }).monthlySavings > 0,
  );
}

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

export function scriptedModel(state: RunState): LanguageModel {
  const tried = new Set<string>();
  let n = 0;
  const model: V4Model = {
    specificationVersion: "v4",
    provider: "sametaste",
    modelId: "scripted",
    supportedUrls: {},
    async doGenerate(options) {
      const forced = options.toolChoice?.type === "tool" ? options.toolChoice.toolName : undefined;
      const next = nextScriptedCalls(state, tried);
      const { text, calls } =
        forced && !next.calls.every((c) => c.toolName === forced)
          ? { text: "Writing your plan with what I have.", calls: [{ toolName: forced, input: forced === "plan_writer" ? { summary: "" } : {} }] }
          : next;
      return {
        content: [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...calls.map((c) => ({
            type: "tool-call" as const,
            toolCallId: `scripted_${++n}`,
            toolName: c.toolName,
            input: JSON.stringify(c.input),
          })),
        ],
        finishReason: { unified: calls.length ? "tool-calls" : "stop", raw: undefined },
        usage: ZERO_USAGE,
        warnings: [],
      };
    },
    async doStream() {
      throw new Error("scripted model supports generate only");
    },
  } as V4Model;
  return model;
}
