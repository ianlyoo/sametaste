/**
 * Agent tools (DESIGN §5). Each tool works on the shared RunState, emits
 * tool_step events and returns a compact JSON result to the model.
 */
import { tool, type LanguageModel, type LanguageModelUsage } from "ai";
import { z } from "zod";
import {
  CrossDomainTypeSchema,
  QlooEntityTypeSchema,
  type AgentQuestion,
  type CrossDomainAffinity,
  type CrossDomainType,
  type Plan,
  type ProofPick,
  type ProofSide,
  type Swap,
  type SwapCandidate,
  type ToolName,
} from "../contract";
import { QlooBudgetError } from "../qloo/client";
import { hash32 } from "../qloo/mock/world";
import type { QlooEntity } from "../qloo/types";
import { buildPlan } from "../savings/plan";
import { buildReceipt, type ReceiptMerchant } from "../savings/receipt";
import { estimateSwapSavings } from "../savings/engine";
import { defaultKeepReason, scoreCandidate } from "./candidates";
import { buildFingerprint, fingerprintSignals } from "./fingerprint";
import { categoryFromTags, normalizeByRules, normalizeMerchants } from "./normalize";
import { pickResolution, toRef } from "./resolve";
import type { MerchantState, RunState } from "./state";
import { proofSide, scorePick } from "./proof";
import { KEPT_REASON, keptCounts } from "./proof-rows";
import { normName } from "./text";

export interface ToolDeps {
  normalizerModel?: LanguageModel;
  normalizerModelId?: string;
  onUsage?: (modelId: string, usage: LanguageModelUsage) => void;
  abortSignal?: AbortSignal;
}

type ToolOutput = Record<string, unknown>;

async function step(
  state: RunState,
  name: ToolName,
  startSummary: string,
  fn: () => Promise<{ result: ToolOutput; summary: string }>,
): Promise<ToolOutput> {
  const stepId = `${name}-${state.sink.events.length}`;
  const started = Date.now();
  const calls0 = state.qloo.calls;
  state.sink.emit({ type: "tool_step", stepId, tool: name, state: "started", summary: startSummary });
  try {
    const { result, summary } = await fn();
    state.sink.emit({
      type: "tool_step",
      stepId,
      tool: name,
      state: "finished",
      summary,
      durationMs: Date.now() - started,
      qlooCalls: state.qloo.calls - calls0,
    });
    return result;
  } catch (err) {
    const message =
      err instanceof QlooBudgetError
        ? "Qloo call budget for this run is used up. Propose swaps from the candidates you have and call plan_writer."
        : err instanceof Error
          ? err.message
          : "tool failed";
    state.sink.emit({
      type: "tool_step",
      stepId,
      tool: name,
      state: "failed",
      summary: err instanceof QlooBudgetError ? "Qloo call budget used up" : "Step failed",
      durationMs: Date.now() - started,
      qlooCalls: state.qloo.calls - calls0,
    });
    return { error: message };
  }
}

const money = (n: number) => `$${n.toFixed(2)}`;

/** Emits an ambiguous_merchant question for `m` (once). */
export function askAbout(state: RunState, m: MerchantState, prompt: string, options?: { entityId: string; label: string }[]) {
  if (m.asked) return;
  const opts = options ?? m.options.map((e) => ({ entityId: e.id, label: e.name }));
  const q: AgentQuestion = {
    id: `q:${m.agg.key}`,
    kind: "ambiguous_merchant",
    merchantKey: m.agg.key,
    prompt,
    options: [
      ...opts.map((o, i) => ({
        id: `o${i + 1}`,
        label: o.label,
        detail: m.options.find((e) => e.id === o.entityId)?.address,
        entityId: o.entityId,
      })),
      { id: "none", label: "None of these" },
    ],
    allowFreeText: true,
  };
  m.asked = true;
  state.questions.push(q);
  state.sink.emit({ type: "question", question: q });
}

function merchantName(m: MerchantState): string {
  return m.norm?.name ?? m.agg.rawMerchant;
}

