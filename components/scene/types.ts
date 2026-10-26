/**
 * CounterScene interface (scene lead owns this file; the app worker builds against it).
 *
 * The scene is the round-3 "B Counter": a thermal receipt lying on a stone
 * counter, polaroids of the places, a red pen that writes each taste twin
 * under its line, a scroll-driven camera through five sections, a second
 * receipt ("A MODEL ALONE") for the proof.
 *
 * Data flows one way: the app passes the flow state from `useAgentFlow`
 * (`data={state}`) and the scene derives everything it draws from it. The
 * scene never computes a total of its own: it prints `plan.receipt` /
 * `plan.totals` when present, and before that the sum of the statement rows.
 * User intent comes back through the callbacks.
 */
import type { FlowState } from "../../lib/client/flow";
import type { Answer, ProofSide } from "../../lib/contract";

/** The imperative API, through `ref`: × and the nav call these. */
export interface CounterSceneHandle {
  /** Back to the door: scrolls to the top and puts the timeline at t = 0 at once (the pen at rest, the ink and papers as before the start). The data stays; a new file comes through `data`. Use this on × instead of a remount. */
  reset(): void;
  /** Scroll to a section (smooth, unless `instant`). */
  seek(section: SceneSection | number): void;
}

/** The five camera stops, in scroll order. */
export type SceneSection = "statement" | "understood" | "swaps" | "november" | "proof";
export const SCENE_SECTIONS: readonly SceneSection[] = ["statement", "understood", "swaps", "november", "proof"];

/**
 * The scroll track: each stage between two stops owns this many viewport heights of scroll (PM, v4). The writing stage
 * (Understood → Swaps) is long enough for a hand to write continuously under the pen's speed cap (3% of the frame's width
 * per frame, 0.85 of it used): the pen's path through the writing is ~10,400 screen px at 1920 (two thirds of it the returns
 * between lines; 3.5 s at the cap) and ~4,700 px at 390, where the cap is a fifth (7.9 s at the cap). 5.5 viewports on a PC
 * lets a trackpad burst (~1,900 px/s) and 10 on a phone a touch drag (800 px/s) pass with no backlog past 0.3 s; normal
 * scrolling writes at about half the cap. The other stages stay one viewport each, so the story does not drag.
 * A phone (portrait) has one more stop: the proof's second viewport (the model-alone receipt).
 */
export const STAGE_VH: { readonly landscape: readonly number[]; readonly portrait: readonly number[] } = { landscape: [1, 5.5, 1, 1], portrait: [1, 10, 1, 1, 1] };
export const stageLengths = (portrait: boolean): readonly number[] => (portrait ? STAGE_VH.portrait : STAGE_VH.landscape);
/** Where section i starts, in viewport heights from the scene's top. */
export function sectionTopVh(i: number, portrait: boolean): number { const L = stageLengths(portrait); let s = 0; for (let k = 0; k < Math.min(i, L.length); k++) s += L[k]; return s; }
/** The scene's whole scroll space in viewport heights: the stages, plus the last stop's own viewport. */
export const trackVh = (portrait: boolean): number => sectionTopVh(99, portrait) + 1;
/** The timeline point (in sections: 1.5 is halfway from Understood to Swaps) of a scroll position in viewport heights. */
export function sectionAtVh(vh: number, portrait: boolean): number {
  const L = stageLengths(portrait); let s = 0;
  for (let k = 0; k < L.length; k++) { if (vh < s + L[k]) return k + Math.max(0, vh - s) / L[k]; s += L[k]; }
  return L.length + Math.max(0, vh - s);
}

/**
 * The slice of `FlowState` the scene reads. `useAgentFlow().state` satisfies
 * it as is, so the app can pass the whole state.
 *
 * - `statement`, `merchants`: the rows printed on the receipt (browser-parsed).
 * - `resolutions`: cleaned names and addresses once the agent resolved them.
 * - `swaps`, `replanning`: the pen writes a twin when a swap arrives; while a
 *   merchant key is in `replanning` the pen hovers over that line.
 * - `plan`: November section (plan.receipt lines, plan.totals), one shared total.
 * - `fingerprint`: the "READ AS TASTE" block and the Understood panel.
 * - `baseline.suggestions`: the "A MODEL ALONE" receipt in the proof section.
 * - `run`: phase and status, for the hover/printing states.
 */
export type SceneData = Pick<
  FlowState,
  | "statement"
  | "merchants"
  | "resolutions"
  | "swaps"
  | "plan"
  | "fingerprint"
  | "replanning"
  | "run"
  | "question"
  | "location"
  | "personaId"
