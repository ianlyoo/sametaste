/**
 * "LLM alone" baseline for the compare view and the benchmark: the model
 * suggests cheaper places from memory, then Qloo /search checks whether each
 * suggestion exists near the city and whether it is really cheaper. Each
 * pick is resolved to its nearest branch around the user (nearestBranch), so
 * a chain with a branch nearby is never measured at a far one.
 */
import { generateText, NoObjectGeneratedError, Output, type LanguageModel, type LanguageModelUsage } from "ai";
import { z } from "zod";
import type { BaselineSuggestion, Category } from "../contract";
import type { QlooClient } from "../qloo/client";
import { haversineM } from "../qloo/geo";
import type { QlooEntity } from "../qloo/types";
import { hash32, mockStandIn } from "../qloo/mock/world";
import { toRef } from "./resolve";
import { SNAPSHOTS } from "../../personas/snapshots";
import { nameSimilarity, normName } from "./text";

export interface BaselineMerchant {
  key: string;
  name: string;
  category: Category;
  /** The same per-line input the SameTaste agent gets. */
  rawMerchant?: string;
  visitsPerMonth?: number;
  monthlySpend?: number;
}

export interface LlmSuggestion {
  merchantKey: string;
  suggestedName: string;
  neighborhood?: string;
}

const SuggestionSchema = z.object({
  suggestions: z.array(
    z.object({
      merchantKey: z.string(),
      suggestedName: z.string().describe("Name of one specific, real venue or brand, as it appears on its sign"),
      neighborhood: z.string().describe("Neighbourhood of that venue in the city"),
    }),
  ),
});

/** The model-alone instructions: a fair control, asked for the same thing the agent delivers. */
export const BASELINE_INSTRUCTIONS =
  "You are a budget-savvy local guide. For each merchant on the user's card statement, name ONE specific, real, currently open venue in the same city that is cheaper and that a fan of the original would love just as much, and give its neighbourhood. Prefer a place near the user's location. Name an actual venue as it appears on its sign: never a description, a category or a placeholder. Answer from your own knowledge.";

/**
 * Guesses for the scripted (no-LLM) mode come from the recorded fair
 * model-alone runs (personas/snapshots, Sonnet's own answers): the same pick
 * for the same merchant, else a pick it gave for that category. Only
 * categories it never answered for use this short list of named places.
 */
const FALLBACK_GUESSES: Partial<Record<Category, [string, string][]>> = {
  beauty: [["Supercuts", "Williamsburg"], ["Glam Blowout Studio", "Flatiron"]],
  shopping: [["Uniqlo", "SoHo"], ["Beacon's Closet", "Williamsburg"]],
  entertainment: [["Nitehawk Cinema", "Williamsburg"], ["Regal Union Square", "Union Square"]],
  streaming: [["Tubi", "online"], ["Pluto TV", "online"]],
  transport: [["Citi Bike", "citywide"]],
  other: [["Brooklyn Flea", "Williamsburg"]],
};

let fair: { byName: Map<string, [string, string]>; byCategory: Map<Category, [string, string][]> } | undefined;

function fairPicks() {
  if (fair) return fair;
  fair = { byName: new Map(), byCategory: new Map() };
  for (const snap of Object.values(SNAPSHOTS)) {
    const plan = snap.sametaste.findLast((e) => e.type === "plan_ready");
    const cats = new Map(plan?.type === "plan_ready" ? (plan.plan.receipt?.lines ?? []).map((l) => [l.merchantKey, l.category] as const) : []);
    const base = snap.llm_only.find((e) => e.type === "baseline_ready");
    for (const s of base?.type === "baseline_ready" ? base.suggestions : []) {
      const pick: [string, string] = [s.suggestedName, s.suggestedNeighborhood ?? ""];
      fair.byName.set(normName(s.fromName), pick);
      const c = cats.get(s.merchantKey);
      if (c) fair.byCategory.set(c, [...(fair.byCategory.get(c) ?? []), pick]);
    }
  }
  return fair;
}