export function createTools(state: RunState, deps: ToolDeps = {}) {
  const ownEntityIds = () =>
    new Set([...state.merchants.values()].map((m) => m.entity?.id).filter((x): x is string => !!x));
  // The model may call propose_swap and plan_writer in one step; the plan waits for those swaps.
  const proposing = new Set<Promise<unknown>>();

  return {
    normalize_merchants: tool({
      description:
        "Clean raw card-statement descriptors into canonical merchant names, categories and Qloo entity types, and flag non-taste spend (rent, transfers, bills, transport) as skip. Call once at the start.",
      inputSchema: z.object({
        keys: z.array(z.string()).max(200).optional().describe("Ignored; every merchant is normalised"),
      }),
      execute: async ({ keys }) =>
        step(state, "normalize_merchants", "Reading your statement lines", async () => {
          // always all of them: the plan and the receipt need every line
          void keys;
          const todo = [...state.merchants.values()].filter((m) => !m.norm);
          if (todo.length) {
            const res = await normalizeMerchants(
              todo.map((m) => m.agg),
              { model: deps.normalizerModel, modelId: deps.normalizerModelId, city: state.req.location.label, abortSignal: deps.abortSignal },
            );
            if (res.usage && res.modelId) deps.onUsage?.(res.modelId, res.usage as LanguageModelUsage);
            for (const n of res.merchants) state.get(n.key)!.norm = n;
          }
          state.mergeDuplicates();
          state.normalized = true;
          const focus = state.focus();
          const skipped = [...state.merchants.values()].filter((m) => m.norm?.skip);
          return {
            summary: `Recognised ${focus.length} taste merchants; set aside ${skipped.length} bills and transfers`,
            result: {
              focus: focus.map((m) => ({
                key: m.agg.key,
                name: merchantName(m),
                category: m.norm?.category,
                entityType: m.norm?.entityType,
                monthlySpend: Math.round(m.monthlySpend),
                visitsPerMonth: Math.round(m.visitsPerMonth * 10) / 10,
                confidence: m.norm?.confidence,
                ...(m.mergedKeys.length ? { mergedKeys: m.mergedKeys } : {}),
              })),
              skipped: skipped.map((m) => ({ key: m.agg.key, name: merchantName(m), reason: m.norm?.skipReason })),
            },
          };
        }),
    }),

    qloo_search: tool({
      description:
        "Resolve merchants to Qloo entities with GET /search near the user's location. Returns resolved / ambiguous (ask the user) / unresolved for each.",
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              merchantKey: z.string(),
              name: z.string().max(120).optional().describe("Override the normalised name for this search"),
              entityType: QlooEntityTypeSchema.optional(),
            }),
          )
          .min(1)
          .max(15),
      }),
      execute: async ({ items }) =>
        step(state, "qloo_search", `Looking up ${items.length} merchants in Qloo`, async () => {
          const out: ToolOutput[] = [];
          let resolved = 0;
          // never leave a focus merchant unsearched (models skip low-spend lines)
          const asked = new Set(items.map((i) => i.merchantKey));
          const extra = state
            .focus()
            .filter((m) => m.norm && !m.norm.skip && m.needsWork && !m.searched && !m.resolution && !asked.has(m.agg.key))
            .slice(0, Math.max(0, 15 - items.length))
            .map((m) => ({ merchantKey: m.agg.key, name: undefined, entityType: undefined }));
          items = [...items, ...extra];
          for (const it of items) {
            const m = state.get(it.merchantKey);
            if (!m || !m.norm) {
              out.push({ merchantKey: it.merchantKey, error: "unknown merchant or not normalised yet" });
              continue;
            }
            if (m.norm.skip) {
              out.push({ merchantKey: it.merchantKey, status: "skipped" });
              continue;
            }
            if (m.resolution?.source === "user_answer" && m.entity) {
              // the user's answer is final
              resolved++;
              out.push({ merchantKey: it.merchantKey, status: "resolved", note: "confirmed by the user", entity: { id: m.entity.id, name: m.entity.name, priceLevel: m.entity.priceLevel } });
              continue;
            }
            const norm = { ...m.norm, name: it.name ?? m.norm.name, entityType: it.entityType ?? m.norm.entityType };
            const geo = norm.entityType === "place";
            const results = await state.qloo.search({
              query: norm.name,
              types: [norm.entityType],
              lat: geo ? state.loc.lat : undefined,
              lon: geo ? state.loc.lon : undefined,
              radiusMiles: geo ? 15 : undefined,
              take: 6,
            });
            const o = pickResolution(norm, results, geo ? state.loc : undefined);
            m.norm = norm.category === "other" && o.entity ? { ...norm, category: categoryFromTags(o.entity.tags) ?? "other" } : norm;
            m.searched = true;
            // the line's own key, also when the model asked under a merged-away descriptor
            m.resolution = { ...o.resolution, merchantKey: m.agg.key, rawMerchant: m.agg.rawMerchant };
            m.entity = o.entity;
            m.options = o.options;
            if (o.resolution.status === "resolved") resolved++;
            out.push({
              merchantKey: it.merchantKey,
              status: o.resolution.status,
              entity: o.entity ? { id: o.entity.id, name: o.entity.name, priceLevel: o.entity.priceLevel, address: o.entity.address } : undefined,
              options:
                o.resolution.status === "ambiguous"
                  ? o.options.map((e) => ({ entityId: e.id, name: e.name, address: e.address }))
                  : undefined,
            });
          }
          const resolutions = [...state.merchants.values()].filter((m) => !m.mergedInto).map((m) => m.resolution).filter((r) => !!r);
          state.sink.emit({ type: "merchants_resolved", resolutions: [...resolutions, ...state.mergedResolutions()] });
          return { summary: `Found ${resolved} of ${items.length} merchants in Qloo`, result: { results: out } };
        }),
    }),

    ask_user: tool({
      description:
        "Ask the user which entity they meant when a merchant is ambiguous. The run continues; the answer arrives in a follow-up request. Do not block on it.",
      inputSchema: z.object({
        merchantKey: z.string(),
        prompt: z.string().max(200),
        options: z
          .array(z.object({ entityId: z.string(), label: z.string().max(120) }))
          .max(5)
          .optional(),
      }),
      execute: async ({ merchantKey, prompt, options }) =>
        step(state, "ask_user", "Checking with you", async () => {
          const m = state.get(merchantKey);
          if (!m) return { summary: "Unknown merchant", result: { error: "unknown merchant" } };
          if (m.asked) return { summary: "Already asked", result: { ok: true, note: "already asked" } };
          askAbout(state, m, prompt, options);
          return { summary: `Asked about ${merchantName(m)}`, result: { ok: true, note: "Question sent. Continue with the other merchants." } };
        }),
    }),

    qloo_taste_profile: tool({
      description:
        "Cross-domain taste fingerprint: query Qloo /v2/insights for artists, movies and brands using the user's resolved places as signals. Use once after resolving; the result also sharpens swap search.",
      inputSchema: z.object({
        merchantKeys: z.array(z.string()).max(5).optional().describe("Default: top resolved merchants by spend"),
        domains: z.array(CrossDomainTypeSchema).min(1).max(3).optional(),
      }),
      execute: async ({ merchantKeys, domains }) =>
        step(state, "qloo_taste_profile", "Reading your taste across music, film and brands", async () => {
          if (state.fingerprint) {
            return { summary: "Taste fingerprint ready", result: compactFingerprint(state) };
          }
          state.fingerprintTried = true;
          const pool = (merchantKeys?.length ? merchantKeys.map((k) => state.get(k)) : state.focus())
            .filter((m): m is MerchantState => !!m?.entity)
            .slice(0, 5)
            .map((m) => m.entity!);
          if (!pool.length) return { summary: "No resolved merchants yet", result: { error: "resolve merchants first" } };
          state.fingerprint = await buildFingerprint(state.qloo, pool, { domains });
          state.sink.emit({ type: "taste_fingerprint", fingerprint: state.fingerprint });
          return { summary: state.fingerprint.headline, result: compactFingerprint(state) };
        }),
    }),

    qloo_insights: tool({
      description:
        "Find taste-equivalent swaps for resolved merchants with GET /v2/insights: signal = the merchant (plus top fingerprint entities), near the user. Twins are exactly one price level cheaper and share at least one Qloo taste tag with the merchant; anything else is dropped. Widen radiusM or relax minRating if nothing comes back.",
      inputSchema: z.object({
        queries: z
          .array(
            z.object({
              merchantKey: z.string(),
              radiusM: z.number().int().min(300).max(20_000).optional(),
              minRating: z.number().min(0).max(5).optional(),
              tags: z.array(z.string()).max(5).optional().describe("Qloo tag ids from qloo_tags"),
              useFingerprint: z.boolean().optional().describe("Add fingerprint entities as signals; default true"),
            }),
          )
          .min(1)
          .max(8),
      }),
      execute: async ({ queries }) =>
        step(state, "qloo_insights", `Searching taste twins for ${queries.length} merchants`, async () => {
          const out: ToolOutput[] = [];
          let found = 0;
          const own = ownEntityIds();
          for (const q of queries) {
            const m = state.get(q.merchantKey);
            if (!m?.entity) {
              out.push({ merchantKey: q.merchantKey, error: "not resolved" });
              continue;
            }
            if (!m.needsWork) {
              out.push({ merchantKey: q.merchantKey, error: "settled in the previous plan; leave it" });
              continue;
            }
            const from = m.entity;
            const res = await findTwins(state, m, from, q, own);
            if (res.candidates.length) found++;
            out.push(res.out);
          }
          return { summary: `Found taste twins for ${found} of ${queries.length} merchants`, result: { results: out } };
        }),
    }),

    qloo_tags: tool({
      description: "Look up Qloo tag ids (GET /v2/tags) to filter insights, e.g. 'outdoor seating' or 'vegan'.",
      inputSchema: z.object({ query: z.string().min(2).max(60), entityType: QlooEntityTypeSchema.optional() }),
      execute: async ({ query, entityType }) =>
        step(state, "qloo_tags", `Looking up Qloo tags for "${query}"`, async () => {
          const tags = await state.qloo.tags({ query, parentTypes: [entityType ?? "place"], take: 8 });
          return { summary: `Found ${tags.length} tags`, result: { tags } };
        }),
    }),

    savings_engine: tool({
      description: "Deterministic savings estimate for a candidate (price tier x your ticket x frequency). Use for what-ifs; propose_swap computes it too.",
      inputSchema: z.object({
        merchantKey: z.string(),
        candidateId: z.string(),
        swapShare: z.number().min(0).max(1).optional(),
      }),
      execute: async ({ merchantKey, candidateId, swapShare }) =>
        step(state, "savings_engine", "Estimating savings", async () => {
          const m = state.get(merchantKey);
          const c = state.findCandidate(merchantKey, candidateId);
          if (!m || !c) return { summary: "Unknown candidate", result: { error: "unknown merchant or candidate" } };
          const e = estimate(state, m, c, swapShare);
          return { summary: `${c.entity.name}: about ${money(e.monthlySavings)} a month`, result: { ...e, notes: undefined } };
        }),
    }),

    propose_swap: tool({
      description:
        "Propose one swap to the user (shown as a card). Only for a candidate from qloo_insights; each place can be the twin of one merchant only. keepReason is a short 'what you keep' line for the Taste Receipt, e.g. 'Same natural-wine list and candlelit room'.",
      inputSchema: z.object({
        merchantKey: z.string(),
        candidateId: z.string(),
        rationale: z.string().max(400),
        keepReason: z.string().max(120),
        alternativeCandidateIds: z.array(z.string()).max(3).optional(),
      }),
      execute: async ({ merchantKey, candidateId, rationale, keepReason, alternativeCandidateIds }) => {
        const p = step(state, "propose_swap", "Preparing a swap", () =>
          proposeSwap(state, { merchantKey, candidateId, rationale, keepReason, alternativeCandidateIds }),
        );
        proposing.add(p);
        try {
          return await p;
        } finally {
          proposing.delete(p);
        }
      },
    }),

    plan_writer: tool({
      description: "Write the 30-day plan from the proposed swaps and end the run. summary: one or two sentences for the user.",
      inputSchema: z.object({ summary: z.string().max(400) }),
      execute: async ({ summary }) =>
        step(state, "plan_writer", "Writing your 30-day plan", async () => {
          await new Promise((r) => setTimeout(r, 0));
          await Promise.allSettled([...proposing]);
          const plan = await coverAndFinalize(state, summary);
          return {
            summary: `Plan ready: ${money(plan.totals.monthlySavings)} a month`,
            result: { planId: plan.id, swaps: plan.swaps.length, monthlySavings: plan.totals.monthlySavings },
          };
        }),
    }),
  };
}

