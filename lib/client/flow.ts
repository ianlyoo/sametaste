/**
 * Flow state machine: upload -> categories -> swaps (accept / reject -> re-plan)
 * -> plan -> compare. A pure reducer plus selectors and request builders, so it
 * can be tested without React. `useAgentFlow` drives it.
 *
 * Two agent runs can be live at once: the SameTaste run and the LLM-only
 * baseline for the compare view. Each run carries a client ticket; events from
 * a superseded run are dropped.
 */
import type {
  AgentEvent,
  AgentMode,
  AgentPhase,
  AgentQuestion,
  AgentRequest,
  Answer,
  BaselineSuggestion,
  Location,
  MerchantAggregate,
  MerchantResolution,
  Plan,
  ProofSide,
  Swap,
  SwapFeedback,
  TasteFingerprint,
  ToolName,
  Usage,
} from "../contract";
import { aggregateMerchants, descriptorHead, normalizeDescriptor, summarizeCategories, toWire, type CategorySummary, type LocalMerchant } from "./merchants";
import type { ParsedStatement } from "./statement";

export type Step = "upload" | "categories" | "swaps" | "plan" | "compare";
export const STEPS: Step[] = ["upload", "categories", "swaps", "plan", "compare"];

export interface ToolStepView {
  stepId: string;
  tool: ToolName;
  state: "started" | "finished" | "failed";
  summary: string;
  durationMs?: number;
  qlooCalls?: number;
}

export interface RunError {
  /** Contract error code, or a client-side one. */
  code: string;
  message: string;
  retryable: boolean;
}

export type Merge = { merchantKey: string; mergedKeys: string[] };

export interface RunState {
  status: "idle" | "running" | "done" | "error";
  /** Client ticket of the live run; events tagged with another ticket are stale. */
  ticket: number;
  runId?: string;
  phase?: AgentPhase;
  statusMessage?: string;
  steps: ToolStepView[];
  messages: string[];
  qlooMock: boolean;
  fromCache: boolean;
  usage?: Usage;
  /** contract 1.3: statement lines that are one place, announced up front (local keys) so rows merge before they print. */
  merges: Merge[];
  doneReason?: "complete" | "awaiting_answer" | "limit_reached" | "error";
  error?: RunError;
}

export interface FlowState {
  step: Step;
  personaId?: string;
  location?: Location;
  statement?: ParsedStatement;
  merchants: LocalMerchant[];
  /**
   * What goes over the wire when it must match a server-side reference exactly
   * (sample personas: lets the server serve its bundled snapshot). Otherwise
   * derived from `merchants`.
   */
  wireMerchants?: MerchantAggregate[];
  /** Server merchant key -> local key, when `wireMerchants` uses the server's keys. */
  keyMap?: Record<string, string>;
  categories: CategorySummary[];
  parseError?: string;

  run: RunState;
  /**
   * `proof` (v1.3, from `baseline_ready.proof`) is the model's side of the measured proof; ours is `plan.proof`.
   * `proofRuns` (v1.6) is every model-alone run of a recording, for its spread.
   */
  baseline: RunState & { suggestions: BaselineSuggestion[]; proof?: ProofSide; proofRuns?: ProofSide[] };

  resolutions: Record<string, MerchantResolution>;
  /** Swaps in display order; a re-planned swap replaces the rejected one in place. */
  swaps: Swap[];
  plan?: Plan;
  /** Cross-domain taste profile (v1.1), from its own event or the plan. */
  fingerprint?: TasteFingerprint;
  question?: AgentQuestion;
  answers: Answer[];
  feedback: SwapFeedback[];
  /** Merchant keys waiting for a replacement after a reject. */
  replanning: string[];
}

const idleRun = (): RunState => ({ status: "idle", ticket: 0, steps: [], messages: [], qlooMock: false, fromCache: false, merges: [] });

export const initialFlow: FlowState = {
  step: "upload",
  merchants: [],
  categories: [],
  run: idleRun(),
  baseline: { ...idleRun(), suggestions: [] },
  resolutions: {},
  swaps: [],
  answers: [],
  feedback: [],
  replanning: [],
};

