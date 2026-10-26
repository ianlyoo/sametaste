/**
 * Deterministic 30-day plan builder. The agent supplies the swaps and a
 * summary sentence; the schedule and totals are computed here.
 */
import type { Location, MerchantAggregate, Plan, PlanWeek, Swap, TasteFingerprint, TasteReceipt } from "../contract";
import { round2, visitsPerMonth } from "./engine";
import { DEFAULT_HORIZON_DAYS } from "./tickets";

export interface BuildPlanInput {
  id: string;
  createdAt?: string;
  location: Location;
  /** All analysed merchants (for the savings rate denominator). */
  merchants: MerchantAggregate[];
  swaps: Swap[];
  unswapped?: Plan["unswapped"];
  summary?: string;
  horizonDays?: number;
  currency?: string;
  receipt?: TasteReceipt;
  fingerprint?: TasteFingerprint;
}

export function monthlySpend(m: MerchantAggregate): number {
  return (m.totalSpend * 30) / Math.max(1, m.windowDays ?? 30);
}

export function buildPlan(input: BuildPlanInput): Plan {
  const horizon = input.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const currency = input.currency ?? input.merchants[0]?.currency ?? "USD";
  const active = input.swaps
    .filter((s) => s.status !== "rejected" && s.savings.monthlySavings > 0)
    .sort((a, b) => b.savings.monthlySavings - a.savings.monthlySavings);

  const weekCount = Math.max(1, Math.floor(horizon / 7));
  const startWeek = new Map<string, number>();
  active.forEach((s, i) => startWeek.set(s.id, 1 + Math.floor((i * weekCount) / Math.max(1, active.length))));

  const weeks: PlanWeek[] = [];
  for (let w = 1; w <= weekCount; w++) {
    const firstDay = (w - 1) * 7 + 1;
    const lastDay = w === weekCount ? horizon : w * 7;
    const days = lastDay - firstDay + 1;
    const actions: PlanWeek["actions"] = [];
    let expected = 0;
    for (const s of active) {
      const start = startWeek.get(s.id)!;
      if (start > w) continue;
      const weeklyVisits = (s.from.visitsPerMonth * days) / 30;
      const swapped = Math.max(1, Math.round(weeklyVisits * s.savings.swapShare));
      expected += (s.savings.monthlySavings * days) / 30;
      const perVisit = round2(s.savings.ticketBefore - s.savings.ticketAfter);
      actions.push({
        swapId: s.id,
        day: start === w ? firstDay : undefined,
        text:
          start === w
            ? `Start: try ${s.to.entity.name} instead of ${s.from.name}${swapped > 1 ? ` for ${swapped} visits` : " once"} this week (about ${money(perVisit, currency)} less each time).`
            : `Keep going: ${s.to.entity.name} for ${swapped} of your ${s.from.name} visits.`,
      });
    }
    if (w === weekCount) {
      actions.push({
        day: horizon,
        text: active.length
          ? "Review: keep the swaps you liked and reject the rest; SameTaste re-plans the rejected ones."
          : "No swaps yet: answer the open questions or widen the search radius, then re-plan.",
      });
    }
    weeks.push({
      week: w,
      title: weekTitle(w, weekCount),
      actions,
      expectedSavings: round2(expected),
    });
  }

  const monthlyBefore = input.merchants.reduce((a, m) => a + monthlySpend(m), 0);
  const monthlySavings = active.reduce((a, s) => a + s.savings.monthlySavings, 0);
  const totals = {
    monthlyBefore: round2(monthlyBefore),
    monthlyAfter: round2(monthlyBefore - monthlySavings),
    monthlySavings: round2(monthlySavings),
    annualSavings: round2(monthlySavings * 12),
    savingsRate: monthlyBefore > 0 ? Math.round((monthlySavings / monthlyBefore) * 1000) / 1000 : 0,
  };

  return {
    id: input.id,
    createdAt: input.createdAt ?? new Date().toISOString(),
    horizonDays: horizon,
    currency,
    location: input.location,
    swaps: input.swaps,
    weeks,
    totals,
    unswapped: input.unswapped ?? [],
    summary:
      input.summary ??
      (active.length
        ? `${active.length} swap${active.length > 1 ? "s" : ""}, each one price level down and sharing a Qloo taste tag, save about ${money(totals.monthlySavings, currency)} a month.` +
          (input.unswapped?.length ? ` ${input.unswapped.length} place${input.unswapped.length > 1 ? "s stay" : " stays"} as ${input.unswapped.length > 1 ? "they are" : "it is"}.` : "")
        : "No twin one price level down with the same taste yet, so everything stays."),
    ...(input.receipt ? { receipt: input.receipt } : {}),
    ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
  };
}

function weekTitle(w: number, n: number): string {
  if (w === 1) return "Week 1: first swap";
  if (w === n) return `Week ${w}: settle in and review`;
  return `Week ${w}: add the next swaps`;
}

function money(n: number, currency: string) {
  return currency === "USD" ? `$${n.toFixed(2)}` : `${n.toFixed(2)} ${currency}`;
}

export { visitsPerMonth };