export type AgentTools = ReturnType<typeof createTools>;

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function estimate(state: RunState, m: MerchantState, c: SwapCandidate, swapShare?: number) {
  return estimateSwapSavings({
    category: m.norm?.category ?? "other",
    count: m.agg.count,
    totalSpend: m.agg.totalSpend,
    windowDays: m.agg.windowDays,
    fromPriceLevel: m.entity?.priceLevel,
    toPriceLevel: c.entity.priceLevel,
    distanceKm: c.evidence.distanceKm,
    affinity: c.evidence.affinity,
    currency: m.agg.currency,
    assumptions: { ...state.req.assumptions, ...(swapShare !== undefined ? { swapShare } : {}) },
  });
}

function compactFingerprint(state: RunState): ToolOutput {
  const fp = state.fingerprint!;
  return {
    headline: fp.headline,
    topTags: fp.topTags.map((t) => t.name),
    affinities: fp.affinities.map((a) => ({ domain: a.domain, name: a.entity.name, affinity: a.affinity })),
  };
}

interface InsightsQuery {
  merchantKey: string;
  radiusM?: number;
  minRating?: number;
  tags?: string[];
  useFingerprint?: boolean;
}

/** One insights call for one merchant; stores scored candidates on the state. */
export async function findTwins(
  state: RunState,
  m: MerchantState,
  from: QlooEntity,
  q: InsightsQuery,
  own: Set<string>,
) {
  const radiusM = q.radiusM ?? m.radiusM ?? state.loc.radiusM;
  const fromLvl = from.priceLevel;
  if (!fromLvl || fromLvl === 1) {
    m.insightsAttempts++;
    const note = fromLvl ? "Already the cheapest price tier; keep it." : "Qloo has no price level for it, so no honest cheaper twin; keep it.";
    return { candidates: [], out: { merchantKey: q.merchantKey, candidates: [], note } };
  }
  // honest twins: exactly one price level down (see isHonestTwin)
  const level = fromLvl - 1;
  const cross = q.useFingerprint === false ? [] : fingerprintSignals(state.fingerprint, 2);
  const taken = takenTwins(state, from.id);
  const exclude = [...new Set([...m.excludeIds, ...[...own].filter((id) => id !== from.id), ...taken.keys()])];
  const isPlace = from.type === "place";
  const signals = [from.id, ...cross.map((c) => c.entity.id)];
  const results = isPlace
    ? await state.qloo.placeInsights({
        signalEntityIds: signals,
        lat: state.loc.lat,
        lon: state.loc.lon,
        radiusM,
        priceLevelMin: level,
        priceLevelMax: level,
        minBusinessRating: q.minRating,
        excludeEntityIds: exclude.slice(0, 50),
        tags: q.tags,
        take: 10,
      })
    : await state.qloo.insights(from.type, {
        "signal.interests.entities": signals,
        "filter.exclude.entities": exclude.length ? exclude.slice(0, 50) : undefined,
        take: 10,
      });
  m.insightsAttempts++;
  const queryText =
    `${from.type} insights: signal ${from.name}` +
    (cross.length ? ` + ${cross.map((c) => c.entity.name).join(", ")}` : "") +
    (isPlace ? ` · within ${(radiusM / 1000).toFixed(1)} km` : "") +
    ` · price_level = ${level}` +
    (q.minRating ? ` · rating ≥ ${q.minRating}` : "");
  // never another branch of a place the user already goes to (e.g. a second Blue Bottle)
  const ownNames = new Set([normName(from.name), ...[...state.merchants.values()].flatMap((x) => [x.norm?.name, x.entity?.name]).filter((n): n is string => !!n).map(normName)]);
  const candidates = results
    .filter((e) => !ownNames.has(normName(e.name)) && !m.excludeIds.has(e.id) && !taken.has(e.id) && sameKind(from, e))
    .map((e) => scoreCandidate(e, { merchantKey: m.agg.key, from, radiusM, query: queryText, crossDomain: cross }, state.nextCandidateId()))
    .filter((c) => isHonestTwin(from, c))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  m.candidates = candidates;
  return {
    candidates,
    out: {
      merchantKey: q.merchantKey,
      from: { name: from.name, priceLevel: fromLvl },
      query: queryText,
      candidates: candidates.slice(0, 5).map((c) => ({
        candidateId: c.candidateId,
        name: c.entity.name,
        priceLevel: c.entity.priceLevel,
        distanceKm: c.evidence.distanceKm,
        affinity: c.evidence.affinity,
        score: c.score,
        shared: c.reasons[0],
      })),
      note: candidates.length
        ? undefined
        : "Nothing one price level down shares a Qloo taste tag nearby. Try a wider radiusM once, otherwise keep this merchant.",
    },
  };
}