export type FlowAction =
  | { type: "statement_loaded"; statement: ParsedStatement; personaId?: string; location?: Location; wire?: MerchantAggregate[] }
  | { type: "parse_failed"; message: string }
  | { type: "set_location"; location: Location }
  | { type: "go"; step: Step }
  | { type: "run_requested"; mode: AgentMode; ticket: number }
  | { type: "event"; mode: AgentMode; ticket: number; event: AgentEvent }
  | { type: "run_failed"; mode: AgentMode; ticket: number; error: RunError }
  | { type: "accept"; swapId: string }
  | { type: "reject"; swapId: string; reason?: string }
  | { type: "undo"; swapId: string }
  | { type: "answer"; answer: Answer }
  | { type: "reset" };

/** Steps the user may open now. */
export function canGo(s: FlowState, step: Step): boolean {
  switch (step) {
    case "upload":
      return true;
    case "categories":
      return s.merchants.length > 0;
    case "swaps":
      return s.merchants.length > 0 && !!s.location;
    case "plan":
      return !!s.plan || s.swaps.length > 0;
    case "compare":
      return s.merchants.length > 0 && !!s.location;
  }
}

function upsertSwap(swaps: Swap[], incoming: Swap): Swap[] {
  const byId = swaps.findIndex((x) => x.id === incoming.id);
  if (byId >= 0) {
    // Keep the user's verdict if the server echoes a swap back.
    const prev = swaps[byId];
    const next = prev.status !== "proposed" && incoming.status === "proposed" ? { ...incoming, status: prev.status } : incoming;
    return swaps.map((x, i) => (i === byId ? next : x));
  }
  // A new candidate for a merchant whose swap was rejected takes its slot.
  const slot = swaps.findIndex((x) => x.merchantKey === incoming.merchantKey && x.status === "rejected");
  if (slot >= 0) return swaps.map((x, i) => (i === slot ? incoming : x));
  if (swaps.some((x) => x.merchantKey === incoming.merchantKey && x.status === "accepted")) return swaps;
  const open = swaps.findIndex((x) => x.merchantKey === incoming.merchantKey && x.status === "proposed");
  if (open >= 0) return swaps.map((x, i) => (i === open ? incoming : x));
  return [...swaps, incoming];
}

/** Merge a plan's swaps into ours, keeping local verdicts and order. */
function mergePlan(swaps: Swap[], plan: Plan): Swap[] {
  let out = swaps;
  for (const sw of plan.swaps) out = upsertSwap(out, sw);
  return out;
}

function reduceRun(run: RunState, ev: AgentEvent): RunState {
  switch (ev.type) {
    case "run_started":
      return { ...run, runId: ev.runId, qlooMock: ev.qlooMock, fromCache: ev.fromCache, merges: ev.merges ?? [] };
    case "status":
      return { ...run, phase: ev.phase, statusMessage: ev.message };
    case "tool_step": {
      const view: ToolStepView = {
        stepId: ev.stepId,
        tool: ev.tool,
        state: ev.state,
        summary: ev.summary,
        durationMs: ev.durationMs,
        qlooCalls: ev.qlooCalls,
      };
      const i = run.steps.findIndex((x) => x.stepId === ev.stepId);
      return { ...run, steps: i >= 0 ? run.steps.map((x, k) => (k === i ? view : x)) : [...run.steps, view] };
    }
    case "message":
      return { ...run, messages: [...run.messages, ev.text] };
    case "error":
      return { ...run, error: { code: ev.code, message: ev.message, retryable: ev.retryable } };
    case "done":
      return {
        ...run,
        status: ev.reason === "error" ? "error" : "done",
        doneReason: ev.reason,
        usage: ev.usage,
        phase: "done",
        error: ev.reason === "error" ? (run.error ?? { code: "internal", message: "The agent stopped with an error.", retryable: true }) : run.error,
      };
    default:
      return run;
  }
}

