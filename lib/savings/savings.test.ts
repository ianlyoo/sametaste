import { describe, expect, it } from "vitest";
import { PlanSchema, type Swap } from "../contract";
import { buildPlan, estimateSwapSavings, ticketTable, withAssumptions } from "./index";

describe("estimateSwapSavings", () => {
  it("scales the observed ticket by the tier ratio", () => {
    // 12 coffees for $84 => $7 ticket; $$ -> $ ratio 4/6
    const e = estimateSwapSavings({ category: "coffee", count: 12, totalSpend: 84, fromPriceLevel: 2, toPriceLevel: 1 });
    expect(e.method).toBe("observed_ticket");
    expect(e.confidence).toBe("high");
    expect(e.ticketBefore).toBe(7);
    expect(e.ticketAfter).toBeCloseTo(4.67, 2);
    expect(e.visitsPerMonth).toBe(12);
    // 12 * 0.75 * (7 - 4.667) = 21
    expect(e.monthlySavings).toBeCloseTo(21, 1);
    expect(e.annualSavings).toBeCloseTo(252, 0);
    expect(e.monthlyBefore).toBe(84);
  });

  it("normalises the window to 30 days", () => {
    const e = estimateSwapSavings({ category: "restaurant", count: 6, totalSpend: 600, windowDays: 60, fromPriceLevel: 4, toPriceLevel: 3 });
    expect(e.visitsPerMonth).toBe(3);
    expect(e.monthlyBefore).toBe(300);
  });

  it("uses the tier table when the original tier is unknown and never invents savings", () => {
    const e = estimateSwapSavings({ category: "restaurant", count: 4, totalSpend: 240, toPriceLevel: 2 });
    expect(e.method).toBe("price_tier");
    expect(e.ticketAfter).toBe(35);
    const none = estimateSwapSavings({ category: "restaurant", count: 4, totalSpend: 80, toPriceLevel: 3 });
    expect(none.monthlySavings).toBe(0);
    expect(none.confidence).toBe("low");
    const unknown = estimateSwapSavings({ category: "bar", count: 2, totalSpend: 60 });
    expect(unknown.monthlySavings).toBe(0);
    expect(unknown.notes.join(" ")).toMatch(/no price level/i);
  });

  it("honours user-edited assumptions", () => {
    const input = { category: "coffee" as const, count: 10, totalSpend: 60, fromPriceLevel: 2 as const, toPriceLevel: 1 as const };
    const all = withAssumptions(input, { swapShare: 1 });
    const half = withAssumptions(input, { swapShare: 0.5 });
    expect(all.monthlySavings).toBeCloseTo(half.monthlySavings * 2, 2);
    const custom = withAssumptions(input, { ticketByPriceLevel: { coffee: { "1": 3, "2": 6 } } });
    expect(custom.ticketAfter).toBe(3);
    expect(ticketTable("coffee", { coffee: { "1": -5 } })[1]).toBe(4);
  });
});

function swap(id: string, monthly: number, status: Swap["status"] = "proposed"): Swap {
  const savings = estimateSwapSavings({ category: "coffee", count: 10, totalSpend: 70, fromPriceLevel: 2, toPriceLevel: 1 });
  return {
    id,
    merchantKey: id,
    category: "coffee",
    from: { name: `From ${id}`, visitsPerMonth: 10, monthlySpend: 70, avgTicket: 7 },
    to: {
      candidateId: `c-${id}`,
      merchantKey: id,
      entity: { id: `E-${id}`, name: `To ${id}`, type: "place", priceLevel: 1 },
      evidence: { entityId: `E-${id}`, signalEntityId: `S-${id}`, tags: [], query: "q" },
      score: 0.8,
      reasons: [],
    },
    savings: { ...savings, monthlySavings: monthly, annualSavings: monthly * 12 },
    rationale: "r",
    status,
  };
}

describe("buildPlan", () => {
  const merchants = [
    { key: "a", rawMerchant: "A", count: 10, totalSpend: 300, currency: "USD" },
    { key: "b", rawMerchant: "B", count: 5, totalSpend: 200, currency: "USD" },
  ];
  const location = { label: "Williamsburg, Brooklyn" };

  it("builds a valid 30-day plan with ramped swaps and totals", () => {
    const plan = buildPlan({ id: "p1", location, merchants, swaps: [swap("a", 20), swap("b", 30), swap("c", 10, "rejected")] });
    expect(PlanSchema.parse(plan)).toBeTruthy();
    expect(plan.weeks).toHaveLength(4);
    expect(plan.totals.monthlyBefore).toBe(500);
    expect(plan.totals.monthlySavings).toBe(50);
    expect(plan.totals.savingsRate).toBe(0.1);
    // biggest saver starts in week 1
    expect(plan.weeks[0].actions[0].swapId).toBe("b");
    expect(plan.weeks[0].actions.some((a) => a.swapId === "c")).toBe(false);
    const sumWeeks = plan.weeks.reduce((a, w) => a + w.expectedSavings, 0);
    expect(sumWeeks).toBeLessThanOrEqual(50.01);
    expect(plan.weeks[3].actions.at(-1)!.day).toBe(30);
  });

  it("handles no swaps", () => {
    const plan = buildPlan({ id: "p2", location, merchants, swaps: [] });
    expect(plan.totals.monthlySavings).toBe(0);
    expect(plan.summary).toMatch(/everything stays/);
  });
});

describe("per-twin swap share", () => {
  it("prices two twins at the same tier differently by distance and Qloo match", async () => {
    const { estimateSwapSavings, swapShareFor } = await import("./engine");
    const base = { category: "restaurant" as const, count: 4, totalSpend: 400, fromPriceLevel: 3 as const, toPriceLevel: 2 as const };
    const near = estimateSwapSavings({ ...base, distanceKm: 0.5, affinity: 0.9 });
    const far = estimateSwapSavings({ ...base, distanceKm: 3.5, affinity: 0.6 });
    expect(near.monthlySavings).toBeGreaterThan(far.monthlySavings);
    expect(far.notes.join(" ")).toMatch(/our assumption/);
    expect(swapShareFor()).toBe(0.75);
    // the user's own share always wins
    expect(estimateSwapSavings({ ...base, distanceKm: 3.5, assumptions: { swapShare: 0.5 } }).swapShare).toBe(0.5);
  });
});
