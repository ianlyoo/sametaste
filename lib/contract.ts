/**
 * SameTaste UI <-> agent contract.
 *
 * Owned by the agent worker. The UI imports types (and, if it wants, the zod
 * schemas) from here. Changes after the first push are additive only and are
 * noted in the commit message.
 *
 * Wire protocol
 * - `POST /api/agent` with an `AgentRequest` JSON body.
 * - Response: `application/x-ndjson`, one `AgentEvent` JSON object per line,
 *   in `seq` order. The last event is always `done`.
 * - The server is stateless: to answer a question, reject a swap or re-plan,
 *   POST again with the same merchants plus `answers` / `feedback` /
 *   `previousPlan`.
 * - Privacy: the browser parses the CSV locally and sends only aggregated
 *   merchants (`MerchantAggregate`), never raw rows.
 */
import { z } from "zod";

export const AGENT_ENDPOINT = "/api/agent";
export const AGENT_STREAM_CONTENT_TYPE = "application/x-ndjson";
export const CONTRACT_VERSION = 1;
/**
 * Additive revisions: 1.1 adds fingerprint, receipt, benchmark types.
 * 1.2 adds per-swap cross-domain bridges (`Swap.crossDomainNote`), merged
 * statement lines (`mergedKeys`) and baseline neighbourhood/verification.
 * 1.3 adds the measured proof (`Plan.proof` ours, `baseline_ready.proof`
 * theirs, one `ProofSide` scale), `Plan.heroBridge`, merges announced up
 * front (`run_started.merges`); `crossDomainNote` is now short (<= 40 chars,
 * no merchant names).
 * 1.4 counts each proof side over its own picks: `ProofSide.priced` (n for
 * cheaper and the month), `kept` and `waiting` (our lines with no pick).
 * 1.5 keeps the taste tags the paper prints: `TasteFingerprint.sources`
 * (each place's taste tags) and `SwapEvidence.sharedTags` (named); shared
 * tags are taste tags only (never payments, amenities or bare categories).
 * 1.6 measures where the picks are: each model pick resolved to its nearest
 * branch (`ProofPick.searchedKm`, `claimedHood`, `inClaimedHood`), the
 * proof's `near`/`medianDistanceKm`/`whereSaid`/`whereChecked`/`nearestBranch`,
 * and `baseline_ready.proofRuns` (every model-alone run, for its spread).
 */
export const CONTRACT_REVISION = "1.6";

// ---------------------------------------------------------------------------
// Basics

export const CategorySchema = z.enum([
  "coffee",
  "restaurant",
  "fast_food",
  "bar",
  "grocery",
  "fitness",
  "beauty",
  "shopping",
  "entertainment",
  "streaming",
  "transport",
  "other",
]);
export type Category = z.infer<typeof CategorySchema>;

/** Qloo entity types available in the hackathon environment. */
export const QlooEntityTypeSchema = z.enum([
  "artist",
  "book",
  "brand",
  "destination",
  "movie",
  "person",
  "place",
  "podcast",
  "tv_show",
  "video_game",
]);
export type QlooEntityType = z.infer<typeof QlooEntityTypeSchema>;

/** Qloo price_level: 1 (cheapest) .. 4 (most expensive). */
export const PriceLevelSchema = z.number().int().min(1).max(4);
export type PriceLevel = z.infer<typeof PriceLevelSchema>;

export const LocationSchema = z.object({
  /** Human label, e.g. "Williamsburg, Brooklyn, NY". */
  label: z.string().min(1).max(120),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  /** Search radius for swaps, metres. Server default 2500. */
  radiusM: z.number().int().min(100).max(50_000).optional(),
});
export type Location = z.infer<typeof LocationSchema>;

// ---------------------------------------------------------------------------
// Transactions (browser side)

