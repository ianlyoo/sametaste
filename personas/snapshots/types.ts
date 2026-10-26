import type { AgentEvent, Location, MerchantAggregate } from "../../lib/contract";

/**
 * A recorded persona run, bundled so the production fallback replays exactly
 * the events /demo replays (eval/fixtures/<persona>.*). Written by
 * `npm run eval:record-demo`; never edited by hand.
 */
export interface PersonaSnapshot {
  version: 1;
  personaId: string;
  recordedAt: string;
  qlooMock: boolean;
  /** What the browser sent when it was recorded (the client's own aggregation). */
  request: { location: Location; merchants: MerchantAggregate[] };
  sametaste: AgentEvent[];
  llm_only: AgentEvent[];
  /** Re-plan after rejecting one swap, keyed by that swap's id. */
  replans: Record<string, AgentEvent[]>;
}
