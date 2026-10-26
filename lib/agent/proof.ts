/**
 * The measured proof (contract 1.3): our twins and the model-alone picks
 * scored with the same Qloo calls and the same savings engine, so the paper
 * can print "ours / theirs" on one scale. Nothing here is a constant; if a
 * row favours the model, it says so.
 *
 * Per pick: one insights call with the original merchant as the only signal
 * and the pick as the only result (its Qloo affinity to the original), the
 * taste tags it shares with the original, its price level, and its distance
 * from the user. Since 1.6 the model's picks are resolved to their nearest
 * branch (lib/agent/baseline.ts) and checked against the neighbourhood the
 * model named (lib/agent/hoods.ts).
 */
import type { Category, ProofPick, ProofSide } from "../contract";
import type { QlooClient } from "../qloo/client";
import { haversineM } from "../qloo/geo";
import type { QlooEntity } from "../qloo/types";
import { estimateSwapSavings, round2 } from "../savings/engine";
import { findHood, inClaimedHood } from "./hoods";
import { NEAR_KM } from "./proof-rows";
import { toRef } from "./resolve";
import { tasteRank } from "./taste-tags";

/** City-wide: the yardstick should score a pick wherever it is. */
const PROOF_RADIUS_M = 30_000;

/** The same rule as a twin's shared tags (lib/agent/candidates.ts): taste tags only. */
export function sharedTasteTagIds(from: QlooEntity, to: QlooEntity): string[] {
  const own = new Set(from.tags.map((t) => t.id).filter((id) => tasteRank(id) !== undefined));
  return [...new Set(to.tags.map((t) => t.id).filter((id) => own.has(id)))];
}

/** Qloo affinity of `pick` to `from`, with `from` as the only signal; undefined when Qloo does not score it. */
export async function affinityTo(qloo: QlooClient, near: { lat: number; lon: number }, from: QlooEntity, pick: QlooEntity): Promise<number | undefined> {
  try {
    const out =
      pick.type === "place"
        ? await qloo.placeInsights({ signalEntityIds: [from.id], lat: near.lat, lon: near.lon, radiusM: PROOF_RADIUS_M, onlyEntityIds: [pick.id], take: 1 })
        : await qloo.insights(pick.type, { "signal.interests.entities": [from.id], "filter.results.entities": [pick.id], take: 1 });
    return out.find((e) => e.id === pick.id)?.affinity;
  } catch {
    // budget or network: the pick stays unscored (tasteScored < picks)
    return undefined;
  }
}

export interface ProofLine {
  merchantKey: string;
  fromName: string;
  category: Category;
  count: number;
  totalSpend: number;
  windowDays?: number;
  currency?: string;
  /** The original merchant in Qloo. */
  from?: QlooEntity;
  pickName: string;
  /** The pick in Qloo, when found. */
  pick?: QlooEntity;
  /** Found in Qloo; undefined while it can't be checked. */
  exists?: boolean;
  /** Ours: the saving the plan shows for the swap. Theirs: computed here. */
  monthlySavings?: number;
  /** Ours: the swap's evidence (same rule as sharedTasteTagIds), for carried swaps whose original has no tags here. */
  sharedTagIds?: string[];
  /** Theirs: the neighbourhood the model named, and how far around the user its branch was looked for. */
  claimedHood?: string;
  searchedKm?: number;
}

/** In the neighbourhood the model named; a place Qloo does not have is not; undefined when it can't be told. */
export function claimCheck(claimedHood: string | undefined, pick: { address?: string; lat?: number; lon?: number } | undefined, exists: boolean | undefined): boolean | undefined {
  if (pick) return inClaimedHood(claimedHood, pick);
  return exists === false && findHood(claimedHood) ? false : undefined;
}