/** One parsed CSV row. Stays in the browser. */
export const TransactionSchema = z.object({
  id: z.string(),
  /** ISO date, YYYY-MM-DD. */
  date: z.string(),
  /** Raw statement descriptor, e.g. "SQ *BLUE BTL 0423". */
  rawMerchant: z.string(),
  /** Positive = spend, negative = refund/credit. */
  amount: z.number(),
  currency: z.string().default("USD"),
  /** Category from the CSV or the local categoriser, if any. */
  category: CategorySchema.optional(),
});
export type Transaction = z.infer<typeof TransactionSchema>;

/** Merchant-level aggregate of transactions; this is what the browser sends. */
export const MerchantAggregateSchema = z.object({
  /** Stable key chosen by the client (e.g. normalised raw descriptor). */
  key: z.string().min(1).max(120),
  /** One representative raw descriptor. */
  rawMerchant: z.string().min(1).max(120),
  category: CategorySchema.optional(),
  /** Number of transactions in the window. */
  count: z.number().int().min(1),
  /** Sum of spend in the window, in `currency`. */
  totalSpend: z.number().min(0),
  currency: z.string().default("USD"),
  /** Length of the observed window in days (for monthly scaling). Default 30. */
  windowDays: z.number().int().min(1).max(366).optional(),
});
export type MerchantAggregate = z.infer<typeof MerchantAggregateSchema>;

// ---------------------------------------------------------------------------
// Qloo-backed entities and resolution

export const QlooTagSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().optional(),
});
export type QlooTag = z.infer<typeof QlooTagSchema>;

export const QlooEntityRefSchema = z.object({
  /** Qloo entity id. */
  id: z.string(),
  name: z.string(),
  type: QlooEntityTypeSchema,
  address: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  priceLevel: PriceLevelSchema.optional(),
  /** Qloo popularity percentile, 0..1. */
  popularity: z.number().optional(),
  businessRating: z.number().optional(),
});
export type QlooEntityRef = z.infer<typeof QlooEntityRefSchema>;

export const ResolutionStatusSchema = z.enum([
  "resolved",
  /** Several plausible entities; the agent asks the user. */
  "ambiguous",
  /** Nothing in Qloo matched. */
  "unresolved",
  /** Not a taste merchant (rent, transfers, utilities...). */
  "skipped",
]);
export type ResolutionStatus = z.infer<typeof ResolutionStatusSchema>;

export const MerchantResolutionSchema = z.object({
  merchantKey: z.string(),
  rawMerchant: z.string(),
  /** Cleaned name, e.g. "Blue Bottle Coffee". */
  normalizedName: z.string(),
  category: CategorySchema,
  /** Which Qloo entity type we searched as. */
  entityType: QlooEntityTypeSchema.optional(),
  status: ResolutionStatusSchema,
  entity: QlooEntityRefSchema.optional(),
  /** Alternatives when ambiguous. */
  candidates: z.array(QlooEntityRefSchema).optional(),
  /** 0..1 */
  confidence: z.number().min(0).max(1),
  source: z.enum(["qloo_search", "user_answer", "cache"]),
});
export type MerchantResolution = z.infer<typeof MerchantResolutionSchema>;

// ---------------------------------------------------------------------------
// Cross-domain taste (v1.1)

export const CrossDomainTypeSchema = z.enum([
  "artist",
  "movie",
  "tv_show",
  "book",
  "podcast",
  "brand",
]);
export type CrossDomainType = z.infer<typeof CrossDomainTypeSchema>;

/** One cross-domain affinity Qloo predicts from where you spend. */
export const CrossDomainAffinitySchema = z.object({
  domain: CrossDomainTypeSchema,
  entity: QlooEntityRefSchema,
  /** query.affinity 0..1, if returned. */
  affinity: z.number().optional(),
});
export type CrossDomainAffinity = z.infer<typeof CrossDomainAffinitySchema>;

/**
 * "Your card statement as a taste profile": what your places predict in
 * music, film and brands (Qloo /v2/insights with the places as signals).
 */
