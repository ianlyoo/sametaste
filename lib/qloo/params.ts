/**
 * Per-entity-type parameter whitelist for GET /v2/insights.
 *
 * Qloo silently ignores invalid parameters (and then returns empty or
 * unfiltered results), so every request is validated here before it is sent.
 *
 * Source: Entity Type Parameter Guide, page updated 2026-07-08, seen
 * 2026-10-22 (https://docs.qloo.com/reference/available-parameters-by-entity-type).
 * Additions, each with its source:
 * - `feature.explainability`, `page`: Parameter Reference lists them for all
 *   entity types (https://docs.qloo.com/reference/parameters, seen 2026-10-22).
 * - `filter.location.query` for place: used by the official recipe
 *   "Find restaurants like Balthazar in New York" (updated 2026-05-14).
 */
import type { QlooEntityType } from "./types";

const COMMON = [
  "filter.type",
  "bias.trends",
  "filter.exclude.entities",
  "filter.exclude.tags",
  "operator.exclude.tags",
  "filter.external.exists",
  "operator.filter.external.exists",
  "filter.parents.types",
  "filter.popularity.min",
  "filter.popularity.max",
  "filter.results.entities",
  "filter.results.entities.query",
  "filter.tags",
  "operator.filter.tags",
  "offset",
  "signal.demographics.age",
  "signal.demographics.audiences",
  "signal.demographics.audiences.weight",
  "signal.demographics.gender",
  "signal.interests.entities",
  "signal.interests.tags",
  "take",
  // Parameter Reference: all entity types.
  "feature.explainability",
  "page",
] as const;

const GEO = [
  "filter.geocode.name",
  "filter.geocode.admin1_region",
  "filter.geocode.admin2_region",
  "filter.geocode.country_code",
  "filter.location",
  "filter.location.radius",
  "filter.location.geohash",
  "filter.exclude.location.geohash",
] as const;

export const INSIGHTS_PARAMS: Record<QlooEntityType, ReadonlySet<string>> = {
  artist: new Set(COMMON),
  book: new Set([...COMMON, "filter.publication_year.min", "filter.publication_year.max"]),
  brand: new Set(COMMON),
  destination: new Set([...COMMON, ...GEO]),
  movie: new Set([
    ...COMMON,
    "filter.content_rating",
    "filter.release_year.min",
    "filter.release_year.max",
    "filter.release_country",
    "operator.filter.release_country",
    "filter.rating.min",
    "filter.rating.max",
  ]),
  person: new Set([
    ...COMMON,
    "filter.date_of_birth.min",
    "filter.date_of_birth.max",
    "filter.date_of_death.min",
    "filter.date_of_death.max",
    "filter.gender",
  ]),
  place: new Set([
    ...COMMON,
    ...GEO,
    "filter.location.query",
    "bias.quality",
    "filter.address",
    "filter.external.tripadvisor.rating.count.max",
    "filter.external.tripadvisor.rating.count.min",
    "filter.external.tripadvisor.rating.max",
    "filter.external.tripadvisor.rating.min",
    "filter.hotel_class.max",
    "filter.hotel_class.min",
    "filter.hours",
    "filter.price_level.min",
    "filter.price_level.max",
    "filter.price_range.from",
    "filter.price_range.to",
    "filter.properties.business_rating.min",
    "filter.properties.business_rating.max",
    "filter.properties.resy.rating.min",
    "filter.properties.resy.rating.max",
    "filter.references_brand",
    "filter.resy.rating_count.min",
    "filter.resy.rating_count.max",
    "filter.resy.rating.party.min",
    "filter.resy.rating.party.max",
    "sort_by",
  ]),
  podcast: new Set(COMMON),
  tv_show: new Set([
    ...COMMON,
    "filter.content_rating",
    "filter.finale_year.max",
    "filter.finale_year.min",
    "filter.latest_known_year.max",
    "filter.latest_known_year.min",
    "filter.release_year.max",
    "filter.release_year.min",
    "filter.release_country",
    "operator.filter.release_country",
    "filter.rating.max",
    "filter.rating.min",
  ]),
  video_game: new Set(COMMON),
};

/** Parameters required per type (destination needs a signal entity). */
const REQUIRED: Partial<Record<QlooEntityType, string[]>> = {
  destination: ["signal.interests.entities"],
};

/** GET /search parameters (reference updated 2026-07-20). */
export const SEARCH_PARAMS: ReadonlySet<string> = new Set([
  "query",
  "types",
  "filter.location",
  "filter.radius",
  "filter.exists",
  "filter.tags",
  "filter.rating",
  "filter.popularity",
  "filter.address",
  "operator.filter.tags",
  "page",
  "take",
  "sort_by",
]);

