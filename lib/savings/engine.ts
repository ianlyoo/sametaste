/**
 * Deterministic savings engine: price tier -> estimated ticket,
 * frequency x delta, user-editable assumptions. No LLM involved.
 */
import type { Category, PriceLevel, SavingsAssumptions, SavingsEstimate } from "../contract";
import { DEFAULT_SWAP_SHARE, ticketTable } from "./tickets";

export interface SwapSavingsInput {
  category: Category;
  /** Transactions at the merchant in the window. */
  count: number;
  totalSpend: number;
  /** Window length in days, default 30. */
  windowDays?: number;
  fromPriceLevel?: PriceLevel;
  toPriceLevel?: PriceLevel;
  currency?: string;
  assumptions?: SavingsAssumptions;
  /** Distance to the swap, km; a farther twin gets a smaller share of visits. */
  distanceKm?: number;
  /** Qloo affinity of the swap 0..1; a stronger match gets a larger share. */
  affinity?: number;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

export function visitsPerMonth(count: number, windowDays = 30): number {
  return (count * 30) / Math.max(1, windowDays);
}

/**
 * Our assumption (not Qloo data) for how many visits move to a twin: the
 * default share, less for a farther place, a little more or less with the
 * Qloo match. So two twins at the same price tier still price differently.
 */
export function swapShareFor(distanceKm?: number, affinity?: number): number {
  const dist = distanceKm === undefined || distanceKm <= 1 ? 1 : Math.max(0.6, 1 - 0.08 * (distanceKm - 1));
  const aff = affinity === undefined ? 1 : 0.85 + 0.2 * clamp01(affinity);
  return Math.round(Math.min(0.85, Math.max(0.35, DEFAULT_SWAP_SHARE * dist * aff)) * 1000) / 1000;
}

export function estimateSwapSavings(input: SwapSavingsInput): SavingsEstimate {
  const currency = input.currency ?? "USD";
  const userShare = input.assumptions?.swapShare;
  const perTwin = userShare === undefined && (input.distanceKm !== undefined || input.affinity !== undefined);
  const share = clamp01(userShare ?? (perTwin ? swapShareFor(input.distanceKm, input.affinity) : DEFAULT_SWAP_SHARE));
  const table = ticketTable(input.category, input.assumptions?.ticketByPriceLevel);
  const count = Math.max(1, input.count);
  const visits = visitsPerMonth(count, input.windowDays);
  const ticketBefore = Math.max(0, input.totalSpend) / count;
  const { fromPriceLevel: from, toPriceLevel: to } = input;
  const notes: string[] = [];

  let ticketAfter: number;
  let method: SavingsEstimate["method"];
  let confidence: SavingsEstimate["confidence"];

  if (from && to) {
    // Scale the user's own ticket by the tier ratio, so a big spender at a
    // $$$ place still spends more than average at the $$ swap.
    const ratio = table[from] > 0 ? table[to] / table[from] : 1;
    ticketAfter = ticketBefore * ratio;
    method = "observed_ticket";
    confidence = count >= 3 ? "high" : "medium";
    notes.push(
      `Your average ticket ${fmt(ticketBefore, currency)} scaled by the price-tier ratio ${"$".repeat(to)}/${"$".repeat(from)} (${fmt(table[to], currency)} vs ${fmt(table[from], currency)} typical).`,
    );
  } else if (to) {
    ticketAfter = Math.min(table[to], ticketBefore);
    method = "price_tier";
    confidence = "medium";
    notes.push(`The original price tier is unknown; the swap's ticket uses the typical ${"$".repeat(to)} ${input.category} ticket (${fmt(table[to], currency)}).`);
    if (table[to] >= ticketBefore) {
      confidence = "low";
      notes.push("The swap's typical ticket is not below what you spend now, so no saving is assumed.");
    }
  } else {
    ticketAfter = ticketBefore;
    method = "price_tier";
    confidence = "low";
    notes.push("Qloo has no price level for the swap, so no saving is assumed.");
  }

  notes.push(
    `${round1(visits)} visits a month; ${Math.round(share * 100)}% of them move to the swap` +
      (perTwin
        ? ` (our assumption: ${Math.round(DEFAULT_SWAP_SHARE * 100)}%, adjusted for ${[input.distanceKm !== undefined && `${input.distanceKm.toFixed(1)} km`, input.affinity !== undefined && `a ${input.affinity.toFixed(2)} Qloo match`].filter(Boolean).join(" and ")}).`
        : "."),
  );
  if (count < 3) notes.push("Few transactions observed, so frequency is uncertain.");

  const monthlyBefore = visits * ticketBefore;
  const monthlyAfter = visits * (share * ticketAfter + (1 - share) * ticketBefore);
  const monthlySavings = monthlyBefore - monthlyAfter;
  return {
    currency,
    visitsPerMonth: round2(visits),
    ticketBefore: round2(ticketBefore),
    ticketAfter: round2(ticketAfter),
    swapShare: share,
    monthlyBefore: round2(monthlyBefore),
    monthlyAfter: round2(monthlyAfter),
    monthlySavings: round2(monthlySavings),
    annualSavings: round2(monthlySavings * 12),
    method,
    confidence,
    notes,
  };
}

/** Re-run an estimate with edited assumptions (UI "what if" sliders). */
export function withAssumptions(input: SwapSavingsInput, assumptions: SavingsAssumptions): SavingsEstimate {
  return estimateSwapSavings({ ...input, assumptions: { ...input.assumptions, ...assumptions } });
}

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n));
}
function round1(n: number) {
  return Math.round(n * 10) / 10;
}
function fmt(n: number, currency: string) {
  return currency === "USD" ? `$${n.toFixed(2)}` : `${n.toFixed(2)} ${currency}`;
}