/** Builds the plan from the state (used by plan_writer and the fallback). */
export function finalizePlan(state: RunState, summary?: string, proof?: ProofSide): Plan {
  for (const m of state.merchants.values()) m.norm ??= normalizeByRules(m.agg);
  state.mergeDuplicates();
  // ambiguous merchants the model did not ask about still get their question
  for (const m of state.focus()) {
    if (m.resolution?.status === "ambiguous" && !m.asked && m.options.length) askAbout(state, m, `Which ${merchantName(m)} did you mean?`);
  }
  const swaps = state.allSwaps();
  const swapped = new Set(swaps.filter((s) => s.status !== "rejected").map((s) => s.merchantKey));
  const focus = state.focus().filter((m) => m.norm);
  const unswapped: Plan["unswapped"] = focus
    .filter((m) => !swapped.has(m.agg.key))
    .map((m) => ({
      merchantKey: m.agg.key,
      name: merchantName(m),
      reason:
        m.resolution?.status === "ambiguous"
          ? m.asked
            ? KEPT_REASON.waiting
            : KEPT_REASON.ambiguous
          : m.resolution?.status === "unresolved"
            ? KEPT_REASON.notFound
            : !m.searched
              ? KEPT_REASON.unchecked
              : m.entity?.priceLevel === 1
                ? KEPT_REASON.cheapest
                : m.entity && !m.entity.priceLevel
                  ? KEPT_REASON.noPrice
                  : m.insightsAttempts
                    ? KEPT_REASON.noTwin
                    : KEPT_REASON.unchecked,
    }));
  const receiptMerchants: ReceiptMerchant[] = focus.map((m) => ({
    key: m.agg.key,
    rawMerchant: m.agg.rawMerchant,
    name: merchantName(m),
    category: m.norm!.category,
    visitsPerMonth: m.visitsPerMonth,
    monthlySpend: m.monthlySpend,
    resolved: m.resolution?.status === "resolved" || !!m.carried,
    keptReason: unswapped.find((u) => u.merchantKey === m.agg.key)?.reason,
    mergedKeys: m.mergedKeys.length ? m.mergedKeys : undefined,
  }));
  const currency = state.req.merchants[0]?.currency ?? "USD";
  const plan = buildPlan({
    id: `plan-${state.runId.slice(0, 8)}`,
    location: state.req.location,
    merchants: focus.map((m) => m.agg),
    swaps,
    unswapped,
    summary: summary || undefined,
    horizonDays: state.req.assumptions?.horizonDays,
    currency,
    receipt: buildReceipt({ merchants: receiptMerchants, swaps, currency }),
    fingerprint: state.fingerprint,
  });
  if (proof) plan.proof = { ...proof, ...keptCounts(unswapped) };
  const hero = heroBridge(plan.swaps);
  if (hero) plan.heroBridge = hero;
  state.plan = plan;
  state.sink.emit({ type: "plan_ready", plan });
  return plan;
}

