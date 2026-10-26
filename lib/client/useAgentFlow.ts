"use client";

/**
 * React binding for the SameTaste flow: load a statement (parsed here, in the
 * browser), run the agent, accept / reject swaps (a reject re-plans), answer
 * questions, and run the LLM-only baseline for the compare view.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { AgentMode, Answer, Location, MerchantAggregate } from "../contract";
import { buildRequest, flowReducer, initialFlow, type FlowAction, type FlowState, type Step } from "./flow";
import { personaPayload } from "./personas";
import { pumpRun, toRunError } from "./runner";
import { MAX_STATEMENT_BYTES, parseStatement, StatementParseError } from "./statement";

export interface UseAgentFlowOptions {
  endpoint?: string;
  fetch?: typeof fetch;
}

export interface LoadOptions {
  personaId?: string;
  location?: Location;
  /** Start the agent right after parsing (it needs a location). */
  autoRun?: boolean;
  /** Send these merchants instead of the browser's aggregation (sample personas). */
  wire?: MerchantAggregate[];
}

export function useAgentFlow(opts: UseAgentFlowOptions = {}) {
  const [state, dispatch] = useReducer(flowReducer, initialFlow);
  const stateRef = useRef<FlowState>(initialFlow);
  const ticket = useRef(0);
  const controllers = useRef<Partial<Record<AgentMode, AbortController>>>({});
  const optsRef = useRef(opts);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    optsRef.current = opts;
  });
  useEffect(() => {
    const live = controllers.current;
    return () => Object.values(live).forEach((c) => c?.abort());
  }, []);

  /** Dispatch and return the resulting state, so a follow-up run sees it at once. */
  const apply = useCallback((a: FlowAction): FlowState => {
    const next = flowReducer(stateRef.current, a);
    stateRef.current = next;
    dispatch(a);
    return next;
  }, []);

  const run = useCallback(
    async (mode: AgentMode = "sametaste", from?: FlowState) => {
      const s = from ?? stateRef.current;
      const t = ++ticket.current;
      controllers.current[mode]?.abort();
      const ac = new AbortController();
      controllers.current[mode] = ac;
      let req;
      try {
        req = buildRequest(s, mode);
      } catch (e) {
        apply({ type: "run_requested", mode, ticket: t });
        apply({ type: "run_failed", mode, ticket: t, error: toRunError(e) });
        return;
      }
      await pumpRun(req, mode, t, (a) => apply(a), {
        signal: ac.signal,
        fetch: optsRef.current.fetch,
        endpoint: optsRef.current.endpoint,
      });
      if (controllers.current[mode] === ac) delete controllers.current[mode];
    },
    [apply],
  );

  const loadCsv = useCallback(
    (text: string, o: LoadOptions = {}) => {
      Object.values(controllers.current).forEach((c) => c?.abort());
      controllers.current = {};
      try {
        const statement = parseStatement(text);
        const next = apply({ type: "statement_loaded", statement, personaId: o.personaId, location: o.location, wire: o.wire });
        if (o.autoRun && next.location) void run("sametaste", next);
        return true;
      } catch (e) {
        apply({ type: "parse_failed", message: e instanceof StatementParseError ? e.message : "Couldn't read this file as CSV." });
        return false;
      }
    },
    [apply, run],
  );

  const loadFile = useCallback(
    async (file: File, o: LoadOptions = {}) => {
      if (file.size > MAX_STATEMENT_BYTES) {
        apply({ type: "parse_failed", message: "The file is larger than 5 MB. Export a single month instead." });
        return false;
      }
      return loadCsv(await file.text(), o);
    },
    [apply, loadCsv],
  );

  /** Load a bundled sample persona and run it. */
  const loadPersona = useCallback(
    (id: string, o: { autoRun?: boolean } = {}) => {
      const p = personaPayload(id);
      if (!p) return false;
      return loadCsv(p.csv, { personaId: id, location: p.location, wire: p.merchants, autoRun: o.autoRun ?? true });
    },
    [loadCsv],
  );

  const reject = useCallback(
    (swapId: string, reason?: string) => {
      const next = apply({ type: "reject", swapId, reason });
      void run("sametaste", next);
    },
    [apply, run],
  );

  const answer = useCallback(
    (a: Answer) => {
      const next = apply({ type: "answer", answer: a });
      void run("sametaste", next);
    },
    [apply, run],
  );

  const cancel = useCallback((mode: AgentMode = "sametaste") => {
    controllers.current[mode]?.abort();
    delete controllers.current[mode];
  }, []);

  return {
    state,
    start: useCallback(() => run("sametaste"), [run]),
    runBaseline: useCallback(() => run("llm_only"), [run]),
    loadCsv,
    loadFile,
    loadPersona,
    setLocation: useCallback((location: Location) => apply({ type: "set_location", location }), [apply]),
    go: useCallback((step: Step) => apply({ type: "go", step }), [apply]),
    accept: useCallback((swapId: string) => apply({ type: "accept", swapId }), [apply]),
    undo: useCallback((swapId: string) => apply({ type: "undo", swapId }), [apply]),
    reject,
    answer,
    cancel,
    reset: useCallback(() => {
      Object.values(controllers.current).forEach((c) => c?.abort());
      controllers.current = {};
      apply({ type: "reset" });
    }, [apply]),
  };
}