export function flowReducer(s: FlowState, a: FlowAction): FlowState {
  switch (a.type) {
    case "statement_loaded": {
      const merchants = aggregateMerchants(a.statement);
      return {
        ...initialFlow,
        step: "categories",
        statement: a.statement,
        personaId: a.personaId,
        // a sample persona's place is not yours: an upload after one starts without a place
        location: a.location ?? (s.personaId ? undefined : s.location),
        merchants,
        wireMerchants: a.wire,
        keyMap: a.wire ? wireKeyMap(a.wire, merchants) : undefined,
        categories: summarizeCategories(merchants),
        // keep tickets increasing so late events from an old run stay stale
        run: { ...idleRun(), ticket: s.run.ticket },
        baseline: { ...idleRun(), ticket: s.baseline.ticket, suggestions: [] },
      };
    }
    case "parse_failed":
      return { ...s, parseError: a.message, step: "upload" };
    case "set_location":
      return { ...s, location: a.location };
    case "go":
      return canGo(s, a.step) ? { ...s, step: a.step } : s;
    case "run_requested": {
      const fresh = { ...idleRun(), status: "running" as const, ticket: a.ticket };
      if (a.mode === "llm_only") return { ...s, baseline: { ...fresh, suggestions: [] } };
      // A re-plan keeps the activity feed so the user sees it continue.
      const keepFeed = s.run.status !== "idle" && s.swaps.length > 0;
      return {
        ...s,
        question: undefined,
        run: keepFeed ? { ...s.run, status: "running", ticket: a.ticket, error: undefined, doneReason: undefined } : fresh,
      };
    }
    case "run_failed": {
      if (a.mode === "llm_only")
        return a.ticket === s.baseline.ticket ? { ...s, baseline: { ...s.baseline, status: "error", error: a.error } } : s;
      if (a.ticket !== s.run.ticket) return s;
      return { ...s, run: { ...s.run, status: "error", error: a.error }, replanning: [] };
    }
    case "event": {
      const ev = toLocalKeys(a.event, s.keyMap ?? {}, (key) => statementKey(s, key));
      if (a.mode === "llm_only") {
        if (a.ticket !== s.baseline.ticket) return s;
        const baseline = { ...s.baseline, ...reduceRun(s.baseline, ev) };
        if (ev.type === "baseline_ready") {
          baseline.suggestions = ev.suggestions;
          baseline.proof = ev.proof;
          baseline.proofRuns = ev.proofRuns;
        }
        return { ...s, baseline };
      }
      if (a.ticket !== s.run.ticket) return s;
      const next: FlowState = { ...s, run: reduceRun(s.run, ev) };
      switch (ev.type) {
        case "merchants_resolved": {
          const resolutions = { ...s.resolutions };
          for (const r of ev.resolutions) resolutions[r.merchantKey] = r;
          next.resolutions = resolutions;
          break;
        }
        case "question":
          next.question = ev.question;
          break;
        case "swap_proposed":
          next.swaps = upsertSwap(s.swaps, ev.swap);
          next.replanning = s.replanning.filter((k) => k !== ev.swap.merchantKey);
          break;
        case "taste_fingerprint":
          next.fingerprint = ev.fingerprint;
          break;
        case "plan_ready":
          next.plan = ev.plan;
          if (ev.plan.fingerprint) next.fingerprint = ev.plan.fingerprint;
          next.swaps = mergePlan(s.swaps, ev.plan);
          next.replanning = s.replanning.filter((k) => !ev.plan.swaps.some((x) => x.merchantKey === k));
          break;
        case "done":
          next.replanning = [];
          break;
      }
      return next;
    }
    case "accept":
    case "reject":
    case "undo": {
      const sw = s.swaps.find((x) => x.id === a.swapId);
      if (!sw) return s;
      const status = a.type === "accept" ? "accepted" : a.type === "reject" ? "rejected" : "proposed";
      const feedback = s.feedback.filter((f) => f.swapId !== a.swapId);
      if (a.type !== "undo")
        feedback.push({
          swapId: sw.id,
          merchantKey: sw.merchantKey,
          candidateEntityId: sw.to.entity.id,
          verdict: a.type,
          ...(a.type === "reject" && a.reason ? { reason: a.reason.slice(0, 500) } : {}),
        });
      return {
        ...s,
        swaps: s.swaps.map((x) => (x.id === a.swapId ? { ...x, status } : x)),
        feedback,
        replanning: a.type === "reject" ? [...new Set([...s.replanning, sw.merchantKey])] : s.replanning.filter((k) => k !== sw.merchantKey),
      };
    }
    case "answer":
      return {
        ...s,
        answers: [...s.answers.filter((x) => x.questionId !== a.answer.questionId), a.answer],
        question: s.question?.id === a.answer.questionId ? undefined : s.question,
      };
    case "reset":
      return { ...initialFlow, run: { ...idleRun(), ticket: s.run.ticket }, baseline: { ...idleRun(), ticket: s.baseline.ticket, suggestions: [] } };
  }
}

