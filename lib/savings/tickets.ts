/**
 * Default average ticket (one visit, or one month for memberships) by
 * category and Qloo price_level, in USD for New York.
 *
 * These are our own round-number assumptions, not Qloo data. The UI lets the
 * user edit them (SavingsAssumptions.ticketByPriceLevel).
 */
import type { Category, PriceLevel } from "../contract";

export type TicketTable = Record<PriceLevel, number>;

export const DEFAULT_TICKETS: Record<Category, TicketTable> = {
  coffee: { 1: 4, 2: 6, 3: 8, 4: 11 },
  restaurant: { 1: 18, 2: 35, 3: 65, 4: 130 },
  fast_food: { 1: 11, 2: 15, 3: 19, 4: 25 },
  bar: { 1: 12, 2: 22, 3: 35, 4: 55 },
  grocery: { 1: 45, 2: 60, 3: 80, 4: 110 },
  // monthly membership
  fitness: { 1: 25, 2: 60, 3: 120, 4: 250 },
  beauty: { 1: 30, 2: 55, 3: 85, 4: 130 },
  shopping: { 1: 25, 2: 50, 3: 90, 4: 180 },
  entertainment: { 1: 15, 2: 30, 3: 55, 4: 100 },
  streaming: { 1: 7, 2: 12, 3: 17, 4: 23 },
  transport: { 1: 3, 2: 15, 3: 30, 4: 60 },
  other: { 1: 20, 2: 40, 3: 75, 4: 150 },
};

export const DEFAULT_SWAP_SHARE = 0.75;
export const DEFAULT_HORIZON_DAYS = 30;

/** Merge user overrides (string keys from JSON) into the default table. */
export function ticketTable(
  category: Category,
  overrides?: Record<string, Record<string, number>>,
): TicketTable {
  const base = { ...DEFAULT_TICKETS[category] };
  const o = overrides?.[category];
  if (o) {
    for (const lvl of [1, 2, 3, 4] as const) {
      const v = o[String(lvl)];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) base[lvl] = v;
    }
  }
  return base;
}