export async function scorePick(qloo: QlooClient, near: { lat: number; lon: number }, l: ProofLine): Promise<ProofPick> {
  const { from, pick } = l;
  const affinity = from && pick ? await affinityTo(qloo, near, from, pick) : undefined;
  const distanceKm = pick?.lat !== undefined && pick.lon !== undefined ? Math.round(haversineM(near.lat, near.lon, pick.lat, pick.lon) / 10) / 100 : undefined;
  const fromLvl = from?.priceLevel;
  const toLvl = pick?.priceLevel;
  const monthlySavings =
    l.monthlySavings ??
    (fromLvl && toLvl
      ? estimateSwapSavings({
          category: l.category,
          count: l.count,
          totalSpend: l.totalSpend,
          windowDays: l.windowDays,
          currency: l.currency,
          fromPriceLevel: fromLvl as 1 | 2 | 3 | 4,
          toPriceLevel: toLvl as 1 | 2 | 3 | 4,
          distanceKm,
          affinity,
        }).monthlySavings
      : undefined);
  return {
    merchantKey: l.merchantKey,
    fromName: l.fromName,
    pickName: l.pickName,
    entity: pick ? toRef(pick) : undefined,
    exists: l.exists,
    affinity,
    sharedTagIds: l.sharedTagIds ?? (from && pick ? sharedTasteTagIds(from, pick) : []),
    fromPriceLevel: fromLvl,
    priceLevel: toLvl,
    cheaper: fromLvl && toLvl ? toLvl < fromLvl : undefined,
    distanceKm,
    ...(l.searchedKm !== undefined ? { searchedKm: l.searchedKm } : {}),
    ...(l.claimedHood ? { claimedHood: l.claimedHood } : {}),
    ...(claimCheck(l.claimedHood, pick, l.exists) !== undefined ? { inClaimedHood: claimCheck(l.claimedHood, pick, l.exists) } : {}),
    monthlySavings,
  };
}

/**
 * Aggregates one side. `of` is the number of taste lines both sides were
 * asked about; `lines` (ours) says why the other lines have no pick;
 * `nearestBranch` (theirs) that each pick was resolved to its nearest branch.
 */
export function proofSide(
  perMerchant: ProofPick[],
  of: number,
  qlooMock: boolean,
  lines?: { kept: number; waiting: number },
  opts: { nearestBranch?: boolean } = {},
): ProofSide {
  const affs = perMerchant.map((p) => p.affinity).filter((a): a is number => a !== undefined);
  const dists = perMerchant.map((p) => p.distanceKm).filter((d): d is number => d !== undefined);
  const checked = perMerchant.every((p) => p.exists !== undefined);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const sorted = [...dists].sort((a, b) => a - b);
  const median = sorted.length ? (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2 : undefined;
  const claims = perMerchant.filter((p) => p.claimedHood !== undefined);
  return {
    of,
    picks: perMerchant.length,
    exists: checked ? perMerchant.filter((p) => p.exists).length : undefined,
    tasteLink: affs.length ? Math.round(mean(affs) * 1000) / 1000 : undefined,
    tasteScored: affs.length,
    sharedTags: perMerchant.filter((p) => p.sharedTagIds.length > 0).length,
    cheaper: perMerchant.filter((p) => p.cheaper === true).length,
    priced: perMerchant.filter((p) => p.cheaper !== undefined).length,
    ...(lines ? { kept: lines.kept, waiting: lines.waiting } : {}),
    monthlySavings: round2(perMerchant.reduce((a, p) => a + (p.monthlySavings ?? 0), 0)),
    meanDistanceKm: dists.length ? round2(mean(dists)) : undefined,
    near: perMerchant.filter((p) => p.distanceKm !== undefined && p.distanceKm <= NEAR_KM).length,
    medianDistanceKm: median === undefined ? undefined : round2(median),
    ...(claims.length
      ? { whereSaid: claims.filter((p) => p.inClaimedHood === true).length, whereChecked: claims.filter((p) => p.inClaimedHood !== undefined).length }
      : {}),
    ...(opts.nearestBranch ? { nearestBranch: true } : {}),
    qlooMock,
    perMerchant,
  };
}
