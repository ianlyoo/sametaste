/**
 * Typed Qloo client for /search, /v2/insights and /v2/tags.
 *
 * - Base URL from QLOO_BASE_URL (default https://hackathon.api.qloo.com),
 *   key from QLOO_API_KEY in the X-Api-Key header. The key never appears in
 *   errors, logs or cache keys.
 * - Every request is validated against the per-type whitelist (params.ts).
 * - Responses are cached privately in memory (cache.ts); cache hits do not
 *   count against the per-run call budget.
 * - QLOO_MOCK=1 swaps `fetch` for the synthetic mock (mock/fetch.ts).
 */
import type { QlooEntityType } from "../contract";
import { MemoryCache, type QlooCache } from "./cache";
import { createMockFetch } from "./mock/fetch";
import {
  toQueryString,
  validateInsightsParams,
  validateSearchParams,
  validateTagsParams,
  wktPoint,
  type Params,
} from "./params";
import {
  entityUrn,
  normalizeEntity,
  normalizeTag,
  RawInsightsResponseSchema,
  RawSearchResponseSchema,
  RawTagsResponseSchema,
  searchTypeUrn,
  type QlooEntity,
  type QlooTagOut,
} from "./types";

export const DEFAULT_QLOO_BASE_URL = "https://hackathon.api.qloo.com";

