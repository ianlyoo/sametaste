/**
 * Pure derivation of what the scene prints from the flow state. No three.js,
 * so it can be unit-tested and reused for the a11y text alternative.
 */
import { normalizeDescriptor } from "../../lib/client/merchants";
import type { Swap } from "../../lib/contract";

/** The twin's own monthly price: every visit at the twin's ticket. The paper and the text alternative both show it. */
export function twinMonthly(sw: Swap): number {
  return Math.round(sw.savings.visitsPerMonth * sw.savings.ticketAfter * 100) / 100;
}
import type { SceneData, SceneReceipt, SceneReceiptRow } from "./types";

/** Street or neighbourhood from a Qloo address like "123 Bedford Ave, Brooklyn, NY 11249". */
export function shortAddress(address?: string): string | undefined {
  if (!address) return undefined;
  const first = address.replace(/\s*\([^)]*\)/g, "").split(",")[0]?.trim();
  if (!first) return undefined;
  return first.replace(/^\d+[a-z]?\s+/i, "").replace(/\bAvenue\b/i, "Av").replace(/\bStreet\b/i, "St").slice(0, 22);
}

function swapFor(swaps: Swap[], key: string): Swap | undefined {
  return swaps.find((s) => s.merchantKey === key && s.status !== "rejected") ?? swaps.find((s) => s.merchantKey === key);
}

export function deriveReceipt(data: SceneData): SceneReceipt {
  const currency = data.plan?.currency ?? data.merchants[0]?.currency ?? "USD";
  const byKey = new Map(data.merchants.map((m) => [m.key, m]));
  const rows: SceneReceiptRow[] = [];
  for (const t of data.statement?.transactions ?? []) {
    if (t.amount <= 0) continue;
    const { key, name } = normalizeDescriptor(t.rawMerchant);
    const local = byKey.get(key);
    const res = data.resolutions[key];
    const sw = local ? swapFor(data.swaps, key) : undefined;
    const twin = sw
      ? {
          name: sw.to.entity.name,
          // the same two figures as the paper: the twin's own monthly price, and the plan's monthly saving for this line
          price: twinMonthly(sw),
          saving: Math.max(0, sw.savings.monthlySavings),
          status: data.replanning.includes(key) ? ("replanning" as const) : sw.status,
        }
      : undefined;
    rows.push({
      id: t.id,
      date: t.date,
      name: res?.normalizedName ?? local?.name ?? name,
      rawMerchant: t.rawMerchant,
      where: shortAddress(res?.entity?.address),
      amount: t.amount,
      merchantKey: local ? key : undefined,
      swapId: sw?.id,
      twin,
    });
  }
  const total = data.plan?.totals.monthlyBefore ?? round(rows.reduce((a, r) => a + r.amount, 0));
  const saving = data.plan
    ? data.plan.totals.monthlySavings
    : round(rows.reduce((a, r) => a + (r.twin && r.twin.status !== "rejected" ? r.twin.saving : 0), 0));
  return { rows, currency, total, totalAfter: round(total - saving), saving };
}

const round = (v: number) => Math.round(v * 100) / 100;
