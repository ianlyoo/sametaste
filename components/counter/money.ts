/**
 * The one shared total. The overlay prints only numbers the paper prints, from
 * the scene's own functions: TOTAL (the statement lines) and SAVED (the swaps
 * that count, the plan's rule). A reject drops its saving at once; the
 * replacement adds its own when it lands.
 */
import { totals } from "@/components/scene/lines";
import type { FlowState } from "@/lib/client/flow";

export interface SharedMoney {
  currency: string;
  /** Paper TOTAL: every spend line on the statement. */
  statement: number;
  /** Paper SAVED, a month. */
  saved: number;
  /** Swaps kept, of merchants swapped (paper SWAPS KEPT). */
  kept: number;
  all: number;
}

export function sharedMoney(s: FlowState): SharedMoney {
  const t = totals(s);
  const lines = (s.statement?.transactions ?? []).filter((x) => x.amount > 0);
  const statement = Math.round(lines.reduce((a, x) => a + x.amount, 0) * 100) / 100;
  return { currency: s.plan?.currency ?? s.merchants[0]?.currency ?? t.currency, statement, saved: t.saving, kept: t.kept, all: t.all };
}
