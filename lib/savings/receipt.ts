/**
 * Taste Receipt: the statement re-printed line by line,
 * original merchant -> taste twin -> what you keep -> monthly saving.
 */
import type { Category, Swap, TasteReceipt, TasteReceiptLine } from "../contract";
import { round2 } from "./engine";

export interface ReceiptMerchant {
  key: string;
  rawMerchant: string;
  name: string;
  category: Category;
  visitsPerMonth: number;
  monthlySpend: number;
  resolved: boolean;
  /** Why it has no swap, from the plan's `unswapped`. */
  keptReason?: string;
  /** Other request keys merged into this line. */
  mergedKeys?: string[];
}

export function buildReceipt(input: { merchants: ReceiptMerchant[]; swaps: Swap[]; currency: string }): TasteReceipt {
  const active = new Map(
    input.swaps.filter((s) => s.status !== "rejected" && s.savings.monthlySavings > 0).map((s) => [s.merchantKey, s]),
  );
  const rejected = new Set(input.swaps.filter((s) => s.status === "rejected").map((s) => s.merchantKey));
  const lines: TasteReceiptLine[] = [...input.merchants]
    .sort((a, b) => b.monthlySpend - a.monthlySpend)
    .map((m) => {
      const s = active.get(m.key);
      const base = {
        merchantKey: m.key,
        rawMerchant: m.rawMerchant,
        name: m.name,
        category: m.category,
        visitsPerMonth: round2(m.visitsPerMonth),
        monthlySpend: round2(m.monthlySpend),
        ...(m.mergedKeys?.length ? { mergedKeys: m.mergedKeys } : {}),
      };
      if (s) {
        const cd = s.to.evidence.crossDomain?.[0];
        return {
          ...base,
          status: "swapped" as const,
          swapId: s.id,
          twin: {
            name: s.to.entity.name,
            entityId: s.to.entity.id,
            priceLevel: s.to.evidence.priceLevel,
            fromPriceLevel: s.to.evidence.fromPriceLevel,
            distanceKm: s.to.evidence.distanceKm,
            affinity: s.to.evidence.affinity,
          },
          keepReason: s.keepReason ?? "Same taste profile",
          crossDomainNote:
            s.crossDomainNote ?? (cd ? `Picked for people whose taste also runs to ${cd.entity.name} (${cd.domain.replace("_", " ")})` : undefined),
          monthlySaving: s.savings.monthlySavings,
        };
      }
      return {
        ...base,
        status: m.resolved ? ("kept" as const) : ("unresolved" as const),
        keepReason: !m.resolved
          ? "Not in Qloo's taste graph yet"
          : rejected.has(m.key)
            ? "You chose to keep it"
            : m.keptReason
              ? /analysed/i.test(m.keptReason)
                ? "Not checked in this run, so it stays for now"
                : /waiting|several/i.test(m.keptReason)
                  ? "Waiting for your answer on which place this is"
                  : `${m.keptReason}, so it stays`
              : "Nothing one price level down with the same taste nearby, so it stays",
        monthlySaving: 0,
      };
    });
  const monthlyBefore = lines.reduce((a, l) => a + l.monthlySpend, 0);
  const monthlySavings = lines.reduce((a, l) => a + l.monthlySaving, 0);
  const affs = lines.map((l) => l.twin?.affinity).filter((x): x is number => x !== undefined);
  return {
    lines,
    currency: input.currency,
    monthlyBefore: round2(monthlyBefore),
    monthlyAfter: round2(monthlyBefore - monthlySavings),
    monthlySavings: round2(monthlySavings),
    annualSavings: round2(monthlySavings * 12),
    tasteKept: affs.length ? Math.round((affs.reduce((a, b) => a + b, 0) / affs.length) * 1000) / 1000 : undefined,
  };
}