export const TasteFingerprintSchema = z.object({
  /** Qloo ids of the merchants used as signals. */
  sourceEntityIds: z.array(z.string()),
  sourceNames: z.array(z.string()),
  affinities: z.array(CrossDomainAffinitySchema),
  /** Characteristic place tags across your merchants (taste tags only). */
  topTags: z.array(QlooTagSchema),
  /** v1.5: each signal place's taste tags (lib/agent/taste-tags.ts) in Qloo's order; `topTags` is computed from these. */
  sources: z.array(z.object({ entityId: z.string(), name: z.string(), tasteTags: z.array(QlooTagSchema) })).optional(),
  /** One line, e.g. "Natural-wine bars, pour-over coffee, indie folk". */
  headline: z.string(),
});
export type TasteFingerprint = z.infer<typeof TasteFingerprintSchema>;

// ---------------------------------------------------------------------------
// Swaps

/** Why Qloo thinks the swap keeps your taste. Rendered as evidence chips. */
export const SwapEvidenceSchema = z.object({
  /** Qloo id of the candidate. */
  entityId: z.string(),
  /** Qloo id of the merchant used as `signal.interests.entities`. */
  signalEntityId: z.string(),
  /** Qloo affinity (query.affinity) 0..1, if returned. */
  affinity: z.number().optional(),
  /** Qloo popularity 0..1, if returned. */
  popularity: z.number().optional(),
  priceLevel: PriceLevelSchema.optional(),
  /** Price level of the original merchant, for the "$$$ -> $$" chip. */
  fromPriceLevel: PriceLevelSchema.optional(),
  /** Distance from the user's location (or the original merchant), km. */
  distanceKm: z.number().optional(),
  businessRating: z.number().optional(),
  /** Tags shared with (or characteristic of) the candidate. */
  tags: z.array(QlooTagSchema),
  /** Taste tags the candidate shares with the original merchant (since 1.5 taste tags only). */
  sharedTagIds: z.array(z.string()).optional(),
  /** v1.5: the same shared taste tags with their names, best kind first. */
  sharedTags: z.array(QlooTagSchema).optional(),
  /** Human-readable summary of the Qloo query that produced it (no data). */
  query: z.string(),
  /**
   * v1.1: cross-domain entities for this swap. Since v1.2 they come from a
   * per-swap Qloo insights call with the original and the twin as signals
   * (what both crowds love), so they differ per swap.
   */
  crossDomain: z.array(CrossDomainAffinitySchema).optional(),
});
export type SwapEvidence = z.infer<typeof SwapEvidenceSchema>;

export const SwapCandidateSchema = z.object({
  candidateId: z.string(),
  merchantKey: z.string(),
  entity: QlooEntityRefSchema,
  evidence: SwapEvidenceSchema,
  /** Our composite score 0..1 (affinity, price drop, distance, rating). */
  score: z.number(),
  /** Short reasons, e.g. "Same specialty-coffee tags", "0.6 km away". */
  reasons: z.array(z.string()),
});
export type SwapCandidate = z.infer<typeof SwapCandidateSchema>;

export const SavingsAssumptionsSchema = z.object({
  /** Estimated average ticket by price level, per category (currency units). */
  ticketByPriceLevel: z
    .record(z.string(), z.record(z.string(), z.number().min(0)))
    .optional(),
  /** Share of visits moved to the swap, 0..1. Default 0.75. */
  swapShare: z.number().min(0).max(1).optional(),
  /** Planning horizon in days. Default 30. */
  horizonDays: z.number().int().min(7).max(90).optional(),
});
export type SavingsAssumptions = z.infer<typeof SavingsAssumptionsSchema>;