> & {
  /** `baseline.proof` (contract 1.3, from `baseline_ready.proof`) is the model's side of the measured proof; `plan.proof` is ours. `proofRuns` (1.6): every model-alone run, whose spread the paper prints. */
  baseline: FlowState["baseline"] & { proof?: ProofSide; proofRuns?: ProofSide[] };
};

export interface CounterSceneProps {
  data: SceneData;
  /** Click a written line: the swap is rejected and the agent re-plans (the pen re-writes that line). */
  onReject: (swapId: string, reason?: string) => void;
  /** Click a rejected line again: take the swap back. */
  onUndo?: (swapId: string) => void;
  /** The scene shows no question UI itself; it is here so a printed "?" line can answer a confirm question later. */
  onAnswer?: (answer: Answer) => void;
  /**
   * Controlled section. When set, the camera goes there and scrolling is
   * ignored; when unset, the scene owns a scroll space and drives the camera
   * from `scrollY` (round-3 behaviour).
   */
  section?: SceneSection;
  /** Fired when the camera settles on a section (scroll or nav click). */
  onSectionChange?: (section: SceneSection) => void;
  /** The imperative API (reset, seek). The timeline is scroll-driven everywhere: `t` follows the scroll space through a critically damped spring and settles exactly on it. */
  ref?: React.Ref<CounterSceneHandle>;
  /**
   * `page` (default): the scene fills the viewport and owns a 500vh scroll
   * space; the app places its surfaces in the overlay slots.
   * `embed`: a fixed-height block, no scroll space, sections by prop only.
   */
  variant?: "page" | "embed";
  /** Skip the printing, writing and camera animations (also `?instant` in the URL). */
  instant?: boolean;
  /** Force the reduced-motion path; defaults to `prefers-reduced-motion`. */
  reducedMotion?: boolean;
  /** Where `public/scene` is served from. Default "/scene". */
  assetBase?: string;
  /** Show `poster.jpg` (a still of the written demo receipt) under the canvas while it loads. Only right for /demo; off by default. */
  poster?: boolean;
  /** Called once the GLBs, HDRI and fonts are in and the first frame rendered. */
  onReady?: () => void;
  /** The reader reached October, the stop before the proof: the moment to start the LLM-only baseline (`runBaseline`), so its paper lies ready, blank, when the proof comes in. */
  onProofVisible?: () => void;
  /** The model-alone receipt's rows show on its paper (true), or no longer do (false). They print as the reader scrolls, so a caption that quotes them waits for this. */
  onTheirsPrinted?: (printed: boolean) => void;
  className?: string;
  /**
   * Overlay content from the app, rendered above the canvas in the four quiet
   * zones the scene keeps clear: the top bar, a text column (left of the paper,
   * moving to the right side in the proof section where the paper sits left,
   * and to the bottom over a soft fade in portrait), a "bottom" block under
   * that column, and the right column. Nothing else should be placed over the
   * canvas. `counter` is not a zone but a paper on the counter: on a wide screen the scene lays it left of the
   * receipt, level with the row the question asks about, in the frame's perspective, and keeps the polaroids out of
   * its place; it scrolls with the world (PM, v5: the question slip never covers the receipt). Not shown on a phone.
   */
  slots?: Partial<Record<SceneSlot, React.ReactNode>>;
}

/** Overlay regions the scene keeps free of objects and text, and the paper it lays on the counter (`counter`). */
export type SceneSlot = "top" | "left" | "right" | "bottom" | "counter";

/** One printed line as the scene derives it from the data; also the a11y text alternative. */
export interface SceneReceiptRow {
  id: string;
  date: string;
  /** Cleaned merchant name (resolution > local name > raw descriptor). */
  name: string;
  rawMerchant: string;
  /** Street or neighbourhood from the resolved entity, if any. */
  where?: string;
  amount: number;
  merchantKey?: string;
  /** The swap written under this line, if any. */
  swapId?: string;
  twin?: { name: string; price?: number; saving: number; status: "proposed" | "accepted" | "rejected" | "replanning" };
}

/** Receipt the scene prints, for tests and the text alternative. */
export interface SceneReceipt {
  rows: SceneReceiptRow[];
  currency: string;
  /** Sum of the rows the user sees; equals plan.totals.monthlyBefore once a plan exists. */
  total: number;
  /** After the proposed/accepted swaps; equals plan.totals.monthlyAfter once a plan exists. */
  totalAfter: number;
  saving: number;
}