/**
 * GET /v2/tags parameters. The reference page was not reachable on
 * 2026-10-22 (404); these follow the Parameter Reference names and must be
 * confirmed live.
 */
export const TAGS_PARAMS: ReadonlySet<string> = new Set([
  "filter.query",
  "filter.tag.types",
  "filter.parents.types",
  "take",
  "page",
]);

export type ParamValue = string | number | boolean | readonly (string | number)[];
export type Params = Record<string, ParamValue | undefined>;

export class QlooParamError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = "QlooParamError";
  }
}

type Range = { min?: number; max?: number; int?: boolean };

/** Value ranges from the deep-dive spec. */
const RANGES: Record<string, Range> = {
  take: { min: 1, max: 50, int: true },
  page: { min: 1, max: 100, int: true },
  offset: { min: 0, int: true },
  "filter.location.radius": { min: 0, max: 800_000 },
  "filter.price_level.min": { min: 1, max: 4, int: true },
  "filter.price_level.max": { min: 1, max: 4, int: true },
  "filter.popularity.min": { min: 0, max: 1 },
  "filter.popularity.max": { min: 0, max: 1 },
  "filter.properties.business_rating.min": { min: 0, max: 5 },
  "filter.properties.business_rating.max": { min: 0, max: 5 },
};

const SEARCH_RANGES: Record<string, Range> = {
  take: { min: 1, max: 199, int: true },
  page: { min: 1, max: 100, int: true },
  "filter.radius": { min: 0, max: 100 },
  "filter.rating": { min: 0, max: 5 },
  "filter.popularity": { min: 0, max: 1 },
};

function checkRanges(params: Params, ranges: Record<string, Range>, issues: string[]) {
  for (const [k, r] of Object.entries(ranges)) {
    const v = params[k];
    if (v === undefined) continue;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) {
      issues.push(`${k} must be a number`);
      continue;
    }
    if (r.int && !Number.isInteger(n)) issues.push(`${k} must be an integer`);
    if (r.min !== undefined && n < r.min) issues.push(`${k} must be >= ${r.min}`);
    if (r.max !== undefined && n > r.max) issues.push(`${k} must be <= ${r.max}`);
  }
}

function present(params: Params): string[] {
  return Object.keys(params).filter((k) => params[k] !== undefined);
}

/** Throws QlooParamError if any parameter is not valid for this entity type. */
export function validateInsightsParams(type: QlooEntityType, params: Params): void {
  const allowed = INSIGHTS_PARAMS[type];
  const issues: string[] = [];
  for (const k of present(params)) {
    if (!allowed.has(k)) issues.push(`${k} is not supported for ${type}`);
  }
  for (const k of REQUIRED[type] ?? []) {
    if (params[k] === undefined) issues.push(`${k} is required for ${type}`);
  }
  const min = params["filter.price_level.min"];
  const max = params["filter.price_level.max"];
  if (min !== undefined && max !== undefined && Number(min) > Number(max)) {
    issues.push("filter.price_level.min must be <= filter.price_level.max");
  }
  if (params["filter.location.radius"] !== undefined && params["filter.location"] === undefined && params["filter.location.query"] === undefined) {
    issues.push("filter.location.radius needs filter.location or filter.location.query");
  }
  checkRanges(params, RANGES, issues);
  if (issues.length) {
    throw new QlooParamError(`Invalid Qloo insights params: ${issues.join("; ")}`, issues);
  }
}

export function validateSearchParams(params: Params): void {
  const issues: string[] = [];
  for (const k of present(params)) {
    if (!SEARCH_PARAMS.has(k)) issues.push(`${k} is not a /search parameter`);
  }
  if (params.query === undefined && params["filter.location"] === undefined) {
    issues.push("query or filter.location is required");
  }
  checkRanges(params, SEARCH_RANGES, issues);
  if (issues.length) {
    throw new QlooParamError(`Invalid Qloo search params: ${issues.join("; ")}`, issues);
  }
}

export function validateTagsParams(params: Params): void {
  const issues: string[] = [];
  for (const k of present(params)) {
    if (!TAGS_PARAMS.has(k)) issues.push(`${k} is not a /v2/tags parameter`);
  }
  checkRanges(params, { take: { min: 1, max: 50, int: true } }, issues);
  if (issues.length) {
    throw new QlooParamError(`Invalid Qloo tags params: ${issues.join("; ")}`, issues);
  }
}

/** Encode params as a sorted query string; arrays become comma lists. */
export function toQueryString(params: Params): string {
  const sp = new URLSearchParams();
  for (const k of present(params).sort()) {
    const v = params[k]!;
    sp.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  return sp.toString();
}

/** WKT point, longitude first (per the docs). */
export function wktPoint(lat: number, lon: number): string {
  return `POINT(${lon} ${lat})`;
}