export const SavingsEstimateSchema = z.object({
  currency: z.string(),
  visitsPerMonth: z.number(),
  ticketBefore: z.number(),
  ticketAfter: z.number(),
  swapShare: z.number(),
  monthlyBefore: z.number(),
  monthlyAfter: z.number(),
  monthlySavings: z.number(),
  annualSavings: z.number(),
  /**
   * observed: ticketBefore from the user's own transactions;
   * price_tier: both tickets from the price-level table.
   */
  method: z.enum(["observed_ticket", "price_tier"]),
  confidence: z.enum(["low", "medium", "high"]),
  /** Plain-language assumptions, editable in the UI. */
  notes: z.array(z.string()),
});
export type SavingsEstimate = z.infer<typeof SavingsEstimateSchema>;

export const SwapStatusSchema = z.enum(["proposed", "accepted", "rejected"]);
export type SwapStatus = z.infer<typeof SwapStatusSchema>;

export const SwapSchema = z.object({
  id: z.string(),
  merchantKey: z.string(),
  category: CategorySchema,
  from: z.object({
    name: z.string(),
    entity: QlooEntityRefSchema.optional(),
    visitsPerMonth: z.number(),
    monthlySpend: z.number(),
    avgTicket: z.number(),
  }),
  to: SwapCandidateSchema,
  /** Runner-up candidates, for "show me another". */
  alternatives: z.array(SwapCandidateSchema).optional(),
  savings: SavingsEstimateSchema,
  /** One or two sentences from the agent. */
  rationale: z.string(),
  /** v1.1: short "what you keep" line for the Taste Receipt. */
  keepReason: z.string().optional(),
  /**
   * v1.2: bridge line from `to.evidence.crossDomain`. Since 1.3 at most 40
   * chars and without the merchant names, e.g. "Also love: Cloveranchor Goods";
   * the long hand-written line is `Plan.heroBridge`.
   */
  crossDomainNote: z.string().optional(),
  /** v1.2: other request merchant keys merged into this line (same place under two descriptors). */
  mergedKeys: z.array(z.string()).optional(),
  status: SwapStatusSchema,
});
export type Swap = z.infer<typeof SwapSchema>;

/**
 * Compare view: what an LLM alone suggests, checked against Qloo /search.
 */
export const BaselineSuggestionSchema = z.object({
  merchantKey: z.string(),
  fromName: z.string(),
  /** Name the LLM suggested. */
  suggestedName: z.string(),
  /** v1.2: neighbourhood the LLM gave for it. */
  suggestedNeighborhood: z.string().optional(),
  /**
   * v1.2: "qloo": existsInQloo/cheaper were checked against live Qloo.
   * "pending_key": Qloo is mocked, so nothing was checked (existsInQloo is
   * false and means "not checked"); render as pending.
   */
  verification: z.enum(["qloo", "pending_key"]).optional(),
  /** Did /search find a real entity with that name near the location? */
  existsInQloo: z.boolean(),
  entity: QlooEntityRefSchema.optional(),
  /** Known only when found and Qloo returns price_level. */
  cheaper: z.boolean().optional(),
  note: z.string().optional(),
});
export type BaselineSuggestion = z.infer<typeof BaselineSuggestionSchema>;

/**
 * v1.3: one pick (our twin or the model's place) scored with the same Qloo
 * calls: affinity to the original merchant (signal: the original alone),
 * shared taste tags, price level and distance.
 */
export const ProofPickSchema = z.object({
  merchantKey: z.string(),
  fromName: z.string(),
  /** Our twin's name, or the name the model gave. */
  pickName: z.string(),
  entity: QlooEntityRefSchema.optional(),
  /** Found in Qloo; absent while it can't be checked (no Qloo key). */
  exists: z.boolean().optional(),
  /** Qloo affinity to the original, 0..1; absent if Qloo did not score it. */
  affinity: z.number().optional(),
  /** Taste tags shared with the original (lib/agent/taste-tags.ts). */
  sharedTagIds: z.array(z.string()),
  fromPriceLevel: PriceLevelSchema.optional(),
  priceLevel: PriceLevelSchema.optional(),
  /** priceLevel < fromPriceLevel; absent when either is unknown. */
  cheaper: z.boolean().optional(),
  /** From the user's location (since 1.6, the model's picks: to their nearest branch). */
  distanceKm: z.number().optional(),
  /** v1.6, the model's picks: how far around the user Qloo was searched for a branch, km. */
  searchedKm: z.number().optional(),
  /** v1.6, the model's picks: the neighbourhood the model said the place is in. */
  claimedHood: z.string().optional(),
  /** v1.6: the place really is in `claimedHood` (lib/agent/hoods.ts); absent when that can't be told. */
  inClaimedHood: z.boolean().optional(),
  /** Same savings engine on both sides; negative = costs more; absent when price levels are unknown. */
  monthlySavings: z.number().optional(),
});
export type ProofPick = z.infer<typeof ProofPickSchema>;

