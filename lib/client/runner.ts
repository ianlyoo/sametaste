/**
 * Pumps one agent stream into the flow reducer. Kept outside the React hook so
 * it can be tested with a fake fetch.
 */
import { ZodError } from "zod";
import type { AgentMode, AgentRequest } from "../contract";
import type { FlowAction, RunError } from "./flow";
import { AgentHttpError, AgentStreamError, streamAgent, type StreamOptions } from "./stream";

export function toRunError(e: unknown): RunError {
  if (e instanceof AgentHttpError) {
    if (e.status === 429) return { code: "rate_limited", message: "Too many runs right now. Wait a minute and try again.", retryable: true };
    return { code: e.status >= 500 ? "server" : "bad_request", message: e.message, retryable: e.retryable };
  }
  if (e instanceof AgentStreamError) return { code: e.code, message: e.message, retryable: true };
  if (e instanceof ZodError) return { code: "bad_request", message: "This statement couldn't be turned into a valid request.", retryable: false };
  if (e instanceof TypeError) return { code: "network", message: "Couldn't reach the agent. Check your connection and try again.", retryable: true };
  return { code: "internal", message: e instanceof Error ? e.message : "Something went wrong.", retryable: true };
}

/** Stream `req` and dispatch every event; on failure dispatch `run_failed`. Aborts are silent. */
export async function pumpRun(
  req: AgentRequest,
  mode: AgentMode,
  ticket: number,
  dispatch: (a: FlowAction) => void,
  opts: StreamOptions = {},
): Promise<void> {
  dispatch({ type: "run_requested", mode, ticket });
  try {
    for await (const event of streamAgent(req, opts)) dispatch({ type: "event", mode, ticket, event });
  } catch (e) {
    if (opts.signal?.aborted) return;
    dispatch({ type: "run_failed", mode, ticket, error: toRunError(e) });
  }
}