export class QlooHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    detail?: string,
  ) {
    super(`Qloo ${path} failed with HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "QlooHttpError";
  }
  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}

export class QlooBudgetError extends Error {
  constructor(readonly max: number) {
    super(`Qloo call budget of ${max} calls for this run is used up`);
    this.name = "QlooBudgetError";
  }
}

/** Per-run call budget (DESIGN: at most 40 Qloo calls per run). */
export class CallBudget {
  used = 0;
  constructor(readonly max: number) {}
  get remaining() {
    return Math.max(0, this.max - this.used);
  }
  consume() {
    if (this.used >= this.max) throw new QlooBudgetError(this.max);
    this.used++;
  }
}

export interface QlooCallInfo {
  path: string;
  cached: boolean;
  status: number;
  durationMs: number;
}

export interface QlooClientOptions {
  baseUrl?: string;
  apiKey?: string;
  mock?: boolean;
  fetch?: typeof fetch;
  cache?: QlooCache | false;
  budget?: CallBudget;
  timeoutMs?: number;
  /** Retries for 429/5xx, default 1. */
  retries?: number;
  onCall?: (info: QlooCallInfo) => void;
}

export interface SearchInput {
  query: string;
  types?: QlooEntityType[];
  lat?: number;
  lon?: number;
  /** Miles (the /search unit), max 100. */
  radiusMiles?: number;
  take?: number;
  page?: number;
  sortBy?: "match" | "distance" | "popularity";
  minRating?: number;
}

export interface PlaceInsightsInput {
  signalEntityIds: string[];
  lat?: number;
  lon?: number;
  /** Metres. */
  radiusM?: number;
  /** Natural-language locality, used when no coordinates. */
  locationQuery?: string;
  priceLevelMin?: number;
  priceLevelMax?: number;
  minBusinessRating?: number;
  excludeEntityIds?: string[];
  /** Score only these entities (filter.results.entities). */
  onlyEntityIds?: string[];
  tags?: string[];
  tagsOperator?: "union" | "intersection";
  take?: number;
  explain?: boolean;
}

export interface TagsInput {
  query?: string;
  tagTypes?: string[];
  parentTypes?: QlooEntityType[];
  take?: number;
}

export interface QlooConfig {
  baseUrl: string;
  apiKey?: string;
  mock: boolean;
}

/**
 * Mock when QLOO_MOCK=1, or when no key is set outside production.
 * In production without a key and without QLOO_MOCK, requests fail closed.
 */
export function qlooConfigFromEnv(env: Record<string, string | undefined> = process.env): QlooConfig {
  const apiKey = env.QLOO_API_KEY?.trim() || undefined;
  const mock = env.QLOO_MOCK === "1" || (!apiKey && env.NODE_ENV !== "production");
  return { baseUrl: (env.QLOO_BASE_URL?.trim() || DEFAULT_QLOO_BASE_URL).replace(/\/+$/, ""), apiKey, mock };
}

const sharedCache = new MemoryCache({ maxEntries: 5000, ttlMs: 24 * 3600_000 });

export class QlooClient {
  readonly mock: boolean;
  readonly budget?: CallBudget;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: QlooCache | false;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly onCall?: (info: QlooCallInfo) => void;
  /** Network calls made by this client instance (cache misses). */
  calls = 0;

  constructor(opts: QlooClientOptions = {}) {
    const env = qlooConfigFromEnv();
    this.mock = opts.mock ?? env.mock;
    this.baseUrl = (opts.baseUrl ?? env.baseUrl).replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? env.apiKey;
    this.fetchImpl = opts.fetch ?? (this.mock ? createMockFetch() : fetch);
    this.cache = opts.cache === undefined ? sharedCache : opts.cache;
    this.budget = opts.budget;
    this.timeoutMs = opts.timeoutMs ?? 12_000;
    this.retries = opts.retries ?? 1;
    this.onCall = opts.onCall;
  }

  private async get(path: string, params: Params): Promise<unknown> {
    const qs = toQueryString(params);
    const cacheKey = `${this.mock ? "mock" : "live"}:${path}?${qs}`;
    if (this.cache) {
      const hit = await this.cache.get(cacheKey);
      if (hit !== undefined) {
        this.onCall?.({ path, cached: true, status: 200, durationMs: 0 });
        return hit;
      }
    }
    if (!this.mock && !this.apiKey) {
      throw new QlooHttpError(401, path, "QLOO_API_KEY is not configured");
    }
    this.budget?.consume();
    this.calls++;
    const url = `${this.baseUrl}${path}?${qs}`;
    let attempt = 0;
    for (;;) {
      const started = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: "GET",
          headers: { accept: "application/json", ...(this.apiKey && !this.mock ? { "X-Api-Key": this.apiKey } : {}) },
          signal: ctrl.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (attempt < this.retries) {
          attempt++;
          continue;
        }
        const reason = err instanceof Error && err.name === "AbortError" ? "timeout" : "network error";
        throw new QlooHttpError(0, path, reason);
      }
      clearTimeout(timer);
      this.onCall?.({ path, cached: false, status: res.status, durationMs: Date.now() - started });
      if (res.ok) {
        const body: unknown = await res.json();
        if (this.cache) await this.cache.set(cacheKey, body);
        return body;
      }
      const err = new QlooHttpError(res.status, path, await safeDetail(res));
      if (err.retryable && attempt < this.retries) {
        attempt++;
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
      throw err;
    }
  }

  /** GET /search. */
  async search(input: SearchInput): Promise<QlooEntity[]> {
    const params: Params = {
      query: input.query,
      types: input.types?.length ? input.types.map(searchTypeUrn) : undefined,
      "filter.location": input.lat !== undefined && input.lon !== undefined ? `${input.lat},${input.lon}` : undefined,
      "filter.radius": input.lat !== undefined ? (input.radiusMiles ?? 10) : undefined,
      "filter.rating": input.minRating,
      take: input.take ?? 5,
      page: input.page,
      sort_by: input.sortBy,
    };
    validateSearchParams(params);
    const raw = RawSearchResponseSchema.parse(await this.get("/search", params));
    const fallback = input.types?.[0] ?? "place";
    return raw.results.map((e) => normalizeEntity(e, fallback)).filter((e): e is QlooEntity => e !== null);
  }

  /** GET /v2/insights with already-built params (validated here). */
  async insights(type: QlooEntityType, params: Params): Promise<QlooEntity[]> {
    const full: Params = { ...params, "filter.type": entityUrn(type) };
    validateInsightsParams(type, full);
    const raw = RawInsightsResponseSchema.parse(await this.get("/v2/insights", full));
    return raw.results.entities.map((e) => normalizeEntity(e, type)).filter((e): e is QlooEntity => e !== null);
  }

  /** Taste-equivalent places, optionally cheaper and nearby. */
  placeInsights(input: PlaceInsightsInput): Promise<QlooEntity[]> {
    return this.insights("place", buildPlaceParams(input));
  }

  /** GET /v2/tags. */
  async tags(input: TagsInput): Promise<QlooTagOut[]> {
    const params: Params = {
      "filter.query": input.query,
      "filter.tag.types": input.tagTypes,
      "filter.parents.types": input.parentTypes?.map(entityUrn),
      take: input.take ?? 10,
    };
    validateTagsParams(params);
    const raw = RawTagsResponseSchema.parse(await this.get("/v2/tags", params));
    return raw.results.tags.map(normalizeTag).filter((t): t is QlooTagOut => t !== null);
  }
}

export function buildPlaceParams(input: PlaceInsightsInput): Params {
  const hasPoint = input.lat !== undefined && input.lon !== undefined;
  return {
    "signal.interests.entities": input.signalEntityIds.length ? input.signalEntityIds : undefined,
    "filter.location": hasPoint ? wktPoint(input.lat!, input.lon!) : undefined,
    "filter.location.query": !hasPoint ? input.locationQuery : undefined,
    "filter.location.radius": hasPoint || input.locationQuery ? input.radiusM : undefined,
    "filter.price_level.min": input.priceLevelMin,
    "filter.price_level.max": input.priceLevelMax,
    "filter.properties.business_rating.min": input.minBusinessRating,
    "filter.exclude.entities": input.excludeEntityIds?.length ? input.excludeEntityIds : undefined,
    "filter.results.entities": input.onlyEntityIds?.length ? input.onlyEntityIds : undefined,
    "filter.tags": input.tags?.length ? input.tags : undefined,
    "operator.filter.tags": input.tags?.length && input.tagsOperator ? input.tagsOperator : undefined,
    "feature.explainability": input.explain ? true : undefined,
    take: input.take ?? 10,
  };
}

async function safeDetail(res: Response): Promise<string | undefined> {
  try {
    const text = (await res.text()).slice(0, 200);
    return text.replace(/[\r\n]+/g, " ");
  } catch {
    return undefined;
  }
}