/**
 * v1.3: one side of the measured proof, on the same scale as the other side.
 * Nothing here is a constant. Since 1.4 each side is read over its own
 * `picks` (e.g. "5 cheaper of 5 picks" vs "2 cheaper of 9 picks"); a line we
 * kept on purpose is counted in `kept`, not as a miss.
 */
export const ProofSideSchema = z.object({
  /** Taste lines compared (the same for both sides). */
  of: z.number().int(),
  /** Picks given (ours: swaps; theirs: places named). */
  picks: z.number().int(),
  /** Picks found in Qloo; absent while existence can't be checked (no Qloo key). */
  exists: z.number().int().optional(),
  /** Mean Qloo affinity of the scored picks to their original, 0..1. */
  tasteLink: z.number().optional(),
  /** Picks Qloo gave an affinity for (the tasteLink's n). */
  tasteScored: z.number().int(),
  /** Picks sharing at least one taste tag with the original. */
  sharedTags: z.number().int(),
  /** Picks at a lower price level than the original. */
  cheaper: z.number().int(),
  /** v1.4: picks with a Qloo price level on both ends (the n behind `cheaper` and `monthlySavings`). */
  priced: z.number().int().optional(),
  /** v1.4, ours: taste lines kept without a pick because no honest cheaper twin exists. */
  kept: z.number().int().optional(),
  /** v1.4, ours: taste lines without a pick because a question to the user is open. */
  waiting: z.number().int().optional(),
  /** Sum of `monthlySavings` over the picks (negative = costs more). */
  monthlySavings: z.number(),
  /** Mean distance of the located picks from the user, km. */
  meanDistanceKm: z.number().optional(),
  /** v1.6: picks within 1.5 km of the user (over `picks`; a pick not found is not near). */
  near: z.number().int().optional(),
  /** v1.6: median distance of the located picks from the user, km. */
  medianDistanceKm: z.number().optional(),
  /** v1.6, the model: picks really in the neighbourhood it named, of `whereChecked`. */
  whereSaid: z.number().int().optional(),
  /** v1.6, the model: picks whose named neighbourhood could be checked. */
  whereChecked: z.number().int().optional(),
  /** v1.6, the model: each pick was resolved to its nearest branch (absent on older recordings: name match only). */
  nearestBranch: z.boolean().optional(),
  /** True when scored by the mock Qloo (QLOO_MOCK=1). */
  qlooMock: z.boolean(),
  perMerchant: z.array(ProofPickSchema),
});
export type ProofSide = z.infer<typeof ProofSideSchema>;

// ---------------------------------------------------------------------------
// Plan

export const PlanActionSchema = z.object({
  swapId: z.string().optional(),
  /** 1-based day in the horizon, if pinned. */
  day: z.number().int().min(1).optional(),
  text: z.string(),
});
export type PlanAction = z.infer<typeof PlanActionSchema>;

export const PlanWeekSchema = z.object({
  week: z.number().int().min(1),
  title: z.string(),
  actions: z.array(PlanActionSchema),
  /** Expected savings in this week. */
  expectedSavings: z.number(),
});
export type PlanWeek = z.infer<typeof PlanWeekSchema>;

