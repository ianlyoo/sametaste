/**
 * Spend ledger: counts model cost from token usage, persisted in the KV.
 * Hard stop at the total cap (default $100) and a daily cap (default $15).
 */
import type { KV } from "./kv";

export interface SpendStatus {
  totalUsd: number;
  todayUsd: number;
  totalCapUsd: number;
  dailyCapUsd: number;
  blocked: boolean;
  reason?: "total_cap" | "daily_cap" | "no_persistent_ledger";
}

const TOTAL_KEY = "spend:total";
const dayKey = (d = new Date()) => `spend:day:${d.toISOString().slice(0, 10)}`;

export class SpendLedger {
  constructor(
    private readonly kv: KV,
    private readonly caps: { totalCapUsd: number; dailyCapUsd: number; requirePersistent?: boolean },
  ) {}

  async status(): Promise<SpendStatus> {
    const [total, today] = await Promise.all([this.kv.get<number>(TOTAL_KEY), this.kv.get<number>(dayKey())]);
    const s: SpendStatus = {
      totalUsd: Number(total ?? 0),
      todayUsd: Number(today ?? 0),
      totalCapUsd: this.caps.totalCapUsd,
      dailyCapUsd: this.caps.dailyCapUsd,
      blocked: false,
    };
    if (this.caps.requirePersistent && !(this.kv.persistent && (this.kv.probe ? await this.kv.probe() : true))) {
      s.blocked = true;
      s.reason = "no_persistent_ledger";
    } else if (s.totalUsd >= s.totalCapUsd) {
      s.blocked = true;
      s.reason = "total_cap";
    } else if (s.todayUsd >= s.dailyCapUsd) {
      s.blocked = true;
      s.reason = "daily_cap";
    }
    return s;
  }

  /** Records cost; returns the new status. */
  async record(costUsd: number): Promise<SpendStatus> {
    if (costUsd > 0) {
      await this.kv.incrByFloat(TOTAL_KEY, costUsd);
      await this.kv.incrByFloat(dayKey(), costUsd, 3 * 86_400);
    }
    return this.status();
  }
}
