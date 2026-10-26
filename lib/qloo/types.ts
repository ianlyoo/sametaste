/**
 * Qloo API types.
 *
 * Sources (seen 2026-10-22):
 * - Entity Type Parameter Guide, updated 2026-07-08:
 *   https://docs.qloo.com/reference/available-parameters-by-entity-type
 * - Insights API deep dive, updated 2026-07-08:
 *   https://docs.qloo.com/reference/insights-api-deep-dive
 * - GET /search, updated 2026-07-20: https://docs.qloo.com/reference/get-search
 * - Recipe "restaurants near a coordinate point", updated 2026-05-14
 *   (shows query.affinity and query.distance in metres).
 *
 * The docs publish only a generic envelope for entities, so the raw schemas
 * below are lenient (everything optional, unknown keys kept). Place property
 * names (price_level, business_rating, address, geocode) are taken from the
 * filter names and must be checked against the first live responses.
 */
import { z } from "zod";
import type { QlooEntityType } from "../contract";

export type { QlooEntityType };

/** filter.type URN for /v2/insights. */
export function entityUrn(type: QlooEntityType): string {
  return `urn:entity:${type}`;
}

/**
 * /search spells the video game type without underscore
 * (`urn:entity:videogame`), per the /search reference.
 */
export function searchTypeUrn(type: QlooEntityType): string {
  return type === "video_game" ? "urn:entity:videogame" : entityUrn(type);
}

export function typeFromUrn(urn: string | undefined): QlooEntityType | undefined {
  if (!urn) return undefined;
  const t = urn.replace(/^urn:entity:/, "");
  if (t === "videogame") return "video_game";
  const known: QlooEntityType[] = [
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
  ];
  return (known as string[]).includes(t) ? (t as QlooEntityType) : undefined;
}

// ---------------------------------------------------------------------------
// Raw response schemas (lenient)

const num = z.coerce.number().optional().catch(undefined);

export const RawTagSchema = z
  .object({
    id: z.string().optional(),
    tag_id: z.string().optional(),
    name: z.string().optional(),
    type: z.string().optional(),
    subtype: z.string().optional(),
    value: z.string().optional(),
  })
  .loose();

export const RawEntitySchema = z
  .object({
    name: z.string().optional(),
    entity_id: z.string().optional(),
    id: z.string().optional(),
    type: z.string().optional(),
    subtype: z.string().optional(),
    types: z.array(z.string()).optional(),
    popularity: num,
    location: z
      .object({ lat: num, lon: num, lng: num, geohash: z.string().optional() })
      .loose()
      .optional(),
    properties: z
      .object({
        address: z.string().optional(),
        price_level: num,
        business_rating: num,
        geocode: z
          .object({
            name: z.string().optional(),
            admin1_region: z.string().optional(),
            admin2_region: z.string().optional(),
            country_code: z.string().optional(),
            metro: z.string().optional(),
          })
          .loose()
          .optional(),
      })
      .loose()
      .optional(),
    tags: z.array(RawTagSchema).optional().catch(undefined),
    query: z
      .object({
        affinity: num,
        distance: num,
        explainability: z.unknown().optional(),
      })
      .loose()
      .optional(),
    disambiguation: z.string().optional(),
  })
  .loose();
export type RawEntity = z.infer<typeof RawEntitySchema>;

/** GET /search: `{ success, duration, results: Entity[] }`. */
export const RawSearchResponseSchema = z
  .object({
    success: z.boolean().optional(),
    duration: num,
    results: z.array(RawEntitySchema).default([]),
  })
  .loose();

/** GET /v2/insights: `{ success, results: { entities: [], duration } }`. */
export const RawInsightsResponseSchema = z
  .object({
    success: z.boolean().optional(),
    results: z
      .object({
        entities: z.array(RawEntitySchema).default([]),
        tags: z.array(RawTagSchema).optional(),
        duration: num,
      })
      .loose()
      .default({ entities: [] }),
    query: z.unknown().optional(),
  })
  .loose();

/** GET /v2/tags: `{ success, results: { tags: [] } }` (shape unverified). */
export const RawTagsResponseSchema = z
  .object({
    success: z.boolean().optional(),
    results: z
      .union([
        z.object({ tags: z.array(RawTagSchema).default([]) }).loose(),
        z.array(RawTagSchema).transform((tags) => ({ tags })),
      ])
      .default({ tags: [] }),
  })
  .loose();

// ---------------------------------------------------------------------------
// Normalised shapes the rest of the app uses

export interface QlooTagOut {
  id: string;
  name: string;
  type?: string;
}

export interface QlooEntity {
  id: string;
  name: string;
  type: QlooEntityType;
  address?: string;
  lat?: number;
  lon?: number;
  priceLevel?: 1 | 2 | 3 | 4;
  popularity?: number;
  businessRating?: number;
  tags: QlooTagOut[];
  /** query.affinity, 0..1 (insights only). */
  affinity?: number;
  /** query.distance in metres (insights with a location filter). */
  distanceM?: number;
  disambiguation?: string;
  city?: string;
}

function clampPrice(v: number | undefined): 1 | 2 | 3 | 4 | undefined {
  if (v === undefined || !Number.isFinite(v)) return undefined;
  const r = Math.round(v);
  return r >= 1 && r <= 4 ? (r as 1 | 2 | 3 | 4) : undefined;
}

export function normalizeTag(t: z.infer<typeof RawTagSchema>): QlooTagOut | null {
  const id = t.id ?? t.tag_id;
  if (!id) return null;
  return { id, name: t.name ?? t.value ?? id.split(":").pop() ?? id, type: t.type ?? t.subtype };
}

export function normalizeEntity(
  e: RawEntity,
  fallbackType: QlooEntityType,
): QlooEntity | null {
  const id = e.entity_id ?? e.id;
  if (!id || !e.name) return null;
  const type =
    typeFromUrn(e.subtype) ?? typeFromUrn(e.types?.[0]) ?? typeFromUrn(e.type) ?? fallbackType;
  const p = e.properties;
  return {
    id,
    name: e.name,
    type,
    address: p?.address,
    lat: e.location?.lat,
    lon: e.location?.lon ?? e.location?.lng,
    priceLevel: clampPrice(p?.price_level),
    popularity: e.popularity,
    businessRating: p?.business_rating,
    tags: (e.tags ?? []).map(normalizeTag).filter((t): t is QlooTagOut => t !== null),
    affinity: e.query?.affinity,
    distanceM: e.query?.distance,
    disambiguation: e.disambiguation,
    city: p?.geocode?.name,
  };
}
