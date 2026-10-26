/** Scores Qloo insights results as swap candidates. */
import type { CrossDomainAffinity, SwapCandidate } from "../contract";
import type { QlooEntity } from "../qloo/types";
import { toRef } from "./resolve";
import { evidenceTags, isTasteTag, rankTasteTags } from "./taste-tags";

export interface ScoreContext {
  merchantKey: string;
  from: QlooEntity;
  radiusM: number;
  query: string;
  crossDomain?: CrossDomainAffinity[];
}

export function scoreCandidate(c: QlooEntity, ctx: ScoreContext, candidateId: string): SwapCandidate {
  const aff = c.affinity ?? 0.5;
  const fromLvl = ctx.from.priceLevel;
  const toLvl = c.priceLevel;
  const priceDrop = fromLvl && toLvl ? Math.min(1, Math.max(0, (fromLvl - toLvl) / 2)) : 0;
  const distKm = c.distanceM !== undefined ? c.distanceM / 1000 : undefined;
  const dist = distKm !== undefined ? Math.max(0, 1 - (distKm * 1000) / Math.max(1, ctx.radiusM)) : 0.5;
  const rating = (c.businessRating ?? 4) / 5;
  const score = 0.55 * aff + 0.2 * priceDrop + 0.15 * dist + 0.1 * rating;

  // only taste tags count as shared (a twin never qualifies on "credit cards" or "restaurant")
  const fromTags = new Set(ctx.from.tags.map((t) => t.id));
  const shared = rankTasteTags(c.tags.filter((t) => fromTags.has(t.id) && isTasteTag(t)));
  const reasons: string[] = [];
  if (shared.length) reasons.push(`Shared taste: ${shared.slice(0, 6).map((t) => t.name).join(", ")}`);
  if (fromLvl && toLvl) reasons.push(`${"$".repeat(fromLvl)} → ${"$".repeat(toLvl)}`);
  if (distKm !== undefined) reasons.push(`${distKm.toFixed(1)} km away`);
  if (c.affinity !== undefined) reasons.push(`Qloo affinity ${c.affinity.toFixed(2)}`);
  if (c.businessRating) reasons.push(`Rated ${c.businessRating.toFixed(1)}`);

  return {
    candidateId,
    merchantKey: ctx.merchantKey,
    entity: toRef(c),
    evidence: {
      entityId: c.id,
      signalEntityId: ctx.from.id,
      affinity: c.affinity,
      popularity: c.popularity,
      priceLevel: c.priceLevel,
      fromPriceLevel: fromLvl,
      distanceKm: distKm !== undefined ? Math.round(distKm * 100) / 100 : undefined,
      businessRating: c.businessRating,
      // chips the paper prints: taste tags only (no payments, amenities or bare categories), shared ones first
      tags: evidenceTags(c.tags, shared.map((t) => t.id)),
      sharedTagIds: shared.map((t) => t.id),
      sharedTags: shared.map((t) => ({ id: t.id, name: t.name, type: t.type })),
      query: ctx.query,
      crossDomain: ctx.crossDomain?.length ? ctx.crossDomain : undefined,
    },
    score: Math.round(score * 1000) / 1000,
    reasons,
  };
}

/** Default keep line from shared tags. */
export function defaultKeepReason(c: SwapCandidate): string {
  const shared = c.evidence.tags.filter((t) => c.evidence.sharedTagIds?.includes(t.id));
  if (shared.length) return `Same ${shared.map((t) => t.name.toLowerCase()).join(", ")}`;
  if (c.evidence.affinity !== undefined) return `Qloo taste match ${Math.round(c.evidence.affinity * 100)}%`;
  return "Similar taste profile";
}
