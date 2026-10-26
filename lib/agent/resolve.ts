/** Picks a Qloo entity for a merchant from /search results. */
import type { MerchantResolution, QlooEntityRef } from "../contract";
import type { QlooEntity } from "../qloo/types";
import { haversineM } from "../qloo/geo";
import type { NormalizedMerchant } from "./normalize";
import { nameSimilarity, normName } from "./text";

export function toRef(e: QlooEntity): QlooEntityRef {
  return {
    id: e.id,
    name: e.name,
    type: e.type,
    address: e.address,
    lat: e.lat,
    lon: e.lon,
    priceLevel: e.priceLevel,
    popularity: e.popularity,
    businessRating: e.businessRating,
  };
}

export interface ResolveOutcome {
  resolution: MerchantResolution;
  entity?: QlooEntity;
  options: QlooEntity[];
}

export function pickResolution(
  n: NormalizedMerchant,
  results: QlooEntity[],
  near?: { lat: number; lon: number },
): ResolveOutcome {
  const base = {
    merchantKey: n.key,
    rawMerchant: n.rawMerchant,
    normalizedName: n.name,
    category: n.category,
    entityType: n.entityType,
    source: "qloo_search" as const,
  };
  const scored = results.map((e) => ({
    e,
    sim: nameSimilarity(n.name, e.name),
    d: near && e.lat !== undefined && e.lon !== undefined ? haversineM(near.lat, near.lon, e.lat, e.lon) : Infinity,
  }));
  const byName = (min: number) => {
    const m = new Map<string, (typeof scored)[number]>();
    for (const s of scored.filter((x) => x.sim >= min)) {
      const k = normName(s.e.name);
      const cur = m.get(k);
      if (!cur || s.d < cur.d || (s.d === cur.d && s.sim > cur.sim)) m.set(k, s);
    }
    return [...m.values()].sort((a, b) => b.sim - a.sim || a.d - b.d);
  };
  const strong = byName(0.8);
  const medium = byName(0.5);
  const pick = (s: (typeof scored)[number], confidence: number): ResolveOutcome => ({
    resolution: { ...base, status: "resolved", entity: toRef(s.e), confidence },
    entity: s.e,
    options: [s.e],
  });
  const exact = (s: (typeof scored)[number]) => normName(s.e.name) === normName(n.name);
  const exacts = strong.filter(exact);
  if (strong.length === 1 || exacts.length === 1) {
    const s = exacts[0] ?? strong[0];
    return pick(s, Math.min(1, 0.7 + s.sim * 0.3));
  }
  const amb = strong.length > 1 ? strong : medium.length > 1 ? medium : [];
  if (amb.length > 1) {
    const opts = amb.slice(0, 4).map((x) => x.e);
    return {
      resolution: { ...base, status: "ambiguous", candidates: opts.map(toRef), confidence: 0.4 },
      options: opts,
    };
  }
  if (medium.length === 1) return pick(medium[0], 0.6);
  return { resolution: { ...base, status: "unresolved", confidence: 0 }, options: [] };
}