/** A twin is exactly one price level below the original and shares at least one Qloo taste tag with it. */
export function isHonestTwin(from: QlooEntity, c: SwapCandidate): boolean {
  const fromLvl = from.priceLevel;
  return !!fromLvl && c.entity.priceLevel === fromLvl - 1 && (c.evidence.sharedTagIds?.length ?? 0) > 0;
}

/** Same kind of place: shares a Qloo category tag with the original when the original has one. */
function sameKind(from: QlooEntity, e: QlooEntity): boolean {
  const cats = new Set(from.tags.filter((t) => /:category:/.test(t.id)).map((t) => t.id));
  return !cats.size || e.tags.some((t) => cats.has(t.id));
}

/** Twin entity id -> merchant name, for swaps of other places in this plan (one twin per place). */
function takenTwins(state: RunState, fromEntityId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of state.allSwaps()) {
    if (s.status === "rejected" || s.from.entity?.id === fromEntityId) continue;
    out.set(s.to.entity.id, s.from.name);
  }
  return out;
}

const BRIDGE_DOMAINS: CrossDomainType[] = ["artist", "movie", "brand", "tv_show"];
const BRIDGE_NOUN: Partial<Record<CrossDomainType, string>> = { movie: "the film ", tv_show: "the show ", book: "the book ", podcast: "the podcast " };