function scriptedGuess(m: BaselineMerchant): [string, string] {
  const { byName, byCategory } = fairPicks();
  const own = byName.get(normName(m.name.replace(/\s*\(.*\)$/, "")));
  if (own) return own;
  const pool = [...(byCategory.get(m.category) ?? FALLBACK_GUESSES[m.category] ?? FALLBACK_GUESSES.other!)].filter(([g]) => nameSimilarity(g, m.name) < 0.8);
  return pool[hash32(m.key) % Math.max(1, pool.length)] ?? FALLBACK_GUESSES.other![0];
}

export async function llmSuggest(
  merchants: BaselineMerchant[],
  city: string,
  opts: { model?: LanguageModel; onUsage?: (u: LanguageModelUsage) => void; abortSignal?: AbortSignal },
): Promise<LlmSuggestion[]> {
  if (!opts.model) {
    return merchants.map((m) => {
      const [name, hood] = scriptedGuess(m);
      return { merchantKey: m.key, suggestedName: name, neighborhood: hood };
    });
  }
  const line = (m: BaselineMerchant) =>
    [
      m.key,
      m.rawMerchant ?? m.name,
      m.name,
      m.category,
      m.visitsPerMonth !== undefined ? `${Math.round(m.visitsPerMonth * 10) / 10}x/mo` : undefined,
      m.monthlySpend !== undefined ? `$${Math.round(m.monthlySpend)}/mo` : undefined,
    ]
      .filter((x) => x !== undefined)
      .join(" | ");
  // Sonnet 5.5 thinks adaptively; thinking counts toward maxOutputTokens
  const res = await generateText({
    model: opts.model,
    output: Output.object({ schema: SuggestionSchema }),
    instructions: BASELINE_INSTRUCTIONS,
    prompt: `User location: ${city}\nMerchants (key | statement descriptor | name | category | visits | monthly spend):\n${merchants.map(line).join("\n")}`,
    maxOutputTokens: 8000,
    abortSignal: opts.abortSignal,
  }).catch((err: unknown) => {
    // a failed parse is still billed: count it before rethrowing
    if (NoObjectGeneratedError.isInstance(err) && err.usage) opts.onUsage?.(err.usage);
    throw err;
  });
  opts.onUsage?.(res.usage);
  return res.output.suggestions;
}

/** Search radii around the user, km: the walk our own twins are searched within (the run's radius), then the borough, then the city. */
export const BRANCH_LADDER_KM = [10, 24];

export interface Branch {
  /** The nearest name-matched place, when Qloo has one. */
  hit?: QlooEntity;
  /** From the user, km (undefined when the place has no coordinates). */
  distanceKm?: number;
  /** How far around the user was searched, km. */
  searchedKm: number;
}

/**
 * The nearest branch of `name` around the user: Qloo /search with its
 * location filter at the run's radius, widening only while no name match
 * lies inside the radius searched. Qloo ranks results by relevance, so the
 * distance is measured here rather than trusted to the order. `canWiden`
 * stops at the current radius (the call budget); `radiiKm` replaces the
 * ladder. Throws only if no search succeeds.
 */
export async function nearestBranch(
  qloo: QlooClient,
  name: string,
  near: { lat: number; lon: number; radiusM?: number },
  opts: { canWiden?: () => boolean; take?: number; radiiKm?: number[] } = {},
): Promise<Branch> {
  const first = (near.radiusM ?? 2500) / 1000;
  const ladder = opts.radiiKm ?? [first, ...BRANCH_LADDER_KM.filter((km) => km > first)];
  const pool = new Map<string, { e: QlooEntity; km?: number; s: number }>();
  let searchedKm = 0;
  let error: unknown;
  for (const km of ladder) {
    if (searchedKm && opts.canWiden && !opts.canWiden()) break;
    try {
      const results = await qloo.search({ query: name, types: ["place"], lat: near.lat, lon: near.lon, radiusMiles: Math.round((km / 1.609344) * 100) / 100, take: opts.take ?? 10 });
      searchedKm = km;
      for (const e of results) {
        const s = nameSimilarity(name, e.name);
        if (s < 0.8 || pool.has(e.id)) continue;
        const d = e.lat !== undefined && e.lon !== undefined ? haversineM(near.lat, near.lon, e.lat, e.lon) / 1000 : undefined;
        pool.set(e.id, { e, km: d, s });
      }
    } catch (err) {
      error ??= err;
      break;
    }
    if ([...pool.values()].some((x) => x.km !== undefined && x.km <= km)) break;
  }
  if (!searchedKm) throw error;
  // nearest located match, then the best-named one
  const best = [...pool.values()].sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity) || b.s - a.s)[0];
  return { hit: best?.e, distanceKm: best?.km === undefined ? undefined : Math.round(best.km * 100) / 100, searchedKm };
}