/**
 * v1.1 Taste Receipt: the statement re-printed line by line,
 * original merchant -> taste twin -> what you keep -> monthly saving.
 * Rendered straight from `plan.receipt`.
 */
export const TasteReceiptLineSchema = z.object({
  merchantKey: z.string(),
  /** Statement descriptor as the user saw it. */
  rawMerchant: z.string(),
  name: z.string(),
  category: CategorySchema,
  visitsPerMonth: z.number(),
  monthlySpend: z.number(),
  /** swapped: has a twin; kept: no cheaper twin worth it; unresolved: not found in Qloo. */
  status: z.enum(["swapped", "kept", "unresolved"]),
  swapId: z.string().optional(),
  twin: z
    .object({
      name: z.string(),
      entityId: z.string(),
      priceLevel: PriceLevelSchema.optional(),
      fromPriceLevel: PriceLevelSchema.optional(),
      distanceKm: z.number().optional(),
      affinity: z.number().optional(),
    })
    .optional(),
  /** "Same pour-over and minimalist room"; or why it was kept. */
  keepReason: z.string(),
  /** Optional cross-domain line, e.g. "Fans of Lilia who love X go here". */
  crossDomainNote: z.string().optional(),
  /** v1.2: other request merchant keys merged into this line. */
  mergedKeys: z.array(z.string()).optional(),
  monthlySaving: z.number(),
});
export type TasteReceiptLine = z.infer<typeof TasteReceiptLineSchema>;

export const TasteReceiptSchema = z.object({
  lines: z.array(TasteReceiptLineSchema),
  currency: z.string(),
  monthlyBefore: z.number(),
  monthlyAfter: z.number(),
  monthlySavings: z.number(),
  annualSavings: z.number(),
  /** Mean Qloo affinity of the twins, 0..1 ("taste kept"). */
  tasteKept: z.number().optional(),
});
export type TasteReceipt = z.infer<typeof TasteReceiptSchema>;

export const PlanSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  horizonDays: z.number().int(),
  currency: z.string(),
  location: LocationSchema,
  swaps: z.array(SwapSchema),
  weeks: z.array(PlanWeekSchema),
  totals: z.object({
    monthlyBefore: z.number(),
    monthlyAfter: z.number(),
    monthlySavings: z.number(),
    annualSavings: z.number(),
    /** Share of analysed spend saved, 0..1. */
    savingsRate: z.number(),
  }),
  /** Merchants we could not swap and why (unresolved, no cheaper match...). */
  unswapped: z.array(
    z.object({ merchantKey: z.string(), name: z.string(), reason: z.string() }),
  ),
  summary: z.string(),
  /** v1.1 */
  receipt: TasteReceiptSchema.optional(),
  /** v1.1 */
  fingerprint: TasteFingerprintSchema.optional(),
  /** v1.3: our side of the measured proof (compare with `baseline_ready.proof`). */
  proof: ProofSideSchema.optional(),
  /** v1.3: the one long bridge the pen hand-writes, for the best swap. */
  heroBridge: z.object({ swapId: z.string(), merchantKey: z.string(), text: z.string() }).optional(),
});
export type Plan = z.infer<typeof PlanSchema>;

// ---------------------------------------------------------------------------
// Questions and feedback

export const AgentQuestionSchema = z.object({
  id: z.string(),
  kind: z.enum(["ambiguous_merchant", "location", "preference", "confirm"]),
  merchantKey: z.string().optional(),
  prompt: z.string(),
  options: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      detail: z.string().optional(),
      entityId: z.string().optional(),
    }),
  ),
  allowFreeText: z.boolean(),
});
export type AgentQuestion = z.infer<typeof AgentQuestionSchema>;

export const AnswerSchema = z.object({
  questionId: z.string(),
  merchantKey: z.string().optional(),
  optionId: z.string().optional(),
  entityId: z.string().optional(),
  text: z.string().max(500).optional(),
});
export type Answer = z.infer<typeof AnswerSchema>;