/**
 * Per-swap cross-domain bridge: one Qloo insights call in another domain
 * with the original and the twin as signals, i.e. what both crowds love.
 * The domain is picked per merchant, and an entity already used as another
 * swap's bridge is skipped, so the receipt does not repeat one name.
 */
async function crossDomainBridge(
  state: RunState,
  from: QlooEntity,
  c: SwapCandidate,
): Promise<{ crossDomain?: CrossDomainAffinity[]; note?: string }> {
  if (state.budget.remaining < 1) return {};
  const domain = BRIDGE_DOMAINS[hash32(from.id) % BRIDGE_DOMAINS.length];
  try {
    const res = await state.qloo.insights(domain, { "signal.interests.entities": [from.id, c.entity.id], take: 6 });
    const used = new Set(state.allSwaps().map((s) => s.to.evidence.crossDomain?.[0]?.entity.id).filter(Boolean));
    const uniq = res.filter((e, i) => res.findIndex((x) => x.id === e.id || x.name === e.name) === i);
    const usedNames = new Set(state.allSwaps().map((s) => s.to.evidence.crossDomain?.[0]?.entity.name).filter(Boolean));
    const fresh = uniq.filter((e) => !used.has(e.id) && !usedNames.has(e.name));
    const pool = fresh.length ? fresh : uniq;
    // lead with one whose short note fits the evidence line
    const fits = pool.find((e) => shortBridge(domain, e.name).length <= SHORT_BRIDGE_MAX);
    // all of them stay in the evidence: the hero bridge picks the best-known one
    const picks = fits ? [fits, ...pool.filter((e) => e !== fits)] : pool;
    if (!picks.length) return {};
    return {
      crossDomain: picks.map((e) => ({ domain, entity: toRef(e), affinity: e.affinity })),
      note: shortBridge(domain, picks[0].name),
    };
  } catch {
    return {};
  }
}

const SHORT_BRIDGE_MAX = 40;
const HERO_BRIDGE_MAX = 72;

/** "Also love: the show Sparrow & Fig": at most 40 chars, no merchant names. */
export function shortBridge(domain: CrossDomainType, name: string): string {
  for (const t of [`Also love: ${BRIDGE_NOUN[domain] ?? ""}${name}`, `Also love: ${name}`]) if (t.length <= SHORT_BRIDGE_MAX) return t;
  return `Also love: ${name}`.slice(0, SHORT_BRIDGE_MAX - 1).trimEnd() + "…";
}

/**
 * The one long bridge the pen hand-writes. Across every live swap, the
 * bridge entity Qloo rates most popular (the best-known name both crowds
 * love) picks the hero swap; a tie goes to the bigger saving. Without any
 * popularity: the best-saving swap's first entity.
 */
