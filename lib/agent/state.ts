/** Per-run state shared by the tools, the scripted model and the finaliser. */
import type {
  AgentQuestion,
  MerchantAggregate,
  MerchantResolution,
  ParsedAgentRequest,
  Plan,
  Swap,
  SwapCandidate,
  TasteFingerprint,
} from "../contract";
import type { CallBudget, QlooClient } from "../qloo/client";
import type { QlooEntity } from "../qloo/types";
import { monthlySpend } from "../savings/plan";
import { visitsPerMonth } from "../savings/engine";
import type { AgentLimits } from "./config";
import type { EventSink } from "./events";
import { resolveLocation } from "./geo";
import type { NormalizedMerchant } from "./normalize";

export interface MerchantState {
  agg: MerchantAggregate;
  monthlySpend: number;
  visitsPerMonth: number;
  avgTicket: number;
  norm?: NormalizedMerchant;
  searched: boolean;
  resolution?: MerchantResolution;
  entity?: QlooEntity;
  /** Ambiguous options kept for the user's answer. */
  options: QlooEntity[];
  asked: boolean;
  insightsAttempts: number;
  candidates: SwapCandidate[];
  /** Entities never to propose again (rejected by the user). */
  excludeIds: Set<string>;
  /** Swap fixed by the user (accepted) or carried from the previous plan. */
  carried?: Swap;
  swap?: Swap;
  rejectedReason?: string;
  /** Radius override from feedback ("too far"), metres. */
  radiusM?: number;
  /** Only these merchants need work in a re-plan. */
  needsWork: boolean;
  /** Set when this line was merged into another (same place, other descriptor). */
  mergedInto?: string;
  /** Keys of the lines merged into this one. */
  mergedKeys: string[];
}

export class RunState {
  readonly merchants = new Map<string, MerchantState>();
  /** Keys by monthly spend, descending. */
  ranked: string[];
  readonly questions: AgentQuestion[] = [];
  readonly loc: ReturnType<typeof resolveLocation>;
  normalized = false;
  fingerprint?: TasteFingerprint;
  fingerprintTried = false;
  plan?: Plan;
  costUsd = 0;
  toolTurns = 0;
  stopReason?: "spend_cap" | "run_cost_cap";
  private candidateSeq = 0;
  private swapSeq = 0;
  readonly replan: boolean;

  constructor(
    readonly runId: string,
    readonly req: ParsedAgentRequest,
    readonly qloo: QlooClient,
    readonly budget: CallBudget,
    readonly sink: EventSink,
    readonly limits: AgentLimits,
  ) {
    this.loc = resolveLocation(req.location);
    for (const m of req.merchants) {
      if (this.merchants.has(m.key)) continue;
      this.merchants.set(m.key, {
        agg: m,
        monthlySpend: monthlySpend(m),
        visitsPerMonth: visitsPerMonth(m.count, m.windowDays ?? 30),
        avgTicket: m.totalSpend / Math.max(1, m.count),
        searched: false,
        options: [],
        asked: false,
        insightsAttempts: 0,
        candidates: [],
        excludeIds: new Set(),
        needsWork: true,
        mergedKeys: [],
      });
    }
    this.ranked = this.rank();
    this.replan = Boolean(req.previousPlan || req.feedback?.length || req.answers?.length);
  }

  private rank(): string[] {
    return [...this.merchants.values()]
      .filter((m) => !m.mergedInto)
      .sort((a, b) => b.monthlySpend - a.monthlySpend)
      .map((m) => m.agg.key);
  }

  get(key: string): MerchantState | undefined {
    const m = this.merchants.get(key);
    return m?.mergedInto ? this.merchants.get(m.mergedInto) : m;
  }

  /**
   * One line per place: statement lines that normalise to the same name ("SQ *BLUE BTL" and "BLUE BOTTLE COFFE") merge into the one
   * with more spend. Runs after normalisation (or with `nameOf`, before it); idempotent.
   */
  mergeDuplicates(nameOf: (m: MerchantState) => string | undefined = (m) => (m.norm && !m.norm.skip ? m.norm.name : undefined)): void {
    const groups = new Map<string, MerchantState[]>();
    for (const m of this.merchants.values()) {
      const name = m.mergedInto ? undefined : nameOf(m);
      if (!name) continue;
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      groups.set(id, [...(groups.get(id) ?? []), m]);
    }
    let changed = false;
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      g.sort((a, b) => b.monthlySpend - a.monthlySpend);
      const [main, ...rest] = g;
      for (const x of rest) {
        x.mergedInto = main.agg.key;
        main.mergedKeys.push(x.agg.key, ...x.mergedKeys);
        main.agg = {
          ...main.agg,
          count: main.agg.count + x.agg.count,
          totalSpend: Math.round((main.agg.totalSpend + x.agg.totalSpend) * 100) / 100,
          windowDays: Math.max(main.agg.windowDays ?? 30, x.agg.windowDays ?? 30),
        };
        main.carried ??= x.carried;
        for (const id of x.excludeIds) main.excludeIds.add(id);
        main.rejectedReason ??= x.rejectedReason;
        x.carried = undefined;
        x.swap = undefined;
      }
      main.monthlySpend = monthlySpend(main.agg);
      main.visitsPerMonth = visitsPerMonth(main.agg.count, main.agg.windowDays ?? 30);
      main.avgTicket = main.agg.totalSpend / Math.max(1, main.agg.count);
      changed = true;
    }
    if (changed) this.ranked = this.rank();
  }

  /** Main line -> merged lines, for lines merged so far. */
  merges(): { merchantKey: string; mergedKeys: string[] }[] {
    return [...this.merchants.values()].filter((m) => m.mergedKeys.length).map((m) => ({ merchantKey: m.agg.key, mergedKeys: [...m.mergedKeys] }));
  }

  /** Lines merged into `m`, with `m`'s resolution copied so every request key is accounted for. */
  mergedResolutions(): MerchantResolution[] {
    const out: MerchantResolution[] = [];
    for (const m of this.merchants.values()) {
      const main = m.mergedInto ? this.merchants.get(m.mergedInto) : undefined;
      if (main?.resolution) out.push({ ...main.resolution, merchantKey: m.agg.key, rawMerchant: m.agg.rawMerchant });
    }
    return out;
  }

  /** Taste merchants the agent should work on, by spend, capped. */
  focus(): MerchantState[] {
    return this.ranked
      .map((k) => this.merchants.get(k)!)
      .filter((m) => !m.norm?.skip && !m.mergedInto)
      .slice(0, this.limits.maxMerchants);
  }

  nextCandidateId(): string {
    return `c${++this.candidateSeq}`;
  }
  nextSwapId(): string {
    return `${this.runId.slice(0, 8)}-s${++this.swapSeq}`;
  }

  findCandidate(key: string, candidateId: string): SwapCandidate | undefined {
    return this.get(key)?.candidates.find((c) => c.candidateId === candidateId);
  }

  allSwaps(): Swap[] {
    const out: Swap[] = [];
    for (const m of this.merchants.values()) {
      if (m.mergedInto) continue;
      if (m.swap) out.push(m.swap);
      else if (m.carried) out.push(m.carried);
    }
    return out;
  }

  pendingQuestions(): AgentQuestion[] {
    return this.questions;
  }
}
