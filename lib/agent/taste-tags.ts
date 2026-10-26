/**
 * Which Qloo place tags read as taste. Qloo tags are namespaced
 * (urn:tag:<kind>:<ns>:<value>); most kinds are facts about the venue
 * (payments, credit_card, amenity, service_type, parking, planning,
 * accessibility, setting, age_range, resy keywords...), not taste. Only the
 * kinds below count, best first, and generic values (restaurant, bar,
 * urban, casual...) never do.
 */
import type { QlooTag } from "../contract";

const TASTE_KINDS: Record<string, number> = {
  style: 0, // the mock world's taste tags
  cuisine: 0,
  genre: 0,
  culinary_style: 0,
  interests: 0,
  ambience: 1,
  decor: 1,
  offerings: 2, // "small plates", "late-night food"; not the drinks list
  specialty_dish: 3,
  menu_highlight: 3,
};

const GENERIC = new Set([
  "restaurant", "restaurants", "cafe", "bar", "bars", "store", "shop", "place", "food", "dining", "urban", "casual", "city_center", "local",
  "alcohol", "beer", "wine", "coffee", "cocktails", "hard_liquor", "ok_to_order_just_drinks",
]);

/** 0 (cuisine, genre, style) .. 3 (a dish); undefined when the tag is not taste. */
export function tasteRank(id: string): number | undefined {
  const [urn, tag, kind, ns, ...rest] = id.split(":");
  if (urn !== "urn" || tag !== "tag" || !kind) return undefined;
  const rank = TASTE_KINDS[kind];
  if (rank === undefined) return undefined;
  // "urn:tag:genre:place:restaurant" is a bare category; "...:restaurant:italian" is taste
  const values = kind === "genre" && ns === "place" ? rest.slice(1) : rest;
  const value = values.at(-1);
  // dietary facts ("vegan_options", "gluten_free_options") are menu facts, not taste
  if (!value || GENERIC.has(value) || value.endsWith("_options")) return undefined;
  return rank;
}

export const isTasteTag = (t: { id: string }) => tasteRank(t.id) !== undefined;

/** Taste tags only, best kind first, one per name ("Italian" from cuisine and genre once); stable otherwise. */
export function rankTasteTags<T extends QlooTag>(tags: T[], first?: Set<string>): T[] {
  const seen = new Set<string>();
  return tags
    .map((t, i) => ({ t, i, r: tasteRank(t.id) }))
    .filter((x): x is { t: T; i: number; r: number } => x.r !== undefined)
    .sort((a, b) => Number(first ? !first.has(a.t.id) : 0) - Number(first ? !first.has(b.t.id) : 0) || a.r - b.r || a.i - b.i)
    .map((x) => x.t)
    .filter((t) => {
      const k = t.name.trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/** The evidence chips for a twin: shared taste tags first, then its other taste tags; at most `n`. */
export function evidenceTags<T extends QlooTag>(tags: T[], sharedTagIds: string[] | undefined, n = 6): T[] {
  return rankTasteTags(tags, new Set(sharedTagIds ?? [])).slice(0, n);
}