export function heroBridge(swaps: Swap[]): Plan["heroBridge"] {
  const live = swaps
    .filter((s) => s.status !== "rejected" && s.to.evidence.crossDomain?.length)
    .sort((a, b) => b.savings.monthlySavings - a.savings.monthlySavings);
  if (!live.length) return undefined;
  const known = live
    .flatMap((s) => s.to.evidence.crossDomain!.filter((c) => c.entity.popularity !== undefined).map((cd) => ({ s, cd })))
    .sort((a, b) => b.cd.entity.popularity! - a.cd.entity.popularity!);
  for (const { s, cd } of known.length ? known : [{ s: live[0], cd: live[0].to.evidence.crossDomain![0] }]) {
    const what = `${BRIDGE_NOUN[cd.domain] ?? ""}${cd.entity.name}`;
    const text = [`Fans of ${s.from.name} and ${s.to.entity.name} both love ${what}`, `${s.from.name} fans also love ${what}`, `${s.from.name} fans also love ${cd.entity.name}`].find(
      (t) => t.length <= HERO_BRIDGE_MAX,
    );
    if (text) return { swapId: s.id, merchantKey: s.merchantKey, text };
  }
  return undefined;
}

interface ProposeInput {
  merchantKey: string;
  candidateId: string;
  rationale: string;
  keepReason: string;
  alternativeCandidateIds?: string[];
}

/** propose_swap's body; also used by the coverage pass. */
export async function proposeSwap(
  state: RunState,
  { merchantKey, candidateId, rationale, keepReason, alternativeCandidateIds }: ProposeInput,
): Promise<{ result: ToolOutput; summary: string }> {
  const m = state.get(merchantKey);
  const c = state.findCandidate(merchantKey, candidateId);
  if (!m || !c || !m.entity) return { summary: "Unknown candidate", result: { error: "unknown merchant or candidate" } };
  if (!m.needsWork) return { summary: "Already settled", result: { error: "This merchant was settled in the previous plan; leave it." } };
  if (!isHonestTwin(m.entity, c)) {
    return { summary: "Not a fair twin, skipped", result: { error: "A twin must be exactly one price level cheaper and share a Qloo taste tag; keep this merchant." } };
  }
  const taken = takenTwins(state, m.entity.id).get(c.entity.id);
  if (taken) {
    return { summary: "Twin already used, skipped", result: { error: `${c.entity.name} is already the twin for ${taken}; pick another candidate or keep this merchant.` } };
  }
  const savings = estimate(state, m, c);
  if (savings.monthlySavings <= 0) {
    return { summary: "Not cheaper, skipped", result: { error: "This candidate does not save money; pick a cheaper one or leave the merchant as is." } };
  }
  const swapBefore = m.swap;
  const bridge = await crossDomainBridge(state, m.entity, c);
  // a parallel proposal may have taken this twin (or this merchant) while the bridge was looked up
  const takenNow = takenTwins(state, m.entity.id).get(c.entity.id);
  if (takenNow || m.swap !== swapBefore) {
    return { summary: "Twin already used, skipped", result: { error: takenNow ? `${c.entity.name} is already the twin for ${takenNow}; pick another candidate or keep this merchant.` : "This merchant already has a swap." } };
  }
  const to: SwapCandidate = bridge.crossDomain ? { ...c, evidence: { ...c.evidence, crossDomain: bridge.crossDomain } } : c;
  const swap: Swap = {
    id: state.nextSwapId(),
    // a merged line's swap is keyed by the line, whichever key the model used
    merchantKey: m.agg.key,
    category: m.norm?.category ?? "other",
    from: {
      name: merchantName(m),
      entity: toRef(m.entity),
      visitsPerMonth: round2(m.visitsPerMonth),
      monthlySpend: round2(m.monthlySpend),
      avgTicket: round2(m.avgTicket),
    },
    to,
    alternatives: (alternativeCandidateIds ?? [])
      .map((id) => state.findCandidate(merchantKey, id))
      .filter((x): x is NonNullable<typeof x> => !!x && x.candidateId !== candidateId),
    savings,
    rationale,
    keepReason: keepReason || defaultKeepReason(c),
    ...(bridge.note ? { crossDomainNote: bridge.note } : {}),
    ...(m.mergedKeys.length ? { mergedKeys: [...m.mergedKeys] } : {}),
    status: "proposed",
  };
  m.swap = swap;
  state.sink.emit({ type: "swap_proposed", swap });
  // other statement lines for the same place (e.g. "BLUE BTL" and "BLUE BOTTLE") get the same twin
  const siblings = [...state.merchants.values()].filter(
    (x) => x !== m && x.entity?.id === m.entity!.id && !x.swap && !x.carried && x.needsWork,
  );
  for (const x of siblings) {
    const sv = estimate(state, x, c);
    if (sv.monthlySavings <= 0) continue;
    x.swap = {
      ...swap,
      id: state.nextSwapId(),
      merchantKey: x.agg.key,
      from: { ...swap.from, visitsPerMonth: round2(x.visitsPerMonth), monthlySpend: round2(x.monthlySpend), avgTicket: round2(x.avgTicket) },
      to: { ...to, merchantKey: x.agg.key },
      mergedKeys: x.mergedKeys.length ? [...x.mergedKeys] : undefined,
      alternatives: swap.alternatives?.map((a) => ({ ...a, merchantKey: x.agg.key })),
      savings: sv,
    };
    state.sink.emit({ type: "swap_proposed", swap: x.swap });
  }
  return {
    summary: `${merchantName(m)} → ${c.entity.name}: ${money(savings.monthlySavings)}/mo`,
    result: {
      swapId: swap.id,
      monthlySavings: savings.monthlySavings,
      ...(siblings.length ? { alsoAppliedTo: siblings.map((x) => x.agg.key) } : {}),
    },
  };
}

