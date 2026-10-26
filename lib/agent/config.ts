/**
 * Agent configuration from env. Secrets are read here and never echoed.
 */
export const AGENT_MODEL_ID = "claude-sonnet-5-5";
export const NORMALIZER_MODEL_ID = "claude-haiku-5-5";

export interface AgentLimits {
  /** Max model steps (tool turns) per run. DESIGN: 12. */
  maxToolTurns: number;
  /** Max Qloo network calls per run. DESIGN: 40, plus up to 10 for the measured proof (one per swap). */
  maxQlooCalls: number;
  /** Max merchants the agent analyses per run. */
  maxMerchants: number;
  /** Per-run cost ceiling, USD. */
  perRunCostCapUsd: number;
}

export const DEFAULT_LIMITS: AgentLimits = {
  maxToolTurns: 12,
  maxQlooCalls: 50,
  maxMerchants: 12,
  perRunCostCapUsd: 0.6,
};

export interface AgentEnv {
  anthropicApiKey?: string;
  /** Hard stop for the whole hackathon, USD (default 100). */
  totalSpendCapUsd: number;
  /** Daily cap, USD (DAILY_SPEND_CAP_USD, default 15). */
  dailySpendCapUsd: number;
  rateLimitMax: number;
  rateLimitWindowS: number;
  upstashUrl?: string;
  upstashToken?: string;
  /** File store for dev when Upstash is not configured. */
  stateFile?: string;
  production: boolean;
  /**
   * In production the spend ledger must persist (Upstash); otherwise live
   * model runs are refused. ALLOW_EPHEMERAL_SPEND_LEDGER=1 overrides.
   */
  requirePersistentLedger: boolean;
  /** Use the scripted (no-LLM) model even without a key (dev and tests). */
  scripted: boolean;
}

function num(v: string | undefined, d: number): number {
  const n = v === undefined || v.trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

export function agentEnv(env: Record<string, string | undefined> = process.env): AgentEnv {
  const production = env.NODE_ENV === "production";
  const anthropicApiKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
  return {
    anthropicApiKey,
    totalSpendCapUsd: num(env.TOTAL_SPEND_CAP_USD, 100),
    dailySpendCapUsd: num(env.DAILY_SPEND_CAP_USD, 15),
    rateLimitMax: num(env.RATE_LIMIT_MAX, 6),
    rateLimitWindowS: num(env.RATE_LIMIT_WINDOW_S, 600),
    upstashUrl: (env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL)?.trim() || undefined,
    upstashToken: (env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN)?.trim() || undefined,
    stateFile: env.SAMETASTE_STATE_FILE?.trim() || undefined,
    production,
    requirePersistentLedger: production && env.ALLOW_EPHEMERAL_SPEND_LEDGER !== "1",
    scripted: env.AGENT_SCRIPTED === "1" || (!anthropicApiKey && env.NODE_ENV !== "production"),
  };
}