export const SwapFeedbackSchema = z.object({
  swapId: z.string(),
  merchantKey: z.string(),
  candidateEntityId: z.string(),
  verdict: z.enum(["accept", "reject"]),
  /** Free text, e.g. "too far", "not that vibe". */
  reason: z.string().max(500).optional(),
});
export type SwapFeedback = z.infer<typeof SwapFeedbackSchema>;

// ---------------------------------------------------------------------------
// Request

export const AgentModeSchema = z.enum([
  /** Full Qloo-backed agent. */
  "sametaste",
  /** Baseline for the compare view: LLM guesses, then /search checks they exist. */
  "llm_only",
]);
export type AgentMode = z.infer<typeof AgentModeSchema>;

export const AgentRequestSchema = z.object({
  version: z.literal(CONTRACT_VERSION).optional(),
  mode: AgentModeSchema.default("sametaste"),
  /** Persona id when running a preset (enables cached fallback). */
  personaId: z.string().max(60).optional(),
  location: LocationSchema,
  merchants: z.array(MerchantAggregateSchema).min(1).max(200),
  answers: z.array(AnswerSchema).max(50).optional(),
  feedback: z.array(SwapFeedbackSchema).max(100).optional(),
  assumptions: SavingsAssumptionsSchema.optional(),
  /** Previous plan, so a re-plan keeps accepted swaps. */
  previousPlan: PlanSchema.optional(),
});
export type AgentRequest = z.input<typeof AgentRequestSchema>;
export type ParsedAgentRequest = z.output<typeof AgentRequestSchema>;

// ---------------------------------------------------------------------------
// Streamed events

export const AgentPhaseSchema = z.enum([
  "normalizing",
  "resolving",
  "ranking",
  "searching",
  "scoring",
  "planning",
  "done",
]);
export type AgentPhase = z.infer<typeof AgentPhaseSchema>;

export const ToolNameSchema = z.enum([
  "normalize_merchants",
  "qloo_search",
  "qloo_insights",
  "qloo_tags",
  /** v1.1 cross-domain fingerprint. */
  "qloo_taste_profile",
  "ask_user",
  "savings_engine",
  "propose_swap",
  "plan_writer",
]);
export type ToolName = z.infer<typeof ToolNameSchema>;

const EventBase = {
  runId: z.string(),
  seq: z.number().int().min(0),
  /** ISO timestamp. */
  ts: z.string(),
};