/**
 * Before the plan: every resolved focus merchant the model never searched a
 * twin for gets one honest search, and the best fair twin is proposed with a
 * data-only rationale. So "kept" on the receipt always means "checked".
 * If that adds swaps, the plan summary is rebuilt from the data, since the
 * model wrote its summary without them.
 */
export async function coverAndFinalize(state: RunState, summary?: string): Promise<Plan> {
  let added = 0;
  const own = new Set([...state.merchants.values()].map((m) => m.entity?.id).filter((x): x is string => !!x));
  for (const m of state.focus()) {
    if (!m.entity || !m.needsWork || m.swap || m.carried || m.insightsAttempts > 0 || m.resolution?.status !== "resolved") continue;
    if (state.budget.remaining < 2) break;
    try {
      const res = await findTwins(state, m, m.entity, { merchantKey: m.agg.key }, own);
      const taken = takenTwins(state, m.entity.id);
      const best = res.candidates.find((c) => !taken.has(c.entity.id) && estimate(state, m, c).monthlySavings > 0);
      if (!best) continue;
      const out = await proposeSwap(state, {
        merchantKey: m.agg.key,
        candidateId: best.candidateId,
        rationale: dataRationale(m.entity, best),
        keepReason: defaultKeepReason(best),
      });
      if (!out.result.error) added++;
    } catch {
      // budget or network: the merchant stays, reported as not analysed
    }
  }
  return finalizePlan(state, added ? undefined : summary, await measureOurs(state));
}

/** Our side of the measured proof: each live swap scored with the same Qloo call as the model's picks (lib/agent/proof.ts). */
async function measureOurs(state: RunState): Promise<ProofSide> {
  for (const m of state.merchants.values()) m.norm ??= normalizeByRules(m.agg);
  state.mergeDuplicates();
  const focus = state.focus();
  const picks: ProofPick[] = [];
  for (const m of focus) {
    const s = m.swap ?? m.carried;
    if (!s || s.status === "rejected" || !m.norm) continue;
    const ref = s.from.entity;
    const from = m.entity ?? (ref ? ({ ...ref, tags: [] } as QlooEntity) : undefined);
    const e = s.to.entity;
    // a swap carried from the previous plan keeps its measurement (no new Qloo call)
    const prev = state.req.previousPlan?.proof?.perMerchant.find((p) => p.merchantKey === m.agg.key && p.entity?.id === e.id);
    if (prev) {
      picks.push({ ...prev, monthlySavings: s.savings.monthlySavings });
      continue;
    }
    const pick = { ...e, tags: s.to.evidence.tags ?? [] } as QlooEntity;
    picks.push(
      await scorePick(state.qloo, state.loc, {
        merchantKey: m.agg.key,
        fromName: merchantName(m),
        category: m.norm.category,
        count: m.agg.count,
        totalSpend: m.agg.totalSpend,
        windowDays: m.agg.windowDays,
        currency: m.agg.currency,
        from,
        pickName: e.name,
        pick,
        exists: state.qloo.mock ? undefined : true,
        monthlySavings: s.savings.monthlySavings,
        sharedTagIds: s.to.evidence.sharedTagIds ?? [],
      }),
    );
  }
  return proofSide(picks, focus.filter((m) => m.norm).length, state.qloo.mock);
}

/** A rationale that only restates the evidence. */
function dataRationale(from: QlooEntity, c: SwapCandidate): string {
  const e = c.evidence;
  const shared = e.tags.filter((t) => e.sharedTagIds?.includes(t.id)).map((t) => `"${t.name.toLowerCase()}"`);
  return [
    `${c.entity.name} shares the ${shared.join(" and ")} tag${shared.length > 1 ? "s" : ""} with ${from.name}`,
    e.affinity !== undefined ? `, ${e.affinity.toFixed(2)} Qloo affinity` : "",
    e.distanceKm !== undefined ? `, ${e.distanceKm.toFixed(1)} km away` : "",
    `, one price level down.`,
  ].join("");
}
