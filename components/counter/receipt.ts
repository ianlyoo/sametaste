/**
 * The text alternative's swap lines, with the paper's figures: the merchant's
 * visits and spend (merged descriptors included, contract 1.2 `mergedKeys`),
 * the twin at its own monthly price, and the monthly saving.
 */
import { heroBridge } from "@/components/scene/lines";
import { proofRows } from "@/lib/agent/proof-rows";
import type { FlowState } from "@/lib/client/flow";
import type { ProofSide, Swap } from "@/lib/contract";
import { bridgeLine, twinMonthly } from "@/lib/client/view";

export interface SwapLine {
  swap: Swap;
  name: string;
  count: number;
  spend: number;
  twinMonthly: number;
  saving: number;
  /** The plan's hero bridge for this swap (contract 1.3), else the short bridge. */
  bridge?: string;
  hero: boolean;
  /** Still counting: not rejected. */
  live: boolean;
  busy: boolean;
}

export function swapLines(s: FlowState): SwapLine[] {
  const hb = heroBridge(s);
  return s.swaps.map((sw) => {
    const hero = hb?.key === sw.merchantKey;
    const keys = [sw.merchantKey, ...(sw.mergedKeys ?? [])];
    const ms = s.merchants.filter((m) => keys.includes(m.key));
    const count = ms.length ? ms.reduce((a, m) => a + m.count, 0) : sw.from.visitsPerMonth;
    const spend = ms.length ? Math.round(ms.reduce((a, m) => a + m.totalSpend, 0) * 100) / 100 : sw.from.monthlySpend;
    return {
      swap: sw,
      name: s.resolutions[sw.merchantKey]?.normalizedName ?? sw.from.name,
      count,
      spend,
      twinMonthly: twinMonthly(sw),
      bridge: (hero && hb?.text) || bridgeLine(sw),
      hero,
      saving: sw.savings.monthlySavings,
      live: sw.status !== "rejected",
      busy: s.replanning.includes(sw.merchantKey),
    };
  });
}

export interface ProofTextRow {
  label: string;
  ours: string;
  theirs: string;
  /** The side the row argues against, red as on the paper. */
  worse?: "ours" | "theirs";
}

/**
 * The measured proof as the paper prints it (lib/agent/proof-rows, contract
 * 1.6): the same rows, labels and order, each side over its own picks, the
 * model's side as a range over its runs. Empty until a side is in.
 */
export function proofText(ours: ProofSide | undefined, theirs: ProofSide | undefined, theirsRuns?: ProofSide[]): ProofTextRow[] {
  const mine = ours ?? theirs;
  if (!mine) return [];
  const both = !!(ours && theirs);
  return proofRows(ours ?? mine, theirs ?? mine, both ? theirsRuns : undefined).map((r) => {
    const note = both && r.note ? ` (${r.note})` : "";
    return {
      label: r.label,
      ours: ours ? (r.ours === "-" ? "none" : r.ours) + (r.key === "month" || r.favours === "tie" ? note : "") : "not run yet",
      theirs: theirs ? (r.theirs === "-" ? "none" : r.theirs) + (r.favours === "tie" ? note : "") : "not run yet",
      worse: both ? (r.favours === "ours" ? "theirs" : r.favours === "theirs" ? "ours" : undefined) : undefined,
    };
  });
}