export const UsageSchema = z.object({
  toolTurns: z.number().int(),
  qlooCalls: z.number().int(),
  costUsd: z.number(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const AgentEventSchema = z.discriminatedUnion("type", [
  /** First event of every run. */
  z.object({
    ...EventBase,
    type: z.literal("run_started"),
    mode: AgentModeSchema,
    /** True when Qloo is mocked (QLOO_MOCK=1). */
    qlooMock: z.boolean(),
    /** True when served from cached persona results (spend cap reached). */
    fromCache: z.boolean(),
    /**
     * v1.3: statement lines that are one place, known before any other event
     * (e.g. BLUE BTL into BLUE BOTTLE COFFE), so rows can merge before they print.
     */
    merges: z.array(z.object({ merchantKey: z.string(), mergedKeys: z.array(z.string()) })).optional(),
  }),
  z.object({
    ...EventBase,
    type: z.literal("status"),
    phase: AgentPhaseSchema,
    message: z.string(),
  }),
  z.object({
    ...EventBase,
    type: z.literal("tool_step"),
    stepId: z.string(),
    tool: ToolNameSchema,
    state: z.enum(["started", "finished", "failed"]),
    /** Short, user-safe description, e.g. "Searched Qloo for 'Blue Bottle'". */
    summary: z.string(),
    durationMs: z.number().optional(),
    /** Qloo calls made by this step. */
    qlooCalls: z.number().int().optional(),
  }),
  z.object({
    ...EventBase,
    type: z.literal("merchants_resolved"),
    resolutions: z.array(MerchantResolutionSchema),
  }),
  z.object({
    ...EventBase,
    type: z.literal("question"),
    question: AgentQuestionSchema,
  }),
  z.object({
    ...EventBase,
    type: z.literal("swap_proposed"),
    swap: SwapSchema,
  }),
  z.object({
    ...EventBase,
    type: z.literal("plan_ready"),
    plan: PlanSchema,
  }),
  /** v1.1: cross-domain taste fingerprint. */
  z.object({
    ...EventBase,
    type: z.literal("taste_fingerprint"),
    fingerprint: TasteFingerprintSchema,
  }),
  /** llm_only mode result, for the compare view. */
  z.object({
    ...EventBase,
    type: z.literal("baseline_ready"),
    suggestions: z.array(BaselineSuggestionSchema),
    /** v1.3: the model's side of the measured proof (compare with `Plan.proof`). */
    proof: ProofSideSchema.optional(),
    /** v1.6: every model-alone run of a recording (`eval:record-demo --baseline-runs N`), the first being `proof`. */
    proofRuns: z.array(ProofSideSchema).optional(),
  }),
  /** Free text from the agent (thinking-out-loud for the activity feed). */
  z.object({
    ...EventBase,
    type: z.literal("message"),
    text: z.string(),
  }),
  z.object({
    ...EventBase,
    type: z.literal("error"),
    code: z.enum([
      "bad_request",
      "rate_limited",
      "spend_cap",
      "qloo_error",
      "model_error",
      "limit_reached",
      "internal",
    ]),
    message: z.string(),
    retryable: z.boolean(),
  }),
  /** Always last. */
  z.object({
    ...EventBase,
    type: z.literal("done"),
    reason: z.enum(["complete", "awaiting_answer", "limit_reached", "error"]),
    usage: UsageSchema,
  }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentEventType = AgentEvent["type"];
export type AgentEventOf<T extends AgentEventType> = Extract<
  AgentEvent,
  { type: T }
>;

/** Parse one NDJSON line from the stream. Returns null for blank lines. */
export function parseAgentEventLine(line: string): AgentEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  return AgentEventSchema.parse(JSON.parse(trimmed));
}

// ---------------------------------------------------------------------------
// Benchmark (v1.1): eval/results/*.summary.json, safe to show in the UI

export const BenchmarkSystemMetricsSchema = z.object({
  /** Merchants with at least one suggestion. */
  answered: z.number().int(),
  /** Share of suggestions that do not exist in Qloo /search near the city. */
  hallucinationRate: z.number(),
  /** Share of merchants with a real, cheaper (lower price_level) suggestion. */
  cheaperHitRate: z.number(),
  /** Mean Qloo affinity of real suggestions to the original, 0..1. */
  tasteMatch: z.number(),
  /** Estimated monthly savings for the benchmark basket, USD. */
  monthlySavingsUsd: z.number(),
});
export type BenchmarkSystemMetrics = z.infer<typeof BenchmarkSystemMetricsSchema>;

export const BenchmarkSummarySchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  /** "mock" numbers come from synthetic data and prove nothing. */
  qlooMode: z.enum(["mock", "live"]),
  modelMode: z.enum(["scripted", "live"]),
  city: z.string(),
  merchantCount: z.number().int(),
  /** Share of benchmark merchants resolved via /search. */
  resolveRate: z.number(),
  systems: z.object({
    llm_only: BenchmarkSystemMetricsSchema,
    sametaste: BenchmarkSystemMetricsSchema,
  }),
  gate: z.object({
    threshold: z.number(),
    resolveRate: z.number(),
    cheaperHitRate: z.number(),
    pass: z.boolean(),
  }),
  qlooCalls: z.number().int(),
});
export type BenchmarkSummary = z.infer<typeof BenchmarkSummarySchema>;