/**
 * Checks suggestions against Qloo /search with the same existence and price
 * checks as the benchmark. On the synthetic mock nothing real can be checked,
 * so suggestions come back as `verification: "pending_key"` unless
 * `checkMock` (the mock benchmark rehearsal) asks for the mock checks.
 */
export async function verifySuggestions(
  qloo: QlooClient,
  suggestions: LlmSuggestion[],
  merchants: Map<string, BaselineMerchant & { entity?: QlooEntity }>,
  near: { lat: number; lon: number; radiusM?: number },
  opts: { checkMock?: boolean; radiiKm?: number[] } = {},
): Promise<BaselineSuggestion[]> {
  return (await checkSuggestions(qloo, suggestions, merchants, near, opts)).map((c) => c.suggestion);
}

export interface CheckedSuggestion {
  suggestion: BaselineSuggestion;
  /** The pick in Qloo (on the mock: a mock stand-in, so the proof can score it). */
  hit?: QlooEntity;
  /** Found in Qloo; undefined while it can't be checked (mock). */
  exists?: boolean;
  /** How far around the user its branch was looked for, km. */
  searchedKm?: number;
}

/** verifySuggestions, plus the Qloo entity of each pick for the measured proof. */
export async function checkSuggestions(
  qloo: QlooClient,
  suggestions: LlmSuggestion[],
  merchants: Map<string, BaselineMerchant & { entity?: QlooEntity }>,
  near: { lat: number; lon: number; radiusM?: number },
  opts: { checkMock?: boolean; radiiKm?: number[] } = {},
): Promise<CheckedSuggestion[]> {
  const out: CheckedSuggestion[] = [];
  for (const [i, s] of suggestions.entries()) {
    const m = merchants.get(s.merchantKey);
    if (!m) continue;
    // widen only while the budget keeps one search for each pick left and the proof's affinity call for every pick
    const reserve = suggestions.length - i - 1 + suggestions.length;
    const canWiden = () => !qloo.budget || qloo.budget.remaining > reserve;
    if (qloo.mock && !opts.checkMock) {
      // existence can't be checked on the mock; a stand-in lets the mock score the pick like a twin
      let branch: Branch | undefined;
      if (m.entity) {
        mockStandIn(s.suggestedName, { category: m.category, tags: m.entity.tags.map((t) => t.id), priceLevel: m.entity.priceLevel }, s.neighborhood);
        branch = await nearestBranch(qloo, s.suggestedName, near, { canWiden, radiiKm: opts.radiiKm }).catch(() => undefined);
      }
      out.push({
        suggestion: {
          merchantKey: s.merchantKey,
          fromName: m.name,
          suggestedName: s.suggestedName,
          ...(s.neighborhood ? { suggestedNeighborhood: s.neighborhood } : {}),
          existsInQloo: false,
          verification: "pending_key",
          note: "Qloo check pending: no Qloo key yet",
        },
        hit: branch?.hit,
        searchedKm: branch?.searchedKm,
      });
      continue;
    }
    const { hit, searchedKm } = await nearestBranch(qloo, s.suggestedName, near, { canWiden, radiiKm: opts.radiiKm });
    const from = m.entity?.priceLevel;
    const to = hit?.priceLevel;
    out.push({
      suggestion: {
        merchantKey: s.merchantKey,
        fromName: m.name,
        suggestedName: s.suggestedName,
        ...(s.neighborhood ? { suggestedNeighborhood: s.neighborhood } : {}),
        existsInQloo: !!hit,
        verification: qloo.mock ? undefined : "qloo",
        entity: hit ? toRef(hit) : undefined,
        cheaper: hit && from && to ? to < from : undefined,
        note: !hit ? "Not found in Qloo near this city" : from && to && to >= from ? "Not cheaper" : undefined,
      },
      hit,
      exists: !!hit,
      searchedKm,
    });
  }
  return out;
}
