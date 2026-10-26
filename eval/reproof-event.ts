/**
 * The pure part of eval/reproof.ts: one recorded event with its derived
 * fields recomputed from what the recording kept: evidence chips and the
 * fingerprint's place tags (taste tags only), its headline, the proof and
 * the hero bridge.
 */
import type { AgentEvent, ProofPick, ProofSide, QlooTag, SwapEvidence, TasteFingerprint } from "../lib/contract";
import { headline, topStyleTags } from "../lib/agent/fingerprint";
import { evidenceTags, rankTasteTags, tasteRank } from "../lib/agent/taste-tags";
import { claimCheck, proofSide } from "../lib/agent/proof";
import { keptCounts } from "../lib/agent/proof-rows";
import { heroBridge } from "../lib/agent/tools";

const isEvidence = (o: Record<string, unknown>): o is SwapEvidence => typeof o.entityId === "string" && Array.isArray(o.tags);
const isFingerprint = (o: Record<string, unknown>): o is TasteFingerprint => Array.isArray(o.topTags) && Array.isArray(o.affinities) && typeof o.headline === "string";
const isProofPick = (o: Record<string, unknown>): o is ProofPick => typeof o.pickName === "string" && Array.isArray(o.sharedTagIds);
const taste = (ids: string[]) => ids.filter((id) => tasteRank(id) !== undefined);
const byId = (tags: QlooTag[]) => tags.filter((t, i) => tags.findIndex((x) => x.id === t.id) === i);

/** Re-filters every evidence and fingerprint inside an event (a copy). */
function retag<T>(v: T): T {
  if (Array.isArray(v)) return v.map(retag) as T;
  if (!v || typeof v !== "object") return v;
  const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, retag(x)])) as Record<string, unknown>;
  // since 1.5 a shared tag is a taste tag; older recordings kept every overlap
  if (isEvidence(o)) {
    if (o.sharedTagIds) o.sharedTagIds = taste(o.sharedTagIds);
    o.tags = evidenceTags(byId([...(o.sharedTags ?? []), ...o.tags]), o.sharedTagIds);
  }
  if (isProofPick(o)) o.sharedTagIds = taste(o.sharedTagIds);
  if (isFingerprint(o)) {
    o.topTags = o.sources ? topStyleTags(o.sources.map((x) => ({ tags: x.tasteTags })), 5) : rankTasteTags(o.topTags);
    o.headline = headline(o.topTags, o.affinities);
  }
  return o as T;
}

/** A recorded pick with its neighbourhood claim (re)checked, in the recording's key order. */
function withClaim(p: ProofPick, claimedHood: string | undefined): ProofPick {
  const { claimedHood: _c, inClaimedHood: _i, monthlySavings, ...rest } = p;
  const inHood = claimCheck(claimedHood, p.entity, p.exists);
  return { ...rest, ...(claimedHood ? { claimedHood } : {}), ...(inHood !== undefined ? { inClaimedHood: inHood } : {}), ...(monthlySavings !== undefined ? { monthlySavings } : {}) };
}

export function reproofEvent(recorded: AgentEvent): AgentEvent {
  const e = retag(recorded);
  if (e.type === "plan_ready") {
    const plan = { ...e.plan };
    if (plan.proof) plan.proof = proofSide(plan.proof.perMerchant, plan.proof.of, plan.proof.qlooMock, keptCounts(plan.unswapped));
    const hero = heroBridge(plan.swaps);
    if (hero) plan.heroBridge = hero;
    else delete plan.heroBridge;
    return { ...e, plan };
  }
  if (e.type === "baseline_ready" && e.proof) {
    // 1.6: the neighbourhood each pick was claimed in comes from its suggestion; distances stay as recorded
    const claimed = new Map(e.suggestions.map((s) => [s.merchantKey, s.suggestedNeighborhood]));
    const side = (p: ProofSide) =>
      proofSide(
        p.perMerchant.map((x) => withClaim(x, x.claimedHood ?? claimed.get(x.merchantKey))),
        p.of,
        p.qlooMock,
        undefined,
        { nearestBranch: p.nearestBranch },
      );
    return { ...e, proof: side(e.proof), ...(e.proofRuns ? { proofRuns: e.proofRuns.map(side) } : {}) };
  }
  return e;
}