// ---------------------------------------------------------------------------
// Selectors

/** Swaps that count toward the plan: accepted ones once any are accepted, otherwise all still proposed. */
export function planSwaps(s: FlowState): Swap[] {
  const accepted = s.swaps.filter((x) => x.status === "accepted");
  return accepted.length ? accepted : s.swaps.filter((x) => x.status === "proposed");
}

/** Monthly saving of the swaps that count; the scene's paper SAVED uses the same rule. */
export function savingsTotals(s: FlowState): { monthly: number; annual: number; currency: string } {
  const list = planSwaps(s);
  const monthly = list.reduce((a, x) => a + x.savings.monthlySavings, 0);
  return { monthly, annual: list.reduce((a, x) => a + x.savings.annualSavings, 0), currency: list[0]?.savings.currency ?? "USD" };
}

export function qlooCalls(run: RunState): number {
  return run.usage?.qlooCalls ?? run.steps.reduce((a, x) => a + (x.qlooCalls ?? 0), 0);
}

/** True when every swap has a verdict and nothing is being re-planned. */
export function reviewComplete(s: FlowState): boolean {
  return s.swaps.length > 0 && s.replanning.length === 0 && s.swaps.every((x) => x.status !== "proposed");
}

// ---------------------------------------------------------------------------
// Requests

/** Build the next request for the SameTaste run: answers, feedback and the previous plan go back each time. */
/**
 * The server's own merchant list only matches its bundled snapshot on a first
 * ask. Re-plans carry local keys (the plan has been translated), so they send
 * the local merchants too.
 */
function isFirstAsk(s: FlowState, mode: AgentMode): boolean {
  return mode === "llm_only" || (!s.plan && !s.answers.length && !s.feedback.length);
}

function wireKeyMap(wire: MerchantAggregate[], local: LocalMerchant[]): Record<string, string> {
  const keys = new Set(local.map((m) => m.key));
  const map: Record<string, string> = {};
  for (const w of wire) {
    const k = normalizeDescriptor(w.rawMerchant).key;
    if (keys.has(k) && k !== w.key) map[w.key] = k;
  }
  return map;
}

/**
 * A server key no map knows (a recorded run keyed by another normaliser):
 * the one local line whose descriptors start with it, else undefined.
 */
export function statementKey(s: Pick<FlowState, "statement" | "merchants">, key: string): string | undefined {
  if (!s.statement || s.merchants.some((m) => m.key === key)) return undefined;
  const head = descriptorHead(key);
  if (!head) return undefined;
  const found = new Set<string>();
  for (const t of s.statement.transactions) {
    const h = descriptorHead(t.rawMerchant);
    if (h === head || h.startsWith(head + " ")) found.add(normalizeDescriptor(t.rawMerchant).key);
  }
  const [only] = found;
  return found.size === 1 && s.merchants.some((m) => m.key === only) ? only : undefined;
}

