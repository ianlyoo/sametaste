import type { AgentEvent } from "../contract";

type Distribute<E> = E extends AgentEvent ? Omit<E, "runId" | "seq" | "ts"> : never;
export type AgentEventInput = Distribute<AgentEvent>;

/** Adds runId/seq/ts and hands each event to `write` (NDJSON in the route). */
export class EventSink {
  private seq = 0;
  readonly events: AgentEvent[] = [];
  constructor(
    readonly runId: string,
    private readonly write: (ev: AgentEvent) => void = () => {},
    private readonly keep = true,
  ) {}
  emit(input: AgentEventInput): AgentEvent {
    const ev = { ...input, runId: this.runId, seq: this.seq++, ts: new Date().toISOString() } as AgentEvent;
    if (this.keep) this.events.push(ev);
    this.write(ev);
    return ev;
  }
}

export function toNdjson(ev: AgentEvent): string {
  return `${JSON.stringify(ev)}\n`;
}
