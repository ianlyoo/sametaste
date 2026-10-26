/**
 * NYC benchmark: "LLM alone" vs SameTaste on the fixed 40-merchant set.
 *
 * Both systems get the same cleaned merchant name and category. Scoring is
 * done by Qloo for both:
 *   - resolveRate: merchants SameTaste resolved via /search to the right business
 *   - hallucinationRate: suggestions that /search cannot find near NYC
 *   - cheaperHitRate: merchants with a real suggestion one+ price level down
 *   - tasteMatch: mean Qloo affinity of the real suggestion to the original
 *     (one insights call per merchant, signal = original, results filtered
 *     to the suggestions), so both systems use the same yardstick
 *   - monthlySavingsUsd: savings engine on a fixed visit profile
 * The summary holds aggregates only; per-merchant detail contains Qloo data
 * and is written to .scratch/ (gitignored) by the CLI.
 */
import type { LanguageModel, LanguageModelUsage } from "ai";
import { AgentRequestSchema, type BenchmarkSummary, type Category, type PriceLevel } from "../lib/contract";
import { CallBudget, type QlooClient } from "../lib/qloo/client";
import { hood as hoodPoint } from "../lib/qloo/mock/world";
import type { QlooEntity } from "../lib/qloo/types";
import { estimateSwapSavings } from "../lib/savings/engine";
import { ticketTable } from "../lib/savings/tickets";
import { llmSuggest, verifySuggestions } from "../lib/agent/baseline";
import { DEFAULT_LIMITS } from "../lib/agent/config";
import { EventSink } from "../lib/agent/events";
import { normalizeByRules, normalizeMerchants, type NormalizedMerchant } from "../lib/agent/normalize";
import { pickResolution } from "../lib/agent/resolve";
import { RunState } from "../lib/agent/state";
import { nameSimilarity } from "../lib/agent/text";
import { findTwins } from "../lib/agent/tools";
import { BENCHMARK_CITY, BENCHMARK_MERCHANTS, BENCHMARK_SET_VERSION, VISITS_PER_MONTH, type BenchmarkMerchant } from "./merchants";

export const GATE_THRESHOLD = 0.6;
const RADIUS_M = 3000;

export interface BenchmarkOptions {
  qloo: QlooClient;
  qlooMode: "mock" | "live";
  /** Live model for the LLM-alone baseline and the normaliser; omit for scripted. */
  model?: LanguageModel;
  modelId?: string;
  normalizerModel?: LanguageModel;
  normalizerModelId?: string;
  onUsage?: (modelId: string, u: LanguageModelUsage) => void;
  merchants?: BenchmarkMerchant[];
  /** Use the hand-written alias table in the rules pass (default false). */
  aliases?: boolean;
  log?: (msg: string) => void;
}

export interface SuggestionResult {
  name: string;
  exists: boolean;
  entityName?: string;
  entityId?: string;
  priceLevel?: number;
  cheaper: boolean;
  affinity?: number;
  monthlySavings: number;
}

export interface BenchmarkRow {
  id: string;
  descriptor: string;
  truth: string;
  category: Category;
  hood: string;
  normalized: string;
  resolution: "resolved" | "ambiguous" | "unresolved";
  resolvedName?: string;
  resolvedCorrect: boolean;
  fromPriceLevel?: number;
  llm_only?: SuggestionResult;
  sametaste?: SuggestionResult & { distanceKm?: number; reason?: string };
}

export interface BenchmarkResult {
  summary: BenchmarkSummary;
  rows: BenchmarkRow[];
  setVersion: number;
  aliases: boolean;
}

function savingsFor(category: Category, from?: number, to?: number): number {
  if (!from || !to || to >= from) return 0;
  const visits = VISITS_PER_MONTH[category] ?? 2;
  const ticket = ticketTable(category)[from as PriceLevel];
  return estimateSwapSavings({
    category,
    count: visits,
    totalSpend: visits * ticket,
    windowDays: 30,
    fromPriceLevel: from as PriceLevel,
    toPriceLevel: to as PriceLevel,
  }).monthlySavings;
}

