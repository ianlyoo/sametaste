/**
 * Merchant-string normalisation: "SQ *BLUE BTL 0423" -> "Blue Bottle Coffee".
 *
 * A deterministic pass handles processor prefixes, store numbers, locations
 * and known abbreviations. Uncertain names then go to the normaliser model
 * (claude-haiku-5-5) in one batched structured call when a model is given.
 */
import { generateText, NoObjectGeneratedError, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { normName } from "./text";
import { CategorySchema, QlooEntityTypeSchema, type Category, type MerchantAggregate, type QlooEntityType } from "../contract";

export interface NormalizedMerchant {
  key: string;
  rawMerchant: string;
  name: string;
  category: Category;
  entityType: QlooEntityType;
  /** Non-taste spend (rent, transfers, utilities...) is not swapped. */
  skip: boolean;
  skipReason?: string;
  /** 0..1 */
  confidence: number;
  source: "rules" | "model";
}

const PREFIXES = [
  /^SQ\s*\*\s*/i,
  /^TST\s*\*\s*/i,
  /^SP\s*\*\s*/i,
  /^PY\s*\*\s*/i,
  /^PAYPAL\s*\*\s*/i,
  /^DD\s*\*\s*(DOORDASH\s*)?/i,
  /^DOORDASH\s*\*\s*/i,
  /^UBER\s*\*\s*EATS\s*/i,
  /^GRUBHUB\s*\*\s*/i,
  /^SEAMLSS\s*\*?\s*/i,
  /^CKE\s*\*\s*/i,
  /^GOOGLE\s*\*\s*/i,
  /^APPLE\.COM\/BILL\s*/i,
  /^POS\s+(DEBIT\s+)?/i,
  /^DEBIT\s+(CARD\s+)?(PURCHASE\s+)?/i,
  /^CHECKCARD\s+\d*\s*/i,
  /^PURCHASE\s+/i,
];

const SUFFIXES = [
  /\s+(NEW\s*YORK|NEW\s*YOR|NYC|BROOKLYN|BKLYN|QUEENS|ASTORIA|LONG\s*ISLAND\s*C\w*|MANHATTAN)\b.*$/i,
  /\s+[A-Z]{2}\s*\d{5}(-\d{4})?$/i,
  /\s+\d{3}-\d{3}-\d{4}.*$/,
  /\s+\d{2}\/\d{2}.*$/,
  /\s+#\s*\d+.*$/,
  /\s+(STORE|STR|LOC)\s*\d+.*$/i,
  /\s+\d{3,}\s*$/,
  /\s+[A-Z]?\d{2,}[A-Z]?\s*$/i,
  /\s+NY\s*$/i,
];

/** Abbreviation -> canonical name, category, type. Order matters. */
const KNOWN: [RegExp, string, Category, QlooEntityType?][] = [
  [/^BLUE\s*BTL|^BLUE\s*BOTTLE/i, "Blue Bottle Coffee", "coffee"],
  [/^SBUX|^STARBUCKS/i, "Starbucks", "coffee"],
  [/^JOE\s*(COFFEE|PRO)/i, "Joe Coffee Company", "coffee"],
  [/^LA\s*COLOMBE/i, "La Colombe Coffee Roasters", "coffee"],
  [/^RALPHS?\s*COFFEE/i, "Ralph's Coffee", "coffee"],
  [/^PDT\b/i, "Please Don't Tell", "bar"],
  [/^DEVOCION/i, "Devoción", "coffee"],
  [/^STUMPTOWN/i, "Stumptown Coffee Roasters", "coffee"],
  [/^BLUESTONE/i, "Bluestone Lane", "coffee"],
  [/^PARTNERS\s*COF/i, "Partners Coffee", "coffee"],
  [/^WHOLEFDS|^WHOLE\s*FOODS|^WFM\b/i, "Whole Foods Market", "grocery"],
  [/^TRADER\s*JOE/i, "Trader Joe's", "grocery"],
  [/^SWEETGREEN/i, "Sweetgreen", "fast_food"],
  [/^CAVA\b/i, "CAVA", "fast_food"],
  [/^SHAKE\s*SHACK/i, "Shake Shack", "fast_food"],
  [/^LOS\s*TACOS/i, "Los Tacos No. 1", "fast_food"],
  [/^XI\s*AN|^XIAN/i, "Xi'an Famous Foods", "fast_food"],
  [/^DIG\s*(INN)?\b/i, "Dig", "fast_food"],
  [/^EQUINOX|^EQX\b/i, "Equinox", "fitness"],
  [/^SOULCYCLE|^SOUL\s*CYCLE/i, "SoulCycle", "fitness"],
  [/^BARRYS|^BARRY'?S/i, "Barry's", "fitness"],
  [/^PLANET\s*FIT/i, "Planet Fitness", "fitness"],
  [/^CRUNCH/i, "Crunch Fitness", "fitness"],
  [/^DRYBAR/i, "Drybar", "beauty"],
  [/^KATZ/i, "Katz's Delicatessen", "restaurant"],
  [/^JOES?\s*PIZZA|^JOE'S\s*PIZZA/i, "Joe's Pizza", "restaurant"],
  [/^PETER\s*LUGER/i, "Peter Luger Steak House", "restaurant"],
  [/^MOMOFUKU/i, "Momofuku Noodle Bar", "restaurant"],
  [/^RUSS\s*(&|AND)?\s*DAUGHT/i, "Russ & Daughters Cafe", "restaurant"],
  [/^LE\s*BERNARDIN/i, "Le Bernardin", "restaurant"],
  [/^LLAMA\s*INN/i, "Llama Inn", "restaurant"],
  [/^COTE\b/i, "Cote Korean Steakhouse", "restaurant"],
  [/^THAI\s*DINER/i, "Thai Diner", "restaurant"],
  [/^CAFE\s*MOGADOR/i, "Cafe Mogador", "restaurant"],
  [/^DEATH\s*(&|AND)\s*CO/i, "Death & Co", "bar"],
  [/^EMPLOYEES\s*ONLY/i, "Employees Only", "bar"],
  [/^MCSORLEY/i, "McSorley's Old Ale House", "bar"],
  [/^FOUR\s*HORSEMEN|^THE\s*FOUR\s*HORSE/i, "The Four Horsemen", "bar"],
];

const SKIP: [RegExp, string, Category][] = [
  [/\bRENT\b|PROPERTY\s*MGMT|LANDLORD|APARTMENTS?\b/i, "rent or housing", "other"],
  [/VENMO|ZELLE|CASH\s*APP|PAYPAL\s*TRANSFER|TRANSFER\b|\bATM\b|WITHDRAWAL/i, "money transfer", "other"],
  [/CON\s*ED|NATIONAL\s*GRID|VERIZON|T-?MOBILE|AT&T|SPECTRUM|COMCAST|OPTIMUM/i, "utility or phone bill", "other"],
  [/\bMTA\b|OMNY|METROCARD|NJ\s*TRANSIT|LIRR|CITI\s*BIKE|UBER(?!\s*\*?\s*EATS)|LYFT/i, "transport", "transport"],
  [/INSURANCE|GEICO|LEMONADE|STATE\s*FARM/i, "insurance", "other"],
  [/NETFLIX|SPOTIFY|HULU|DISNEY\s*PLUS|HBO\s*MAX|APPLE\s*MUSIC|YOUTUBE\s*PREMIUM/i, "subscription (entertainment swaps come later)", "streaming"],
  [/PAYROLL|DIRECT\s*DEP|INTEREST\b|REFUND/i, "income or refund", "other"],
  [/AMAZON|AMZN|TARGET|WALGREENS|CVS|DUANE\s*READE/i, "general retail, not a taste merchant", "shopping"],
];

const CATEGORY_HINTS: [RegExp, Category][] = [
  [/COFFEE|ESPRESSO|CAFE\b|ROASTER/i, "coffee"],
  [/BAR\b|TAVERN|PUB\b|ALE\s*HOUSE|COCKTAIL|WINE/i, "bar"],
  [/PIZZA|DELI|KITCHEN|BISTRO|TRATTORIA|RESTAURANT|GRILL|SUSHI|RAMEN|TACO|BURGER|DINER|STEAK/i, "restaurant"],
  [/FITNESS|GYM|YOGA|PILATES|CYCLE|BOXING|CLIMB/i, "fitness"],
  [/MARKET|GROCERY|FOODS\b/i, "grocery"],
  [/SALON|SPA\b|NAILS|BARBER|BLOWOUT/i, "beauty"],
];

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\b(Nyc|Ny)\b/g, (m) => m.toUpperCase())
    .replace(/'S\b/g, "'s");
}

/**
 * True if every word of `name` is in the descriptor or expands one of its
 * words: a prefix ("DEVOC" -> devocion) or a same-initial abbreviation
 * ("KFFE" -> kaffe, "BTL" -> bottle).
 */
export function derivable(name: string, raw: string): boolean {
  const have = new Set(`${normName(cleanDescriptor(raw))} ${normName(raw)}`.split(" ").filter(Boolean));
  const subseq = (h: string, w: string) => {
    let i = 0;
    for (const ch of w) if (ch === h[i]) i++;
    return i === h.length;
  };
  return normName(name)
    .split(" ")
    .filter(Boolean)
    .every((w) => [...have].some((h) => h === w || (h.length >= 2 && h[0] === w[0] && (w.startsWith(h) || subseq(h, w)))));
}

export function cleanDescriptor(raw: string): string {
  let s = raw.trim().replace(/\s+/g, " ");
  for (const p of PREFIXES) s = s.replace(p, "");
  for (let i = 0; i < 3; i++) for (const x of SUFFIXES) s = s.replace(x, "");
  return s.replace(/[*#]+/g, " ").replace(/\s+/g, " ").replace(/[\s\-–,.:]+$/, "").trim();
}

/** Deterministic normalisation of one merchant. */
/**
 * Rules pass. `known: false` skips the hand-written alias table (the
 * benchmark uses it so its resolve rate does not lean on aliases written
 * for the benchmark's own merchants).
 */
export function normalizeByRules(m: MerchantAggregate, opts: { known?: boolean } = {}): NormalizedMerchant {
  const raw = m.rawMerchant;
  for (const [re, reason, category] of SKIP) {
    if (re.test(raw)) {
      return { key: m.key, rawMerchant: raw, name: titleCase(cleanDescriptor(raw)), category, entityType: "place", skip: true, skipReason: reason, confidence: 0.9, source: "rules" };
    }
  }
  const cleaned = cleanDescriptor(raw);
  // the client's "other" is no information; a known alias knows better
  const given = m.category && m.category !== "other" ? m.category : undefined;
  for (const [re, name, category, type] of opts.known === false ? [] : KNOWN) {
    if (re.test(cleaned)) {
      return { key: m.key, rawMerchant: raw, name, category, entityType: type ?? "place", skip: false, confidence: 0.95, source: "rules" };
    }
  }
  const hinted = CATEGORY_HINTS.find(([re]) => re.test(cleaned))?.[1];
  const category = given ?? hinted ?? "other";
  return {
    key: m.key,
    rawMerchant: raw,
    name: titleCase(cleaned || raw),
    category,
    entityType: "place",
    skip: false,
    // unknown abbreviations are what the model pass is for
    confidence: hinted || given ? 0.6 : 0.4,
    source: "rules",
  };
}

const ModelOutputSchema = z.object({
  merchants: z.array(
    z.object({
      key: z.string(),
      name: z.string().describe("Canonical public business or brand name, e.g. 'Blue Bottle Coffee'"),
      category: CategorySchema,
      entityType: QlooEntityTypeSchema.describe("'place' for venues, 'brand' for online/national brands"),
      skip: z.boolean().describe("true for rent, transfers, bills, transport, generic retail"),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

export interface NormalizeResult {
  merchants: NormalizedMerchant[];
  /** Usage of the model call, if one was made. */
  usage?: Parameters<typeof import("./pricing").costUsd>[1];
  modelId?: string;
}

/**
 * Normalise all merchants: rules first, then one batched model call for
 * those below `threshold` confidence.
 */
export async function normalizeMerchants(
  merchants: MerchantAggregate[],
  opts: { model?: LanguageModel; modelId?: string; threshold?: number; city?: string; abortSignal?: AbortSignal; known?: boolean } = {},
): Promise<NormalizeResult> {
  const out = merchants.map((m) => normalizeByRules(m, { known: opts.known }));
  const threshold = opts.threshold ?? 0.7;
  const unsure = out.filter((n) => !n.skip && n.confidence < threshold);
  if (!opts.model || unsure.length === 0) return { merchants: out };

  const list = unsure.map((n) => `${n.key}\t${n.rawMerchant}`).join("\n");
  const result = await generateText({
    model: opts.model,
    output: Output.object({ schema: ModelOutputSchema }),
    instructions:
      "You clean card-statement merchant descriptors into canonical business names for lookup in a taste database. " +
      "Strip processor prefixes (SQ *, TST*, DD *), store numbers and locations. Expand abbreviations only when you are confident; " +
      "otherwise return the cleaned text and a low confidence. Never invent a business. " +
      "If the descriptor is a short name many businesses share (e.g. 'JOE'S'), return it as is with confidence below 0.5; do not add words like Coffee or Pizza.",
    prompt: `City: ${opts.city ?? "New York, NY"}\nOne merchant per line as key<TAB>descriptor:\n${list}`,
    maxOutputTokens: 4000,
    abortSignal: opts.abortSignal,
  }).catch((err: unknown) => {
    // unparseable answer: keep the rules result, but report the billed usage
    if (NoObjectGeneratedError.isInstance(err)) return { failed: true as const, usage: err.usage };
    throw err;
  });
  if ("failed" in result) return { merchants: out, usage: result.usage, modelId: opts.modelId };
  const byKey = new Map(result.output.merchants.map((m) => [m.key, m]));
  for (const n of out) {
    const m = byKey.get(n.key);
    if (!m || n.skip) continue;
    // a guess that adds words the descriptor does not contain ("JOE'S" -> "Joe's Coffee")
    // needs high confidence; plain clean-ups and expansions of the same words pass
    if (m.confidence > n.confidence && (m.confidence >= 0.85 || derivable(m.name, n.rawMerchant))) {
      n.name = m.name;
      n.category = m.category;
      n.entityType = m.entityType;
      n.skip = m.skip;
      n.skipReason = m.skip ? "not a taste merchant" : undefined;
      n.confidence = m.confidence;
      n.source = "model";
    }
  }
  return { merchants: out, usage: result.usage, modelId: opts.modelId };
}

/** Category from a resolved entity's Qloo category tags, for lines still filed under "other". */
export function categoryFromTags(tags: { id: string }[]): Category | undefined {
  const cats = tags.map((t) => t.id).filter((id) => /:category:/.test(id)).join(" ");
  const rules: [RegExp, Category][] = [
    [/coffee|cafe|espresso|tea_house/, "coffee"],
    [/fast_casual|fast_food|quick_service|sandwich|salad/, "fast_food"],
    [/bar\b|_bar|pub|brewery|wine|cocktail|lounge/, "bar"],
    [/restaurant|bistro|trattoria|diner|steakhouse|eatery/, "restaurant"],
    [/gym|fitness|yoga|cycling|pilates|climbing/, "fitness"],
    [/grocery|supermarket|market/, "grocery"],
    [/salon|spa|barber|beauty|nail/, "beauty"],
    [/store|shop|boutique|retail/, "shopping"],
    [/cinema|theater|theatre|museum|venue|club/, "entertainment"],
  ];
  return rules.find(([re]) => re.test(cats))?.[1];
}
