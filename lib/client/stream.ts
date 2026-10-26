/**
 * Streaming client for `POST /api/agent` (NDJSON, one `AgentEvent` per line).
 * Framework-free so it can be unit-tested; `useAgentFlow` wraps it for React.
 */
import {
  AGENT_ENDPOINT,
  AgentEventSchema,
  AgentRequestSchema,
  CONTRACT_VERSION,
  type AgentEvent,
  type AgentRequest,
} from "../contract";

export class AgentHttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryable: boolean,
  ) {
    super(message);
    this.name = "AgentHttpError";
  }
}

export type AgentStreamErrorCode = "malformed" | "truncated" | "no_body";

export class AgentStreamError extends Error {
  constructor(
    public code: AgentStreamErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentStreamError";
  }
}

export interface StreamOptions {
  signal?: AbortSignal;
  fetch?: typeof fetch;
  endpoint?: string;
  /** Called for lines that are valid JSON but not a known event (e.g. a newer contract). */
  onUnknown?: (value: unknown) => void;
}

/** Validate and stamp the request; throws a ZodError for bad input. */
export function prepareRequest(req: AgentRequest): AgentRequest {
  const parsed = AgentRequestSchema.parse({ ...req, version: CONTRACT_VERSION });
  return parsed;
}

/** Parse one line. Unknown event shapes are reported and skipped, not fatal. */
function parseLine(line: string, onUnknown?: (v: unknown) => void): AgentEvent | null {
  const t = line.trim();
  if (!t) return null;
  let value: unknown;
  try {
    value = JSON.parse(t);
  } catch {
    throw new AgentStreamError("malformed", "The agent sent a line that is not JSON.");
  }
  const r = AgentEventSchema.safeParse(value);
  if (r.success) return r.data;
  onUnknown?.(value);
  return null;
}

async function httpError(res: Response): Promise<AgentHttpError> {
  let message = `Agent request failed (${res.status}).`;
  try {
    const body = await res.text();
    const first = body.split("\n").find((l) => l.trim());
    if (first) {
      const j = JSON.parse(first) as { message?: unknown; error?: unknown };
      const m = typeof j.message === "string" ? j.message : typeof j.error === "string" ? j.error : null;
      if (m) message = m;
    }
  } catch {
    // keep the generic message
  }
  return new AgentHttpError(res.status, message, res.status === 429 || res.status >= 500);
}

/**
 * POST the request and yield events as they arrive. Ends after `done`.
 * Throws AgentHttpError for non-2xx, AgentStreamError if the stream is cut
 * before `done`, and the fetch AbortError if `signal` aborts.
 */
export async function* streamAgent(req: AgentRequest, opts: StreamOptions = {}): AsyncGenerator<AgentEvent> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(opts.endpoint ?? AGENT_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/x-ndjson" },
    body: JSON.stringify(prepareRequest(req)),
    signal: opts.signal,
  });
  if (!res.ok) throw await httpError(res);
  if (!res.body) throw new AgentStreamError("no_body", "The agent returned no stream.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let done = false;
  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const ev = parseLine(line, opts.onUnknown);
        if (!ev) continue;
        yield ev;
        if (ev.type === "done") {
          done = true;
          break;
        }
      }
    }
    if (!done) {
      buf += decoder.decode();
      const ev = parseLine(buf, opts.onUnknown);
      if (ev) {
        yield ev;
        done = ev.type === "done";
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  if (!done) throw new AgentStreamError("truncated", "The agent stopped before finishing. Try again.");
}