export async function runBenchmark(opts: BenchmarkOptions): Promise<BenchmarkResult> {
  const { qloo } = opts;
  const log = opts.log ?? (() => {});
  const set = opts.merchants ?? BENCHMARK_MERCHANTS;
  const aggs = set.map((b) => ({ key: b.id, rawMerchant: b.descriptor, count: 4, totalSpend: 100, currency: "USD" }));

  // 1. normalise (rules + one batched model call when a model is given)
  let norms: NormalizedMerchant[];
  if (opts.normalizerModel) {
    const res = await normalizeMerchants(aggs, { model: opts.normalizerModel, modelId: opts.normalizerModelId, city: BENCHMARK_CITY, known: opts.aliases ?? false });
    if (res.usage && res.modelId) opts.onUsage?.(res.modelId, res.usage as LanguageModelUsage);
    norms = res.merchants;
  } else {
    norms = aggs.map((a) => normalizeByRules(a, { known: opts.aliases ?? false }));
  }

  // 2. resolve via /search near each merchant's neighbourhood
  const rows: BenchmarkRow[] = [];
  const entities = new Map<string, QlooEntity>();
  for (const [i, b] of set.entries()) {
    const n = { ...norms[i], skip: false };
    const near = hoodPoint(b.hood);
    const results = await qloo.search({ query: n.name, types: [n.entityType], lat: near.lat, lon: near.lon, radiusMiles: 15, take: 6 });
    const pick = pickResolution(n, results, near);
    const status = pick.resolution.status === "skipped" ? "unresolved" : pick.resolution.status;
    const correct = status === "resolved" && !!pick.entity && nameSimilarity(pick.entity.name, b.name) >= 0.8;
    if (correct && pick.entity) entities.set(b.id, pick.entity);
    rows.push({
      id: b.id,
      descriptor: b.descriptor,
      truth: b.name,
      category: b.category,
      hood: b.hood,
      normalized: n.name,
      resolution: status,
      resolvedName: pick.entity?.name,
      resolvedCorrect: correct,
      fromPriceLevel: correct ? pick.entity?.priceLevel : undefined,
    });
    log(`resolve ${b.id} ${status}${correct ? "" : " (miss)"}`);
  }

  // 3. SameTaste twins: the agent's own findTwins, one level down, retry wider
  for (const [i, b] of set.entries()) {
    const from = entities.get(b.id);
    if (!from) continue;
    const near = hoodPoint(b.hood);
    const req = AgentRequestSchema.parse({ location: { label: b.hood, lat: near.lat, lon: near.lon, radiusM: RADIUS_M }, merchants: [aggs[i]] });
    const state = new RunState(`bench-${b.id}`, req, qloo, new CallBudget(1000), new EventSink(`bench-${b.id}`), DEFAULT_LIMITS);
    const m = state.get(b.id)!;
    m.norm = norms[i];
    m.entity = from;
    let res = await findTwins(state, m, from, { merchantKey: b.id }, new Set([from.id]));
    if (!res.candidates.length && from.priceLevel !== 1) {
      res = await findTwins(state, m, from, { merchantKey: b.id, radiusM: RADIUS_M * 2.5 }, new Set([from.id]));
    }
    const best = res.candidates[0];
    if (best) {
      rows[i].sametaste = {
        name: best.entity.name,
        exists: true,
        entityName: best.entity.name,
        entityId: best.entity.id,
        priceLevel: best.entity.priceLevel,
        cheaper: !!(from.priceLevel && best.entity.priceLevel && best.entity.priceLevel < from.priceLevel),
        affinity: best.evidence.affinity,
        monthlySavings: savingsFor(b.category, from.priceLevel, best.entity.priceLevel),
        distanceKm: best.evidence.distanceKm,
        reason: best.reasons[0],
      };
    }
    log(`twin ${b.id} ${best ? "found" : "none"}`);
  }

  // 4. LLM alone: one batched answer from memory, then checked with /search
  const suggestions = await llmSuggest(
    set.map((b, i) => ({ key: b.id, name: `${norms[i].name} (${b.hood})`, category: norms[i].category })),
    BENCHMARK_CITY,
    { model: opts.model, onUsage: (u) => opts.onUsage?.(opts.modelId ?? "unknown", u) },
  );
  for (const s of suggestions) {
    const i = set.findIndex((b) => b.id === s.merchantKey);
    if (i < 0 || rows[i].llm_only) continue;
    const b = set[i];
    const near = hoodPoint(b.hood);
    const from = entities.get(b.id);
    // existence and price only: one city-wide search (about 15 mi), not the nearest-branch ladder
    const [v] = await verifySuggestions(qloo, [s], new Map([[b.id, { key: b.id, name: b.name, category: b.category, entity: from }]]), near, { checkMock: true, radiiKm: [24] });
    if (!v) continue;
    rows[i].llm_only = {
      name: s.suggestedName,
      exists: v.existsInQloo,
      entityName: v.entity?.name,
      entityId: v.entity?.id,
      priceLevel: v.entity?.priceLevel,
      cheaper: v.cheaper === true,
      monthlySavings: v.cheaper ? savingsFor(b.category, from?.priceLevel, v.entity?.priceLevel) : 0,
    };
  }

  // 5. taste match with one yardstick: affinity of each real suggestion to the original
  for (const [i, b] of set.entries()) {
    const from = entities.get(b.id);
    const r = rows[i];
    const ids = [r.llm_only?.entityId, r.sametaste?.entityId].filter((x): x is string => !!x && x !== from?.id);
    if (!from || !ids.length) continue;
    try {
      const out = await qloo.insights(from.type, {
        "signal.interests.entities": [from.id],
        "filter.results.entities": [...new Set(ids)],
        take: Math.max(2, ids.length),
      });
      const aff = new Map(out.map((e) => [e.id, e.affinity]));
      if (r.llm_only?.entityId) r.llm_only.affinity = aff.get(r.llm_only.entityId) ?? r.llm_only.affinity;
      if (r.sametaste?.entityId) r.sametaste.affinity = aff.get(r.sametaste.entityId) ?? r.sametaste.affinity;
    } catch {
      log(`affinity ${b.id} failed`);
    }
  }

  return { summary: summarize(rows, opts, qloo.calls), rows, setVersion: BENCHMARK_SET_VERSION, aliases: opts.aliases ?? false };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r2 = (x: number) => Math.round(x * 100) / 100;

function metrics(rows: BenchmarkRow[], pick: (r: BenchmarkRow) => SuggestionResult | undefined) {
  const answered = rows.map(pick).filter((x): x is SuggestionResult => !!x);
  const real = answered.filter((s) => s.exists);
  const affs = real.map((s) => s.affinity).filter((a): a is number => a !== undefined);
  const hits = answered.filter((s) => s.exists && s.cheaper);
  return {
    answered: answered.length,
    hallucinationRate: answered.length ? r3((answered.length - real.length) / answered.length) : 0,
    cheaperHitRate: rows.length ? r3(hits.length / rows.length) : 0,
    tasteMatch: affs.length ? r3(affs.reduce((a, b) => a + b, 0) / affs.length) : 0,
    monthlySavingsUsd: r2(hits.reduce((a, s) => a + s.monthlySavings, 0)),
  };
}

export function summarize(rows: BenchmarkRow[], opts: Pick<BenchmarkOptions, "qlooMode" | "model">, qlooCalls: number): BenchmarkSummary {
  const resolveRate = rows.length ? r3(rows.filter((r) => r.resolvedCorrect).length / rows.length) : 0;
  const sametaste = metrics(rows, (r) => r.sametaste);
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    qlooMode: opts.qlooMode,
    modelMode: opts.model ? "live" : "scripted",
    city: BENCHMARK_CITY,
    merchantCount: rows.length,
    resolveRate,
    systems: { llm_only: metrics(rows, (r) => r.llm_only), sametaste },
    gate: {
      threshold: GATE_THRESHOLD,
      resolveRate,
      cheaperHitRate: sametaste.cheaperHitRate,
      pass: resolveRate >= GATE_THRESHOLD && sametaste.cheaperHitRate >= GATE_THRESHOLD,
    },
    qlooCalls,
  };
}
