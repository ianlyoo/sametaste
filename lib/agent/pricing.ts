/**
 * Token prices, USD per million tokens.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing, seen
 * 2026-10-22 (DESIGN §5): Sonnet 5.5 $2 in / $10 out / $0.10 cache hit;
 * Haiku 5.5 $0.10 / $0.50. Not in DESIGN, so assumed conservatively:
 * cache writes at 1.25x input, Haiku cache hits at 10% of input.
 */
import type { LanguageModelUsage } from "ai";
import { AGENT_MODEL_ID, NORMALIZER_MODEL_ID } from "./config";

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const PRICES: Record<string, ModelPrice> = {
  [AGENT_MODEL_ID]: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  [NORMALIZER_MODEL_ID]: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/** Unknown models are priced as the most expensive known model. */
export function priceFor(modelId: string): ModelPrice {
  const hit = PRICES[modelId] ?? Object.entries(PRICES).find(([k]) => modelId.startsWith(k))?.[1];
  return hit ?? PRICES[AGENT_MODEL_ID];
}

type UsageLike = Pick<LanguageModelUsage, "inputTokens" | "outputTokens"> & {
  inputTokenDetails?: Partial<LanguageModelUsage["inputTokenDetails"]>;
};

export function costUsd(modelId: string, usage: UsageLike | undefined): number {
  if (!usage) return 0;
  const p = priceFor(modelId);
  const input = usage.inputTokens ?? 0;
  const read = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const write = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const noCache = usage.inputTokenDetails?.noCacheTokens ?? Math.max(0, input - read - write);
  const output = usage.outputTokens ?? 0;
  return (noCache * p.input + read * p.cacheRead + write * p.cacheWrite + output * p.output) / 1_000_000;
}