/** Rewrite the server's merchant keys in an event to the keys the receipt uses. */
export function toLocalKeys(ev: AgentEvent, map: Record<string, string>, fallback?: (key: string) => string | undefined): AgentEvent {
  const k = (key: string) => map[key] ?? fallback?.(key) ?? key;
  // Server keys that are one local line already (two Blue Bottle descriptors)
  // collapse onto the line itself; the scene hides any key listed as merged.
  const merged = (own: string, keys?: string[]) => {
    if (!keys) return undefined;
    const out = [...new Set(keys.map(k))].filter((x) => x !== own);
    return out.length ? out : undefined;
  };
  const sw = (x: Swap): Swap => {
    const key = k(x.merchantKey);
    const { mergedKeys, ...rest } = x;
    const mk = merged(key, mergedKeys);
    return {
      ...rest,
      merchantKey: key,
      to: { ...x.to, merchantKey: k(x.to.merchantKey) },
      alternatives: x.alternatives?.map((c) => ({ ...c, merchantKey: k(c.merchantKey) })),
      ...(mk ? { mergedKeys: mk } : {}),
    };
  };
  const proof = (p?: ProofSide): ProofSide | undefined => p && { ...p, perMerchant: p.perMerchant.map((x) => ({ ...x, merchantKey: k(x.merchantKey) })) };
  switch (ev.type) {
    case "run_started": {
      const merges = ev.merges?.flatMap((m) => {
        const key = k(m.merchantKey);
        const mk = merged(key, m.mergedKeys);
        return mk ? [{ merchantKey: key, mergedKeys: mk }] : [];
      });
      return ev.merges ? { ...ev, merges } : ev;
    }
    case "merchants_resolved":
      return { ...ev, resolutions: ev.resolutions.map((r) => ({ ...r, merchantKey: k(r.merchantKey) })) };
    case "question":
      return ev.question.merchantKey ? { ...ev, question: { ...ev.question, merchantKey: k(ev.question.merchantKey) } } : ev;
    case "swap_proposed":
      return { ...ev, swap: sw(ev.swap) };
    case "plan_ready": {
      const p = ev.plan;
      return {
        ...ev,
        plan: {
          ...p,
          swaps: p.swaps.map(sw),
          unswapped: p.unswapped.map((u) => ({ ...u, merchantKey: k(u.merchantKey) })),
          proof: proof(p.proof),
          heroBridge: p.heroBridge && { ...p.heroBridge, merchantKey: k(p.heroBridge.merchantKey) },
          receipt: p.receipt && {
            ...p.receipt,
            lines: p.receipt.lines.map(({ mergedKeys, ...l }) => {
              const key = k(l.merchantKey);
              const mk = merged(key, mergedKeys);
              return { ...l, merchantKey: key, ...(mk ? { mergedKeys: mk } : {}) };
            }),
          },
        },
      };
    }
    case "baseline_ready":
      return { ...ev, suggestions: ev.suggestions.map((x) => ({ ...x, merchantKey: k(x.merchantKey) })), proof: proof(ev.proof), proofRuns: ev.proofRuns?.map((p) => proof(p)!) };
    default:
      return ev;
  }
}

export function buildRequest(s: FlowState, mode: AgentMode = "sametaste"): AgentRequest {
  if (!s.location) throw new Error("Location is required before running the agent.");
  if (!s.merchants.length) throw new Error("Load a statement first.");
  const req: AgentRequest = {
    mode,
    location: s.location,
    merchants: s.wireMerchants && isFirstAsk(s, mode) ? s.wireMerchants : s.merchants.map(toWire),
  };
  // The persona id lets the server replay the recorded first pass; an answer,
  // reject or re-plan omits it so it always reaches the live agent.
  const followUp = mode === "sametaste" && !!(s.answers.length || s.feedback.length || s.plan);
  if (s.personaId && !followUp) req.personaId = s.personaId;
  if (mode === "sametaste") {
    if (s.answers.length) req.answers = s.answers;
    if (s.feedback.length) req.feedback = s.feedback;
    // The server is stateless: send the last plan with the user's current verdicts.
    if (s.plan) req.previousPlan = { ...s.plan, swaps: s.swaps };
  }
  return req;
}
