/**
 * The counter scene as a plain three.js runtime (no React in here): a stone
 * counter in daylight, the receipt lying on it, the pen, the polaroids, the
 * second receipt. `setData` feeds it the flow state; it diffs the printed lines
 * and derives what the pen has to write.
 *
 * The motion model is prototype B's (design/r3/B, the build the owner picked), scene-12:
 * - scroll is the only clock: it sets a target, and `t` (in sections) glides toward it with inertia (v16, the owner: "like rolling
 *   something on ice"): a critically damped spring (FEEL.omega), so it starts from rest however fast the scroll, gathers speed, and
 *   coasts to a stop well after the reader stops, never past the target; the camera follows B's stops along the paper at `t` (on its own
 *   spring, FEEL.camOmega), and the papers print and the polaroids land as functions of `t`, never on a clock of
 *   their own;
 * - the pen writes, nothing else does: each piece of handwriting has a window on the timeline that says how far the ink
 *   *may* be at `t`; the ink itself only grows under the pen's tip, at the pen's pace, while the tip is on the paper and in
 *   frame. The ink follows `t`: as the timeline plays the pen writes at one steady pace, and the camera waits for it. The pen moves continuously, always: strokes and flights are paths, and in view the tip moves
 *   at most CAP_FRAC of the frame's width per frame (PM, v4; a flick leaves it a backlog it writes at that cap). Ink grows only
 *   while `t` plays and PEN_TAIL_S after it lands: what the cap left unwritten waits, the pen poised over the line, for the
 *   reader's next move. Scrolling back leaves the ink where it is (v6, H2: ink stays);
 * - nothing moves while the reader is still (v6, M9; v13: after the catch-up): at most CATCH_S after their last move the pen
 *   stays where it is, poised on the paper, and the camera and the polaroids hold; what changed meanwhile (data, the
 *   overlays) waits for their next move.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { FONT, HAND, Receipt, photoCard } from "./receipt";
import { RED, buildLayout, collectPriors, type PenTarget, type Prior, type SceneLayout } from "./lines";
import { flatBox, flightPose, hits, planFlight, v3, type Box, type Flight, type PenDims, type Pose, type V3 } from "./pen";
import { createSteam, type Steam } from "./steam";
import type { SceneData } from "./types";


/** What a click on a line does: a proposed or accepted twin is rejected, a rejected one is taken back; anything else is nothing. */
export function answerFor(pt: PenTarget | null): { reject: string } | { undo: string } | null {
  if (!pt || !pt.swapId) return null;
  if (pt.status === "proposed" || pt.status === "accepted") return { reject: pt.swapId };
  if (pt.status === "rejected") return { undo: pt.swapId };
  return null;
}

export interface RuntimeOptions {
  canvas: HTMLCanvasElement;
  assetBase: string;
  instant: boolean;
  reducedMotion: boolean;
  /** Camera moves by `section` only (embed / controlled). */
  controlled: boolean;
  onReady: () => void;
  onSection: (i: number) => void;
  onReject: (swapId: string) => void;
  onUndo: (swapId: string) => void;
  onProofVisible: () => void;
  /** The model-alone receipt's rows show on its paper (true) or no longer do (false): they print as the reader scrolls, so what quotes them waits for this. */
  onTheirsPrinted?: (printed: boolean) => void;
  /** Nav draft A (v13): a receipt is under the top bar, or about to be (setVeilLine); the bar's veil shows while it is. */
  onPaperUnder?: (under: boolean) => void;
}

/** What `__sceneProbe()` reports per frame (eval/motion): screen positions in CSS px of the canvas. */
export interface SceneProbe {
  t: number; target: number;
  /** The pen's tip on screen, whether it touches the paper, whether the pen is on a planned flight, and whether it has work (ink to lay). */
  pen: { x: number; y: number; touch: 0 | 1; vis: 0 | 1; /** some part of the pen (tip, barrel, cap) is in the frame */ seen: 0 | 1; flight: 0 | 1; writing: 0 | 1; inView: 0 | 1; off: number; jump: number; reverted: number; /** the pen's own screen move this frame, px (the camera's motion aside): the largest of its tip's, its middle's and its cap end's (v7) */ move: number; /** the same since the previous probe, through that probe's camera: the pen's own move between two samples, frames the probe missed included */ rel: number; /** its tip, middle and cap end on screen, px (raw: with the camera's motion) */ pts: [number, number][]; /** the barrel's screen box, px [x0, y0, x1, y1] (v9) */ box: number[]; /** the same box for each twentieth of its length, tip first */ segs: number[][]; /** the ink may grow now (within OPEN_S of the reader's last move, or a flick's allowance) */ open: 0 | 1; /** its goal is a line's head (writing, or poised on it), not a place to wait (v15) */ head: 0 | 1 };
  /** The ink head (the furthest written point) on screen, and the total inked length in paper px. */
  ink: { x: number; y: number; len: number; job: string | null; progress: number };
  /** Our receipt's printed part on screen (its points in front of the camera), and its printed length. */
  paper: { x0: number; y0: number; x1: number; y1: number; printed: number };
  /** The timeline point the camera frames (t). */
  camT: number;
  cam: { p: [number, number, number]; a: [number, number, number] };
  theirs: number;
  /** owner feedback: the model-alone receipt's whole length, the camera's own t (camShown), each polaroid's drop (0..1, linear in time) */
  theirsL: number; camShown: number; drops: number[]; gates: number[]; dropAt: number; /** the GPU programs and textures so far: a new one mid-scroll is a compile or upload stall */ progs: number; texs: number; /** v25: the camera's cap while the agent's run is going (-1: none) */ hold: number; /** v25: the most each part of a frame took (ms) since the last probe */ cost: Record<string, number>;
  /** The polaroids on the counter, summed (their positions): any change is a card moving (M9). */
  cards: number;
  /**
   * M8 (PM, v5): every printed row of both receipts on screen, [x0, y0, x1, y1, receipt (0 ours, 1 the model's), line, from TOTAL down (1/0),
   * the 3D object over it (0 none, 1 the cup, 2 the card, 3 a polaroid, 4 the other receipt; the pen is not counted)]. The page adds its DOM overlays.
   */
  rows: number[][];
  /** with `window.__probeRows`: each row's glyph boxes on screen, flat [x0, y0, x1, y1, …], in `rows`' order (v9) */
  rowGlyphs?: number[][];
}

export interface Runtime {
  setData(data: SceneData): void;
  /** Scroll position in sections (0..4), uncontrolled: `t` lags it by B's exponential. */
  /** The scroll's position in sections, and in px when known (the scroll's speed tells a flick). */
  setScroll(p: number, px?: number): void;
  /** Controlled section. */
  setSection(i: number): void;
  /** Height in px of the app's top strip over the canvas (the phone's framing keeps each section's first paper line clear of it). */
  setTopInset(px: number, rightPx?: number): void;
  /** Height in px of the app's bottom-anchored overlay (the phone's captions); the phone's framing keeps its last needed row above it. */
  setBottomInset(px: number): void;
  /** The top bar's foot in px (the strip's veil; -1: none): onPaperUnder tells when a receipt nears it. */
  setVeilLine(px: number): void;
  /** The phone's front door (v10): the band of the screen, px, the page keeps for our paper between its cards; the camera puts the paper's
   *  printed part in its middle (null: the sections' framing). Returns the printed part's height on screen there, for the page to size the band. */
  /** The phone's front door (v10): the page's slot for our paper's printed head, px from the top; the scene frames the head in its middle
   *  and tells the page the head's height on screen (onHeight: now, and whenever it changes), so the page can size the slot to it. */
  setDoorSlot(slot: { top: number; bottom: number } | null, onHeight?: (px: number) => void): void;
  /** Where the wide screen's caption puts ink (px: its right end and its lowest line), or null: the frame keeps our paper right of it. */
  setCaptionBox(r: { x1: number; y1: number } | null): void;
  /** The wide screen's caption column: hidden on the frames where the camera, still on its way, has our paper under its ink. */
  setCaptionEl(el: HTMLElement | null): void;
  /** The pointer over the canvas in NDC and px; `mouse` false for a touch or pen (no hover tags), or when it left. */
  setPointer(x: number, y: number, clientX: number, clientY: number, mouse?: boolean): void;
  /** The mouse parallax's target (-1..1 across the window; 0 when the mouse leaves it): the camera eases toward it. */
  setLook(x: number): void;
  /** The hover tag's element: the runtime writes its text and places it beside the paper, level with the row (never over row text). */
  setTipEl(el: HTMLElement | null): void;
  /** The question slip's element (landscape): laid on the counter left of the receipt, level with the row it asks about, in the frame's perspective. */
  setSlipEl(el: HTMLElement | null): void;
  /** The quiet "asking…" mark: placed where the model-alone receipt will lie while its data is on its way (v6, M4), within `clip` (px of the frame's top and bottom bands). */
  setAskEl(el: HTMLElement | null, clip?: { top: number; bottom: number }): void;
  /** The reader scrolled where the page can't (a wheel or a drag past the end), px: input like a scroll's, for the model-alone receipt's late print. */
  nudge(px: number): void;
  /** What the reader scrolls with: a touch or a wheel/trackpad/key (v13: both play the same eased timeline). */
  input(kind: "touch" | "wheel"): void;
  click(): void;
  resize(): void;
  savePng(): void;
  /** Back to the door: t = 0 at once, the pen at rest; the data stays. */
  reset(): void;
  /** The timeline's target to a section (a nav click when the page is not scrolled there). */
  seek(section: number): void;
  readonly layout: SceneLayout | null;
  /** Numbers for automation and bug reports. */
  debug(): Record<string, unknown>;
  /** The motion probe (eval/motion). */
  probe(): SceneProbe;
  /** Every frame's pen pose since start, the objects' bounds and the live collision count: the recorder saves it for the tests. */
  penLog(): PenLog;
  dispose(): void;
}

/**
 * The pen's recorded frames: tip, direction, the index of the box set on the counter in that frame (`sets`, so a replay
 * checks each frame against its own obstacles), 1 while the pen is on a planned flight (lifted, moving between places), and `t`.
 */
export interface PenLog { dims: PenDims; boxes: Box[]; sets: Box[][]; frames: [number, number, number, number, number, number, number, number, number][]; collisions: number; first: { t: number; hit: string[]; tip: V3 }[] }
const N = 5;
/**
 * The objects at the sizes B framed them on screen (the composition the owner picked), whatever units a file is in:
 * B's cup and saucer were 0.605 wide, its card 0.813 and its pen 1.09 long. Each file is scaled on its own to that
 * size when it loads (the round-5 files are physical metres, assets3d/r5/README.md; the round-3 fallbacks land at
 * the same sizes), and the pen's capsule from glb/dims.json is scaled with it.
 */
const B_SIZE = { cup: 0.605, card: 0.813, pen: 1.09 } as const;
/** The pen model's axis is +y with the tip at the origin (round 5). Its length and radius come from glb/dims.json, the README's numbers; the file's own bounds are the fallback. */
const PEN_UP = new THREE.Vector3(0, 1, 0);
const WRITE_DIR: V3 = v3.norm([0.565, 0.724, 0.396]); // held for writing as B held it (rotation x 0.5, z -0.6): cap to the right and toward the reader, ~46° off the paper, so it lies low across the amounts and not over the rows above
const REST_DIR: V3 = v3.norm([-0.08, 0, 0.997]); // lying along the paper's left edge, cap toward the reader (B's rest rotation)
const SLIP_FADE = 48; // px: the question slip fades out over this much of the frame above the strip's foot (v11, F1)
// v12 (LOW): it shows or goes in time, never resting part-faded: gone once its head is within SLIP_FADE px of the strip's foot, back
// past SLIP_FADE + SLIP_HYST px; the change takes SLIP_FADE_S s
const SLIP_HYST = 8, SLIP_FADE_S = 0.16;
// nav draft A (v13, M8): the strip's veil comes up as a receipt nears the top bar's foot, VEIL_LEAD px off it plus the way the paper
// goes in VEIL_LEAD_S s at its speed on screen, or at any of the VEIL_PATH points on t's way to its target (the veil takes 0.5 s to come up: it
// is up before a row reaches the bar), and goes VEIL_HYST px back
const VEIL_LEAD = 40, VEIL_LEAD_S = 0.3, VEIL_HYST = 16, VEIL_PATH = [0.25, 0.5, 0.75, 1];
const PANEL_CLEAR = 48; // px: a wide screen's resting pen stays this far below the strip's reach over the right half (its halo's blur)
const PAPER_Y = 0.018, REST_X = -1.6, REST_Z = 1.9; // B's rest: beyond the polaroids at the frame's left edge (x -1.6), its z following the paper's end (B: printed - 0.42)
/* the counter as the owner picked it in B: the cup lower-left, the card upper-right, both fixed in the world */
const CUP_AT: V3 = [-1.12, 0, 0.78], CARD_AT: V3 = [1.4, 0, 0.06]; // B's spots; the card a little in from B's so its far corner stays whole at 1920
/** Model dimensions as the asset README states them, in metres (public/scene/glb/dims.json). */
interface ModelDims { pen?: { length: number; radius: number; tipOffset?: number }; cup?: { radius: number; height: number }; card?: { x: number; y: number; z: number } }
const STRIP_H = 224; // a row, a scribbled twin, the twin, its evidence and the bridge
/** On a phone the proof takes two viewports of scroll: our plan block first, the model-alone receipt on the second (PM, scene-10). */
const PHONE_PROOF_EXTRA = 1;
/** On a phone the model-alone receipt starts this far past our paper's end (room for our curl). */
const THEIRS_GAP_P = 0.3;
const NAV_CLEAR = 14, BOT_CLEAR = 10; // px: the framing keeps a section's first needed line under the strip by this, its last above the bottom band by this (both hard edges the canvas is cut at: v6, H4)
const ZOOM_MAX_P = 1.3; // how far the phone's camera may back off to fit a section's rows between the two overlays (landscape never backs off: B's framing)
const PROOF_BACK = 1.3; // how far the wide proof's camera may back off to keep both papers' tails in the frame (v13, 2)
const SIDE_CLEAR = 10, SIDE_BACK = 1.6; // px: on a phone each paper's side edges stay this far inside the screen, the camera backing off up to SIDE_BACK for it (v13, 2)
/* ---------- the timeline's constants (t in sections, 0..4) ---------- */
// at ~2-3 sections/s, the writing visible, instead of 1:1 with the scroll
/**
 * The feel (v16: inertia, not a speed cap): every knob of how t and the pen follow the scroll, in one place for quick tweak rounds.
 * t follows the scrolled target as a critically damped spring of `omega` (1/s): from rest it eases in (its speed grows from 0 whatever the
 * input), peaks 1/omega in, and coasts to the target without overshoot, 95% there by 4.7/omega (1.6 s at 3), 99% by 6.6/omega (2.2 s).
 * Lower omega = more ice (longer glide), higher = firmer. A wheel notch drifts over ~1 s instead of snapping.
 */
export const FEEL = {
  omega: 2.0, // 1/s: the spring's stiffness (prototype B's first-order follower was 6, with no eased start); owner feedback: softer, slower
  vMax: 1.0, // sections/s: t's speed saturates softly here (tanh), so however fast the scroll it plays slowly
  landT: 3e-4, landV: 3e-3, // sections, sections/s: under both t has landed (snaps to the target, sub-pixel)
  openS: 0.2, // s after the reader's last scroll move the ink may still grow on its own (while t glides it is open anyway)
  flickOpenS: 0.9, // s: the same after a flick (FLICK_PX_S)
  tailS: 0.5, // s: once t has landed the pen may finish what t put in front of it for this long, its hand easing to a stop
  catchS: 1.8, // s: past this after the later of the reader's last move and t's landing, nothing moves (no auto play)
  // the handwriting
  penPxS: 480, // paper px of ink per second at the pen's calmest (v23: 400, v18: 420, v16: 700)
  strikePace: 1.6, strikeEasePx: 40, // a strike-through is one quick slash: this times the pace, its ends eased over this many px (#511: 0.8 s each)
  capFrac: 0.0282, // the hand's speed cap: its tip's own move per frame, as a share of the frame's width (v16: 0.03)
  handAcc: 0.08, // from a pause the hand speeds up by this share of its cap a frame (~0.2 s; v16: 0.25)
  handEaseS: 0.5, // s: once t has landed the hand slows to a stop over the allowance's last this (v16: 0.25)
  strokeEasePx: 70, // paper px: each line's ink starts and ends slow, its pace easing over this much of its start and end
  strokeMin: 0.3, // the pace at a line's very start and end, as a share of its full pace
  // owner feedback: one steady pace (penPxS, eased strokes), never a catch-up burst; only the moves between lines are quicker
  hopSpeed: 3.1, // a move between lines plays its planned arc this many times faster (the arc's own time: 0.3 s + 0.3 s/m, at most 0.9 s)
  hopCapK: 1.6, hopAcc: 0.2, hopBrake: 2.6, // its own cap (times the hand's), its speed-up a frame (share of the hand's cap), its brake (px/frame²)
  // owner feedback: the camera follows the pen: it frames min(t, the t the pen's ink has reached), on its spring, so it never runs down the paper
  // (or turns to October) while the pen still writes above
  camLead: 0.02, // sections the camera may lead the pen's ink
  camFreeS: 1.5, // s: a pen that has work but lays no ink this long (a head the frame cannot show) no longer holds the camera
  // v25 (review rows 9/11): when what held the camera lets go (the pen done, the run done) with the scroll far ahead, the camera's t moves on
  // at a capped pace through every stop between, eased at both ends, not in one swoop
  camCatchGap: 0.06, // sections: a jump in the camera's goal past this is caught up at the capped pace
  camCatchV: 0.55, camCatchA: 0.6, // sections/s, sections/s²: that pace, and its ease in and out
  stepGrow: 1.2, // a writing step's screen move is at most this times the last frame's (+1 px): no leap across the gaps between words (#502)
  hopLift: 0.01, hopClear: 0.012, // m: a flight's least arc, and its clearance over what it passes (#504: was 6-10 cm and 3 cm; it hopped)
  brake: 1.26, // px/frame²: a move between lines slows into its landing at this (v = sqrt(2 a d)), never stopping dead off the cap (#502)
  lookK: 4, // 1/s: the mouse parallax eases toward the pointer over the whole window, the door's cards included, and back when it leaves (#502)
  // the polaroids: t spans, so they follow the glide
  // owner feedback: the camera comes down first, then the photos: each waits for the camera's own t (camShown: where the frame is, not where the
  // scroll is) to reach its stage, then drops over cardDropS, the next one starting once the one before is cardStagger down
  cardsCamT: 0.98, // the camera's t past which the reader's own places drop: the camera all but settled on the rows they lie beside (Swaps, t 1)
  cardDropS: 0.9, cardStagger: 0.4, // s a drop takes; the share of the one before that is down before the next starts
  cardFall: 0.32, // m above the counter a drop starts (v16: 0.6)
  cardFade: 0.45, // the first share of a drop over which a polaroid fades in (no pop)
  cardClear: 0.012, // m: a dropping (or lifted) polaroid passes at least this under the pen's barrel
  lieGap: 0.07, lieTurn: 0.06, // m right of our paper's edge the laid-down pen's barrel lies; its turn off the paper's axis (dx per dz)
  // the entrance from the front door after a pick: the camera eases onto the first stop on a critically damped
  // spring and the paper prints out to its length, once, then everything waits for the reader's scroll
  enterOmega: 2.4, // 1/s: the camera's spring
  camOmega: 4.0, // 1/s: the camera's spring on the stops' path as t plays (#503: smooths the path's kinks and speed bursts; lags t by ~2/camOmega s)
  enterS: 1.6, // s: the paper printing out to the statement's length
  // owner feedback: the model-alone receipt prints on its own clock once the camera reaches Proof (not scrubbed by the scroll; never un-printed)
  theirsS: 2.6, // s: its one eased print-out
  theirsRowsS: 2.0, // s: its rows, when its answer came in on the blank paper after the print-out
  evLag: 0.12, evFeather: 70, // the printed lines under a twin (Qloo's numbers) come in behind the pen: this share of its line late, a soft edge this wide (px)
};
const CATCH_S = FEEL.catchS, PEN_TAIL_S = FEEL.tailS, OPEN_S = FEEL.openS, FLICK_OPEN_S = FEEL.flickOpenS, PEN_PX_PER_S = FEEL.penPxS;
const CAP_FRAC = FEEL.capFrac, FLICK_ACC = FEEL.handAcc, FLICK_EASE_S = FEEL.handEaseS;
const CAM_SNAP = 1e-3;
const CAM_STEP = 0.15; // m per 60 Hz frame, the eye's and the aim's moves together: a flick's camera travels, it never jumps (the harness's M3 bound is 0.2)
const CARD_FALL = FEEL.cardFall; // m above the counter a polaroid starts its drop (B's 1.4 put its shadow across the paper as a grey slab)
const T_W0 = 1.0, T_W1 = 2.0; // the handwriting's range on the timeline: Understood through Swaps; the camera follows the rows being written
const WRITE_ZOOM = 0.9; // the landscape camera's offset shrinks to this through the writing (owner: the receipt and the pen's working area fill the frame while it writes)
const ZOOM_IN = 0.2, ZOOM_OUT = 0.4; // t before T_W0 the zoom starts easing in, and past the windows' end it has eased out (the last lines are written just past it as t settles)
const PAPER_END_REACH = 0.9; // m past the aim where the frame's bottom edge meets the counter at the writing zoom: through the writing the aim stays at least this short of the paper's end, so no bare counter shows under it
const SLOT_MIN = 0.05; // one piece of handwriting's smallest window
const FLIGHT_MIN_S = 0.034; // a hurried flight still takes two frames
const FLICK_PX_S = 2500, FLICK_WIN_MS = 100; // a flick (scroll at or over FLICK_PX_S over FLICK_WIN_MS) lets the pen finish its backlog within FLICK_OPEN_S (PM, v4: 1.2 s; v8: settled under 1 s)
const PHONE_LIFT = 0.6; // rad: the phone's pen off the paper (v9, H2): its barrel runs along its own line to the right on screen (writeDir)
const PHONE_PEN = 0.72; // the pen's size on a phone (v9 ruling): its barrel ~18 px tall at 390, about one printed line (desktop 1)
const CAP_MARGIN = 0.85; // the hand's speed cap (PM, v4; FEEL.capFrac): in view, the tip's own move (the camera's aside) is at most that share of the frame's width per frame; the margin keeps the probe's rounding under it
const HEAD_TOL = 0.012; // m: the tip is "on the ink head" within this; only then does the ink grow (12 px on a 1920 frame)
const HOVER = 0.03; // m the tip lifts off the paper while the pen waits between lines
const PARK_IN = 0.022; // m: the waiting pen's tip in from our paper's right edge (the margin right of the amounts: 48 of 1024 px)
const T_NEXT0 = 2.4, T_NEXT1 = 2.9; // the next month's block prints
const T_PROOF0 = 3.45; // the camera's t at which the model-alone receipt prints (on its own clock, FEEL.theirsS)
const JUMP = 0.06; // m: a goal further than this from the pen (in one frame) is reached by a planned flight, never a step (the continuity bound of the pen test)
const TH_HEAD = 3; // the model-alone receipt's header lines (its head, the sub line, the dots): what its blank paper shows while it is asked for
const THEIRS_DIM = "#5a544b"; // the model-alone receipt's grey: the evidence grey of our paper, readable at 390 (owner, round 5)
/** A piece of handwriting's window on the timeline: how far the ink may be at t. `late`: pinned where the reader was when it came (a click's answer). */
interface Win { t0: number; t1: number; late: boolean }

/**
 * The CSS transform (matrix3d, transform-origin 0 0) that maps a w × h box onto a quad on screen (corners clockwise from the top-left): the
 * projective map of the unit square onto the quad (Heckbert), after scaling the box to the unit square.
 */
export function homography(w: number, h: number, q: [number, number][]): string {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3, den = dx1 * dy2 - dx2 * dy1 || 1e-9;
  const g = (sx * dy2 - dx2 * sy) / den, k = (dx1 * sy - sx * dy1) / den;
  const a = x1 - x0 + g * x1, b = x3 - x0 + k * x3, d = y1 - y0 + g * y1, e = y3 - y0 + k * y3;
  const m = [a / w, d / w, 0, g / w, b / h, e / h, 0, k / h, 0, 0, 1, 0, x0, y0, 0, 1];
  return `matrix3d(${m.map((v) => +v.toPrecision(9)).join(",")})`;
}

/** B's counter: a quiet warm stone, drawn once (the round-5 terrazzo maps were tried and read as gravel at this framing). */
function stoneTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = c.height = 1024; const g = c.getContext("2d")!;
  g.fillStyle = "#ddd5c7"; g.fillRect(0, 0, 1024, 1024);
  let s = 7; const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 26000; i++) { g.fillStyle = `rgba(${(90 + rnd() * 60) | 0},${(80 + rnd() * 50) | 0},${(60 + rnd() * 40) | 0},${rnd() * 0.08})`; const r = rnd() * 3; g.fillRect(rnd() * 1024, rnd() * 1024, r, r); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 3); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}

async function loadFonts(base: string): Promise<void> {
  if (typeof FontFace === "undefined") return;
  const faces: [string, string, string][] = [
    ["IBM Plex Mono", "IBMPlexMono-400.woff2", "400"], ["IBM Plex Mono", "IBMPlexMono-600.woff2", "600"],
    ["Caveat", "Caveat-600.woff2", "600"], ["Instrument Sans", "InstrumentSans.woff2", "400 700"],
  ];
  await Promise.all(faces.map(async ([family, file, weight]) => {
    try { const f = new FontFace(family, `url(${base}/fonts/${file})`, { weight }); await f.load(); document.fonts.add(f); } catch { /* fall back to system fonts */ }
  }));
}

/** A polaroid: a twin's (by swap id, dropped when the pen finishes its line) or the reader's own place's ("orig:<key>", dropped as the agent reads). */
interface Card { id: string; key: string; orig: boolean; /** index among the reader's own places (their drop order) */ k: number; /** order on the counter (the column and slot) */ i: number; zBase: number; m: THREE.Mesh; home: THREE.Vector3; /** where it lies now: eases to `home` when the slip moves a landed card aside */ at: THREE.Vector3 | null; rz: number; live: boolean; goneAt: number; lift: number; y: number; /** its drop, 0..1 linear in time */ dv: number }
/**
 * One piece of handwriting, each a single continuous stroke path for the pen: the strike through a row's amount, the twin line
 * (text + saving), the bridge line, or the scribble that takes a twin out. `tw`: the ink's length in paper px.
 */
interface Job { kind: "strike" | "twin" | "bridge" | "scribble"; t: PenTarget; li: number; text: string; save: string; seq: string; color: string; x0: number; font: string; tw: number }

export function createRuntime(o: RuntimeOptions): Runtime {
  const RM = o.reducedMotion || o.instant;
  const canvas = o.canvas;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; // r18x: PCFSoftShadowMap is gone (it warned and used this)
  renderer.debug.checkShaderErrors = false; // no sync program-status reads at compile (#511: the first photos' frames); D3D's X4122 notes were console warnings (G5)
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0xe8e2d6); scene.fog = new THREE.Fog(0xe8e2d6, 6, 14);
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);

  const table = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.MeshStandardMaterial({ map: stoneTexture(), roughness: 0.85, metalness: 0 }));
  table.rotation.x = -Math.PI / 2; table.position.set(0, -0.002, 2); table.receiveShadow = true; scene.add(table);

  // daylight as in B: a high warm sun with soft short shadows, a sky fill and a cool bounce
  scene.add(new THREE.HemisphereLight(0xfff6e8, 0xa89a86, 0.75));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.4); sun.position.set(2.5, 6, 3.5); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -4; sun.shadow.camera.right = 4; sun.shadow.camera.bottom = -4; sun.shadow.camera.top = 7; sun.shadow.camera.near = 1; sun.shadow.camera.far = 16; sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.01; sun.shadow.radius = 4; scene.add(sun);
  const bounce = new THREE.DirectionalLight(0xdfe8ff, 0.5); bounce.position.set(-3, 3, -2); scene.add(bounce);
  // warm light on the coffee (owner, #354), two lamps: a warm fill from the viewer's side of the cup (its reflection on the
  // crema heads away from every camera, so it only warms the cup's body and the coffee), and a weak gleam lamp at the mirror
  // of the first sections' camera about the cup, whose golden glint sweeps the crema as the camera backs off from Statement to
  // Understood (18 cd burnt the clearcoat to a white blob there; a few candela read as a gleam). Tight pools, no shadows.
  const warm = new THREE.SpotLight(0xffc383, 12, 7, 0.26, 0.8, 2); warm.position.set(CUP_AT[0] + 0.7, 2.3, CUP_AT[2] + 2.2);
  warm.target.position.set(CUP_AT[0], 0.2, CUP_AT[2]); scene.add(warm, warm.target);
  const gleam = new THREE.SpotLight(0xffd9a6, 2.5, 7, 0.18, 0.7, 2); gleam.position.set(CUP_AT[0] - 1.1, 2.6, CUP_AT[2] - 2.4);
  gleam.target.position.set(CUP_AT[0], 0.2, CUP_AT[2]); scene.add(gleam, gleam.target);

  // environment light: Poly Haven "Lebombo" (CC0), through PMREM
  const pmrem = new THREE.PMREMGenerator(renderer);
  const hdriDone = new Promise<void>((resolve) => {
    new HDRLoader().load(`${o.assetBase}/hdri/lebombo_1k.hdr`, (hdr) => {
      const env = pmrem.fromEquirectangular(hdr).texture; hdr.dispose(); scene.environment = env; scene.environmentIntensity = 0.25; scene.environmentRotation.set(0, 1.2, 0); resolve();
    }, undefined, () => resolve());
  });

  /* objects: round-5 assets from public/scene/glb, round-3 GLBs as fallback; each scaled to B's on-screen size */
  const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
  const objs: Record<string, THREE.Object3D> = {}, scales: Record<string, number> = {};
  function glb(name: string, pos: [number, number, number], rot: [number, number, number], fit: (b: THREE.Box3) => number): Promise<void> {
    const place = (g: { scene: THREE.Group }) => {
      const m = g.scene; m.updateMatrixWorld(true); const s = fit(new THREE.Box3().setFromObject(m, true)); scales[name] = s;
      m.position.set(...pos); m.rotation.set(...rot); m.scale.setScalar(s); m.traverse((x) => { if ((x as THREE.Mesh).isMesh) { x.castShadow = true; x.receiveShadow = true; } }); scene.add(m); objs[name] = m;
    };
    return new Promise((resolve) => {
      loader.load(`${o.assetBase}/glb/${name}.glb`, (g) => { place(g); resolve(); }, undefined, () => {
        loader.load(`${o.assetBase}/glb/r3/${name}.glb`, (g) => { place(g); resolve(); }, undefined, () => resolve());
      });
    });
  }
  const dimsDone: Promise<ModelDims | null> = fetch(`${o.assetBase}/glb/dims.json`).then((r) => (r.ok ? (r.json() as Promise<ModelDims>) : null)).catch(() => null);
  const objsDone = Promise.all([
    glb("cup", CUP_AT, [0, 0.6, 0], (b) => B_SIZE.cup / (b.max.x - b.min.x)),
    glb("card", CARD_AT, [0, -0.55, 0], (b) => B_SIZE.card / (b.max.x - b.min.x)),
    glb("pen", [REST_X, 0.1, REST_Z], [0, 0, 0], (b) => B_SIZE.pen / (b.max.y - b.min.y)),
    dimsDone,
  ]).then(([, , , dims]) => {
    // bounds from the files themselves, widened to the README's stated bounds (scaled with the object) where it gives them
    // precise (vertex) bounds: the box of a rotated object's own box would grow by up to 1.4× and reach under the paper
    const bx = (name: string): Box | null => { const m = objs[name]; if (!m) return null; m.updateMatrixWorld(true); const b = new THREE.Box3().setFromObject(m, true); return { name, min: b.min.toArray() as V3, max: b.max.toArray() as V3 }; };
    cupBox = bx("cup"); cardBox = bx("card"); applyCardName();
    if (cupBox) { steam = createSteam({ at: [CUP_AT[0], cupBox.max[1] - 0.03, CUP_AT[2]], still: RM }); scene.add(steam.group); }
    // the README's stated footprint (a cylinder, so rotation does not matter) widens the measured box where it is larger
    if (cupBox && dims?.cup) { const S = scales.cup ?? 1, r = dims.cup.radius * S; cupBox = { name: "cup", min: [Math.min(cupBox.min[0], CUP_AT[0] - r), cupBox.min[1], Math.min(cupBox.min[2], CUP_AT[2] - r)], max: [Math.max(cupBox.max[0], CUP_AT[0] + r), Math.max(cupBox.max[1], dims.cup.height * S), Math.max(cupBox.max[2], CUP_AT[2] + r)] }; }
    const pen = objs.pen;
    if (pen) {
      const S = scales.pen ?? 1;
      const keep = pen.position.clone(); pen.position.set(0, 0, 0); pen.quaternion.identity(); pen.scale.setScalar(S); pen.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(pen); pen.position.copy(keep);
      const measured: PenDims = { length: b.max.y - b.min.y, radius: Math.max(-b.min.x, b.max.x, -b.min.z, b.max.z) };
      // the README's conservative capsule (clip included) wins over the measured hull; the tip is the pivot (no offset since round 5)
      penBase = dims?.pen ? { length: Math.max(measured.length, dims.pen.length * S), radius: Math.max(measured.radius, dims.pen.radius * S) } : measured;
      penBaseOff = dims?.pen ? (dims.pen.tipOffset ?? 0) * S : -b.min.y;
      fitPen();
    }
  });
  /* the pen: a capsule that follows the writer's goal; when that goal jumps (the next line, a seek, the rest) it lifts and flies there on a planned arc */
  let penDims: PenDims = { length: B_SIZE.pen, radius: 0.0065 * (B_SIZE.pen / 0.146) }, penTipOff = 0;
  let penBase = penDims, penBaseOff = 0;
  /** the pen at its size for the screen: on a phone PHONE_PEN of it, so its barrel lies on about one printed line (v9) */
  function fitPen(): void {
    const k = camera.aspect < 0.8 ? PHONE_PEN : 1;
    penDims = { length: penBase.length * k, radius: penBase.radius * k }; penTipOff = penBaseOff * k;
    objs.pen?.scale.setScalar((scales.pen ?? 1) * k);
  }
  let cupBox: Box | null = null, cardBox: Box | null = null;
  let steam: Steam | null = null; // over the coffee, once the cup is in
  /** The card's embossed name is geometry in the file (MAYA): shown for her sample only; a dropped statement or another persona gets a card with no name. */
  let personaId: string | undefined;
  function applyCardName(): void { const n = objs.card?.getObjectByName("name"); if (n) n.visible = (personaId ?? "").split("-")[0].toLowerCase() === "maya"; }
  const penFrames: PenLog["frames"] = []; let collisions = 0; const firstHits: PenLog["first"] = [];
  const boxSets: Box[][] = [], boxSetIds = new Map<string, number>();
  const r3 = (v: number) => +v.toFixed(3);
  /** The index of this frame's box set in the log, deduplicated (the sets change when the paper prints, a receipt appears or a polaroid lands). */
  function boxSetId(boxes: Box[]): number {
    const key = boxes.map((b) => `${b.name}:${b.min.map(r3).join(",")}:${b.max.map(r3).join(",")}`).join("|");
    let id = boxSetIds.get(key);
    if (id == null) { id = boxSets.length; boxSets.push(boxes.map((b) => ({ name: b.name, min: b.min.map(r3) as V3, max: b.max.map(r3) as V3 }))); boxSetIds.set(key, id); }
    return id;
  }

  /* the receipts: both print to a length that is a function of t (a paper that grew behind the reader prints on at the printer's pace) */
  const ours = new Receipt({ width: 1, mode: "lie", curlRadius: 0.16, curlLength: 0.22, maxLength: 6.2, segments: 600, sway: 1 });
  ours.group.position.set(0, 0.018, 0); scene.add(ours.group);
  // the model-alone receipt: a darker grey and a hair more weight than our dim lines, so it reads; still lighter than our ink (owner, round 5)
  const theirs = new Receipt({ width: 1, mode: "lie", curlRadius: 0.16, curlLength: 0.26, maxLength: 3.2, segments: 300, sway: 1, dim: THEIRS_DIM, bold: 0.9 });
  theirs.group.position.set(1.3, 0.018, 0); theirs.group.rotation.y = -0.04; theirs.mesh.visible = false; scene.add(theirs.group);
  ours.mesh.frustumCulled = false; theirs.mesh.frustumCulled = false; // the paper is deformed per frame, so its static bounds are wrong
  // the ink strip: a small canvas whose pixels are copied into the paper texture, so a writing frame uploads one line, not the whole receipt
  const strip = document.createElement("canvas"); strip.width = ours.px; strip.height = STRIP_H; const stripCtx = strip.getContext("2d")!;
  const stripTex = new THREE.CanvasTexture(strip); stripTex.colorSpace = THREE.SRGBColorSpace;
  let texUploaded = false; // the paper texture is on the GPU at its current size (a partial copy is possible)
  const stripQ: number[] = []; // canvas y of the strips still to copy to it (paintAll with fromY)
  const scratch = document.createElement("canvas"); scratch.width = scratch.height = 4; const scratchCtx = scratch.getContext("2d")!; // measures a job's ink tip without painting

  /* ---------- state ---------- */
  let layout: SceneLayout | null = null;
  let oursSig = "", theirsSig = "", jobsSig = "";
  const penProg = new Map<string, number>(); // the ink on the paper, per piece of handwriting (0..1)
  let jobs: Job[] = [];
  const base = document.createElement("canvas"); let baseDirty = true;
  let lastSec = -1, proofFired = false, theirsShown = false; // theirsShown: the model-alone rows show (onTheirsPrinted)
  const cards = new Map<string, Card>();
  let cardCount = 0, origCount = 0;
  let warmDirty = true; const warmQ = new Set<THREE.Texture>(); // a warm pass due (warmUp); the polaroids' textures to upload, one a frame, before any shows (#511)
  const pointer = { x: 0, y: 0, cx: 0, cy: 0, mouse: false };
  const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
  const look = { x: 0, to: 0 }; // the mouse parallax: the pointer's x over the whole window (-1..1), eased (FEEL.lookK); 0 when it leaves
  let hoverKey: string | null = null, mutedKey: string | null = null; // no tooltip on the line just clicked until the pointer leaves it
  let ready = false, disposed = false, shown = false;
  let nextShown = false; // the next month's lines are on the paper (t past T_NEXT0); before, its paper is blank (v6, L1)
  let pendingData: SceneData | null = null; // the latest flow state, applied once per frame (a live run streams hundreds of events; each used to re-lay the paper)

  /* ---------- the timeline: t in sections (0 = statement … 4 = proof); the paper, the cards and the camera are functions of it ---------- */
  let t = 0, tTarget = 0, tv = 0, tLandMs = -1e9; // tTarget from the scroll (or the controlled section); t plays toward it at tv sections/s; when it last landed
  let lastMoveMs = -1e9, flickUntil = -1e9; // when the reader last moved the scroll (or a section was chosen), and until when a flick keeps the ink open
  const scrollHist: [number, number][] = []; // recent (ms, scroll px) samples: the scroll's speed over the last FLICK_WIN_MS tells a flick
  /** The reader moved: the ink may grow for OPEN_S (or FLICK_OPEN_S after a flick, told by the scroll's speed in px/s when known). */
  function moved(px?: number): void {
    const ms = now(); lastMoveMs = ms;
    if (px == null) return;
    scrollHist.push([ms, px]); while (scrollHist.length > 2 && scrollHist[1][0] <= ms - FLICK_WIN_MS) scrollHist.shift();
    const [ms0, px0] = scrollHist[0]; if (ms - ms0 >= FLICK_WIN_MS * 0.8 && Math.abs(px - px0) / (ms - ms0) * 1000 >= FLICK_PX_S) flickUntil = ms + FLICK_OPEN_S * 1000;
  }
  /** Until when the pen may move and the ink grow (v13): OPEN_S after the reader's last move, a flick's allowance, PEN_TAIL_S after t
   *  lands, or as long as the pen still has work (a flight, ink behind t, its goal not reached); never past CATCH_S after the last move or
   *  t's landing, whichever is later (v16: t glides on well past the input).
   *  While t plays it is open in any case. */
  let penBusy = false;
  // owner feedback: with one steady pace a long scroll leaves writing after the stop: the pen writes it out (the camera waits for it) instead of
  // stopping CATCH_S after the landing; a pen that lays no ink for FEEL.camFreeS falls back to the old allowance
  const penUntil = () => penBusy && lastBacklog > 0.5 && penStuck <= FEEL.camFreeS ? Infinity : Math.min(Math.max(lastMoveMs, tLandMs) + CATCH_S * 1000, penBusy ? Infinity : Math.max(lastMoveMs + OPEN_S * 1000, flickUntil, tLandMs + PEN_TAIL_S * 1000));
  const inkOpen = (ms: number) => t !== tTarget || ms <= penUntil();
  /**
   * Touch: v8 had the hand move with the finger (1:1, nothing after the finger's last frame); v13 (the owner, on the phone: 1:1 plays too
   * fast and reads as stepped) puts touch on the same eased timeline as the wheel.
   */
  let handCap = 0, hopCap = 0, penOpen = false; // the hand's cap this frame (px), a move between lines' own (FEEL.hopCapK)
  const win = new Map<string, Win>(); // each piece of handwriting's window on the timeline
  /** owner feedback: the model-alone receipt prints on its own clock, not the scroll: `thAt` the time (ms) its print-out began (the camera reached
   *  T_PROOF0 with its data or its question in; never reset by scrolling back), `thRowsAt` when its answer's rows began on the blank paper. */
  let thAt: number | null = null, thRowsAt: number | null = null;
  /**
   * The model-alone receipt as its paper has it: the layout's lines go onto it only while the reader moves (v7, M2: nothing changes while they
   * are still), so `ready` (its answer is in), `asking` (the blank paper of the question) and its framing rows are the paper's, not the layout's.
   * `ink`: the answer came in on the blank paper after its print-out; its rows print on it on their own clock (thRowsAt, FEEL.theirsRowsS).
   */
  const th = { ready: false, asking: false, ink: false, endLi: null as number | null, totalLi: null as number | null, held: null as SceneLayout | null };
  const now = () => performance.now();
  const clamp01 = (u: number) => Math.max(0, Math.min(1, u));
  const ease = (u: number) => u * u * u * (u * (u * 6 - 15) + 10); // smootherstep (v13: no linear starts or stops)
  /** One frame of the timeline (v16): t glides toward the scrolled target on a critically damped spring (FEEL.omega), stepped exactly
   *  (any frame rate, no overshoot), and lands on it once both its gap and its speed are sub-pixel. Reduced motion: t is the scroll itself. */
  function advance(dt: number): void {
    if (RM) { t = tTarget; tv = 0; return; }
    if (t === tTarget && tv === 0) return;
    const w = FEEL.omega, x = t - tTarget, e = Math.exp(-w * dt), b = tv + w * x;
    const x1 = (x + b * dt) * e, v1s = (tv - w * b * dt) * e;
    const v1 = FEEL.vMax * Math.tanh(v1s / FEEL.vMax); // owner feedback: a soft speed ceiling, however fast the scroll
    const xs = x1 + (v1 - v1s) * dt; // the slower speed holds t back by what it didn't travel this frame
    if (Math.abs(xs) < FEEL.landT && Math.abs(v1) < FEEL.landV) { t = tTarget; tv = 0; tLandMs = now(); } else { t = tTarget + xs; tv = v1; }
  }
  /** The t the pen's ink has reached: within the first unwritten piece's window,
   *  as far as its ink is; Infinity once all is written, with reduced motion, or while a pen with work lays no ink (FEEL.camFreeS). */
  function penT(): number {
    if (RM || penStuck > FEEL.camFreeS) return Infinity;
    // the first unwritten piece in the paper's order (the one the pen works on); one whose window is behind the camera (a re-run's, packed
    // after the pieces the reader passed) holds the camera where it is: never pulled back (v25, H2: it flew back to Swaps from the proof),
    // never let on past the pen (v25: it ran to the proof while the pen still wrote the rows above)
    for (const j of jobs) { const w = win.get(j.seq); if (!w || w.late) continue; const p = penProg.get(j.seq) ?? 0; if (p < 1) return Math.max(camT, w.t0 + p * (w.t1 - w.t0) + FEEL.camLead); }
    return Infinity;
  }
  /** How far a piece of handwriting may be at t: its window, linearly. */
  function targetOf(j: Job, tt: number): number {
    const w = win.get(j.seq); if (!w) return 0;
    return w.t1 <= w.t0 ? (tt >= w.t0 ? 1 : 0) : clamp01((tt - w.t0) / (w.t1 - w.t0));
  }
  /** Our paper's printed length at t: the statement and taste block at once, the next month's block over T_NEXT0..T_NEXT1 (its lines blank until then: nextShown). */
  function printedFor(tt: number): number {
    if (!layout) return 0;
    const end = layout.nextStart ?? layout.ours.length;
    const pre = Math.min(ours.L, ours.lineWorldY(Math.max(0, end - 1)) + 0.06 + (layout.tasteStart != null ? 0.3 : 0)); // the curl stays past the lines the pen writes
    if (layout.nextStart == null) return pre;
    return pre + (ours.L - pre) * ease(clamp01((tt - T_NEXT0) / (T_NEXT1 - T_NEXT0)));
  }
  /** The model-alone receipt's printed length: nothing until its print-out began (thAt), then one eased print-out over FEEL.theirsS. */
  function theirsAt(ms: number): number {
    if (thAt == null || !(th.ready || th.asking)) return 0;
    return RM ? theirs.L : theirs.L * ease(clamp01((ms - thAt) / (FEEL.theirsS * 1000)));
  }
  /** The model-alone receipt's length the camera frames at tt: whole from the proof on, or once printed (#511: its print-out runs on its own
   *  clock, so the stops never move under the camera while it prints). */
  function theirsFrameLen(tt: number): number { return (th.ready || th.asking) && (thAt != null || tt >= T_PROOF0) ? theirs.L : 0; }
  function setPrinted(r: Receipt, v: number): void {
    v = Math.max(0, Math.min(r.L, v));
    if (Math.abs(r.printed - v) > 1e-6) { r.printed = v; r.printTarget = v; r.settled = false; }
  }

  /* ---------- data ---------- */
  const priors: Record<string, Prior> = {}; // twins the reader took out, kept for their scribble after the flow drops them
  /** The flow state comes in; it is laid out once per frame (applyData), never more. */
  function setData(data: SceneData): void { pendingData = data; }
  function applyData(data: SceneData): void {
    // v25 (H2): while the agent's run is going nothing after Swaps is final: the camera holds at the last stop ready (runCap); a run that
    // starts again (a rejected swap) holds where the camera is, never back
    if (data.run.status === "running") runHold ??= camT; else runHold = null;
    if (data.personaId !== personaId) { personaId = data.personaId; applyCardName(); }
    questionKey = data.question?.merchantKey ?? null; // the slip lies level with the row it asks about
    collectPriors(data, priors);
    const next = buildLayout(data, priors);
    const sig = JSON.stringify(next.ours);
    const had = !!layout;
    layout = next;
    // the first data: the camera is on its stop at once (v6, H3: the statement in frame, waiting for the reader), unless the scene is on
    // screen already (a pick at the door): then it eases there and the paper prints out
    if (sig !== oursSig && lastMoveMs < 0 && onScreenYet()) { if (now() - enterAt > FEEL.enterS * 1000) { enterAt = now(); enterFrom = ours.printed; } camSoft = true; }
    else if (!had) camSnap = true;
    if (sig !== oursSig) {
      ours.setLines(next.ours);
      oursSig = sig; baseDirty = true;
      placeTheirs();
      if (had) reframe(); // the stops moved with the paper: on them with it (before the reader's first move) or eased there, never caught up at the next scroll
    }
    // handwriting per piece of text: every twin (and any scribble) before the one hand-written bridge
    const twins: Job[] = [], bridges: Job[] = [];
    for (const pt of next.pens) {
      if (!pt.text) continue;
      const ctx = ours.ctx, hand = `600 ${ours.fs * 1.25}px ${HAND}`;
      if (pt.prior) twins.push(job("scribble", pt, pt.prior.li, pt.prior.text, pt.prior.save, pt.prior.seq, pt.color, ours.pad + 150, hand, ctx));
      if (pt.status === "replanning") twins.push(job("scribble", pt, pt.li, pt.text, pt.save, pt.seq, pt.color, ours.pad + 150, hand, ctx));
      else {
        if (pt.strike) twins.push(job("strike", pt, pt.li, "", "", `${pt.seq}:s`, pt.color, ours.pad + 150, hand, ctx)); // the strike first, its own stroke; the pen then flies to the line's start
        twins.push(job("twin", pt, pt.li, pt.text, pt.save, pt.seq, pt.color, ours.pad + 150, hand, ctx));
      }
      if (pt.bridge && (pt.status === "proposed" || pt.status === "accepted")) bridges.push(job("bridge", pt, pt.bridge.li, pt.bridge.text, "", pt.bridge.seq, RED, ours.pad + 24, `600 ${ours.fs * 1.12}px ${HAND}`, ctx, ours.px - ours.pad * 2 - 24));
    }
    jobs = [...twins, ...bridges];
    const seqs = new Set(jobs.map((j) => j.seq));
    for (const k of [...penProg.keys()]) if (!seqs.has(k)) penProg.delete(k);
    // polaroids as in B, on both sides of the paper beside the rows the pen writes on: the reader's own places as the agent reads them
    // (dropped once the reader moves on from the statement), and each twin with an honest photo when the pen finishes its line
    const live = new Set<string>();
    for (const pt of next.pens) {
      const oid = `orig:${pt.key}`;
      if (pt.fromPhoto && !cards.has(oid)) makeCard(oid, pt.key, true, pt.fromPhoto, pt.name, pt.fromWhere);
      if (!pt.swap || !pt.swapId || !pt.photo || !(pt.status === "proposed" || pt.status === "accepted")) continue;
      live.add(pt.swapId);
      if (!cards.has(pt.swapId)) makeCard(pt.swapId, pt.key, false, pt.photo, pt.swap.to.entity.name, pt.where);
    }
    const ms = now();
    for (const c of cards.values()) {
      const on = c.orig || live.has(c.id);
      if (on && !c.live) { c.live = true; } else if (!on && c.live) { c.live = false; c.goneAt = ms; }
    }
    // the other receipt
    const tsig = JSON.stringify(next.theirs);
    // what changed on the model-alone paper goes on at the next frame (applyTheirs: unseen before its print-out, on its own clock after it)
    if (tsig !== theirsSig) { theirsSig = tsig; th.held = next; if (!ready || RM || t < T_PROOF0 - 0.05) applyTheirs(); }
    assignWindows();
    placeCards(); // the slip's place follows its row
    // our paper repainted (the whole texture uploaded again) only when its lines or its handwriting changed: the model-alone answer coming in
    // left it as it was and cost a 50-80 ms frame mid-scroll (#511, G3)
    const jsig = JSON.stringify(jobs.map((j) => [j.kind, j.seq, j.li, j.text, j.save, j.color, j.t]));
    if (ready && (baseDirty || jsig !== jobsSig)) paintAll();
    jobsSig = jsig;
  }
  /** The model-alone receipt's held lines go onto its paper. Its answer coming in on the blank paper after its print-out began prints its rows on their own clock from the header down; with no paper out yet, the paper prints. */
  function applyTheirs(): void {
    const lay = th.held; if (!lay) return; th.held = null;
    const blank = th.asking && !th.ready;
    th.ready = lay.theirsReady; th.asking = lay.theirsAsking; th.endLi = lay.theirsEndLi; th.totalLi = lay.theirsTotalLi;
    thRowsAt = null; th.ink = false;
    if (!RM && ready && th.ready && thAt != null && blank) { thRowsAt = now(); th.ink = true; }
    theirs.setLines(lay.theirs, theirsUpto());
    placeTheirs();
  }
  /** How many of the model-alone receipt's lines are printed on its paper: the header on the blank paper; the rows that came in late on their
   *  own clock, the last one part way in (a fraction: it fades in, in thirds, never popping; #511). */
  function theirsUpto(): number {
    if (th.asking && !th.ready) return TH_HEAD;
    if (!th.ink || thRowsAt == null) return Infinity;
    const k = (theirs.lines.length - TH_HEAD) * ease(clamp01((now() - thRowsAt) / (FEEL.theirsRowsS * 1000)));
    return k >= theirs.lines.length - TH_HEAD ? Infinity : TH_HEAD + Math.floor(k * 3) / 3;
  }
  function job(kind: Job["kind"], pt: PenTarget, li: number, text: string, save: string, seq: string, color: string, x0: number, font: string, ctx: CanvasRenderingContext2D, maxW = 0): Job {
    ctx.font = font; let tw = ctx.measureText(text).width;
    if (maxW > 0 && tw > maxW) {
      // a long bridge line is written smaller so it stays on its line (down to 78%)
      const m = font.match(/(\d+(?:\.\d+)?)px/);
      if (m) { font = font.replace(m[0], `${parseFloat(m[1]) * Math.max(0.78, maxW / tw)}px`); ctx.font = font; tw = ctx.measureText(text).width; }
    }
    if (kind === "strike") { const s = strikeSpan(ctx, pt); tw = s.x2 - s.x1; }
    return { kind, t: pt, li, text, save, seq, color, x0, font, tw };
  }
  /** The strike through a row's amount: from just left of the amount to just past the paper's text edge, at the amount's middle. */
  function strikeSpan(c: CanvasRenderingContext2D, pt: PenTarget): { x1: number; x2: number; yy: number } {
    const ry = lineY(pt.rowLi), rh = ours.lineH(ours.lines[pt.rowLi]);
    c.font = `${ours.fs}px ${FONT}`; const aw = c.measureText(ours.lines[pt.rowLi].amt ?? "").width;
    return { x1: ours.px - ours.pad - aw - 8, x2: ours.px - ours.pad + 8, yy: ry + rh * 0.72 - ours.fs * 0.3 };
  }
  /**
   * The other receipt: on a wide screen beside ours, ending level with our SAVED line, so one frame holds both verdicts; on a phone (PM, scene-10
   * round 3) below ours, same x, a little past our paper's end, so the proof's pan runs down the counter and both papers keep their width at every t.
   */
  function placeTheirs(): void {
    const lay = layout; if (!lay) return;
    if (camera.aspect < 0.8) theirsHome.set(0, 0.018, ours.L + THEIRS_GAP_P);
    else {
      const ourEnd = lay.savedLi != null ? ours.lineWorldY(lay.savedLi) : ours.L - 0.4;
      const theirEnd = th.totalLi != null ? theirs.lineWorldY(th.totalLi) : theirs.L - 0.3;
      theirsHome.set(1.3, 0.018, Math.max(0, ourEnd - theirEnd));
    }
    // on the counter in view it slides there while the reader moves (the answer's rows a line off the blank paper's: v7, M2); else it is put there
    if (!ready || RM || !theirs.mesh.visible) theirs.group.position.copy(theirsHome);
  }
  const theirsHome = new THREE.Vector3();

  /* ---------- the timeline's windows ---------- */
  /**
   * Each piece of handwriting gets a window on the timeline, packed from T_W0 to T_W1 in the paper's order. Windows already
   * reached keep their place (the ink never shifts under the reader); the rest are re-packed after them when pieces arrive
   * (a live run). A scribble (the answer to a click) is `late`: pinned where the reader is. On /demo every piece is known
   * before the reader's first move, so the windows are fixed from the start.
   */
  function assignWindows(): void {
    const seqs = new Set(jobs.map((j) => j.seq));
    for (const k of [...win.keys()]) if (!seqs.has(k)) win.delete(k);
    const kept = new Set(jobs.filter((j) => { const w = win.get(j.seq); return w && (w.late || w.t0 <= t + 1e-9); }).map((j) => j.seq));
    const future = jobs.filter((j) => !kept.has(j.seq));
    let start = T_W0;
    for (const k of kept) { const w = win.get(k)!; if (!w.late) start = Math.max(start, w.t1); }
    const n = future.length, slot = n ? Math.max(SLOT_MIN, (T_W1 - start) / n) : 0; // never a fast pass: past T_W1 if it must
    for (const j of future) {
      if (j.kind === "scribble" || RM) { win.set(j.seq, { t0: Math.max(0, t - 0.01), t1: t, late: true }); continue; } // a scribble answers a click: at once, where the reader is
      win.set(j.seq, { t0: start, t1: start + slot, late: false }); start += slot;
    }
  }
  /** Where the pen's tip is on the paper after `pr` of a job: the job drawn on a scratch context, for the tip alone. */
  function inkTip(j: Job, pr: number): { x: number; y: number } { return drawJob(scratchCtx, j, pr); }

  /* ---------- the writer: the ink grows only under the pen ---------- */
  /** The pen's goal this frame: a pose, whether the tip is to touch the paper, and the job it is on. */
  interface Goal { pose: Pose; touch: boolean; job: Job | null; inView: boolean; /** the pen is writing: it steps along the line with the head, never a flight */ step?: boolean }
  let goal: Goal | null = null, lastInk: { job: Job; pr: number } | null = null; // the last ink laid: the pen holds there between lines
  let lastBacklog = 0, penStuck = 0; // paper px of ink t has put in front of the pen; how long (s) it has had work and laid none
  let camT = 0; // the timeline point the camera frames (t; in the probe)
  const cost = { apply: 0, paint: 0, upload: 0, render: 0, frame: 0 }; // the most each part of a frame took (ms) since the probe last read it
  let camTV = 0, camCatch = false; // camT's own speed while it catches up a jump in its goal (FEEL.camCatchV)
  let runHold: number | null = null; // the camera's t when the agent's run (re)started; null when it is not running
  /** How far the camera may go while the run is going (v25, H2): the end of the handwriting the run has given so far (Swaps), or where it was. */
  const runCap = () => (runHold == null ? Infinity : Math.max(writeEnd(), runHold));
  let camShown = 0, camShownV = 0; // camT through the camera's own spring: the t the frame is at (#511: the photos and the model-alone receipt wait for it)
  let viewW = 1920, viewH = 1080; // the frame in px (resize)
  let laid: { job: Job; from: number; to: number } | null = null; // the ink laid this frame, kept only if the tip is on it after the pen has moved
  const dbg = { off: 0, jump: 0, reverted: 0, move: 0 }; // for the probe (move: the tip's own screen move this frame, px)
  const v2 = new THREE.Vector3();
  /** The world point is inside the frame (NDC within ±0.97, in front of the camera). */
  function inFrame(p: THREE.Vector3): boolean { v2.copy(p).project(camera); return Math.abs(v2.x) < 0.97 && Math.abs(v2.y) < 0.97 && v2.z < 1; }
  const sA = new THREE.Vector3(), sB = new THREE.Vector3();
  /** The tip's own move from a to b as the camera sees it now, in screen px (both ends through the same camera: the camera's motion is not the pen's). */
  function screenMove(a: THREE.Vector3, b: THREE.Vector3): number { sA.copy(a).project(camera); sB.copy(b).project(camera); return Math.hypot(((sB.x - sA.x) * viewW) / 2, ((sB.y - sA.y) * viewH) / 2); }
  const pA = new THREE.Vector3(), pB = new THREE.Vector3();
  /** The pen's own move from pose a to pose b as the camera sees it now: the largest screen move of its tip, its middle and its cap end
   *  (v7, H2: a flight that turns the pen about its tip swings the cap end far further than the tip). */
  function penMove(aT: THREE.Vector3, aD: THREE.Vector3, bT: THREE.Vector3, bD: THREE.Vector3): number {
    let m = 0;
    for (const f of [0, 0.5, 1]) m = Math.max(m, screenMove(pA.copy(aT).addScaledVector(aD, penDims.length * f), pB.copy(bT).addScaledVector(bD, penDims.length * f)));
    return m;
  }
  /** The point is on screen (within the frame, in front of the camera). */
  function onScreen(p: THREE.Vector3): boolean { sA.copy(p).project(camera); return Math.abs(sA.x) < 1 && Math.abs(sA.y) < 1 && sA.z < 1; }
  const sC = new THREE.Vector3();
  /**
   * Some part of the pen is on screen: its tip, or its barrel (the middle, the cap end) as it lies along `dir`. The hand's cap applies to every move
   * that starts or ends with the pen seen (PM, v5: a flick's flight in from the bottom-left stepped 344 px in one frame with the tip still under
   * the frame's edge and the barrel in view).
   */
  function penSeen(tip: THREE.Vector3, dir: THREE.Vector3): boolean {
    if (onScreen(tip)) return true;
    for (const f of [0.5, 1]) if (onScreen(sC.copy(tip).addScaledVector(dir, penDims.length * f))) return true;
    return false;
  }
  const capPx = () => CAP_FRAC * CAP_MARGIN * viewW;
  const wdA = new THREE.Vector3();
  /** A wide screen: WRITE_DIR, unless its cap end would lie under the strip's reach over the right half (the swap panel's halo washes it
   *  out, v10): then turned toward the reader about the tip, as little as clears it, the barrel as high off the paper as before. */
  const WIDE_E = Math.asin(WRITE_DIR[1]), WIDE_F = Math.atan2(WRITE_DIR[2], WRITE_DIR[0]), WIDE_TURN = 0.9;
  function wideDir(tip: V3): V3 {
    if (!(topInsetR > 0)) return WRITE_DIR;
    const L = penDims.length, ce = Math.cos(WIDE_E), at = (f: number): V3 => [ce * Math.cos(f), WRITE_DIR[1], ce * Math.sin(f)];
    const under = (d: V3) => { wdA.set(tip[0] + d[0] * L, tip[1] + d[1] * L, tip[2] + d[2] * L).project(camera); return wdA.x > 0 && ((1 - wdA.y) / 2) * viewH < topInsetR + PANEL_CLEAR; };
    if (!under(WRITE_DIR)) return WRITE_DIR;
    let lo = WIDE_F, hi = WIDE_F + WIDE_TURN; if (under(at(hi))) return at(hi);
    for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (under(at(mid))) lo = mid; else hi = mid; }
    return at(hi);
  }
  /**
   * How the pen is held with its tip at `tip`. A wide screen: WRITE_DIR, as B held it (wideDir). A phone (v9, H2): the barrel PHONE_LIFT off the
   * paper and turned so that, through this frame's camera, it runs level with the tip to the right, along its own line toward the margin and
   * past the paper's edge, over no row above or below (the cap end's screen height equals the tip's: bisection on the turn).
   */
  function writeDir(tip: V3): V3 {
    if (camera.aspect >= 0.8) return wideDir(tip);
    const L = penDims.length, ce = Math.cos(PHONE_LIFT), se = Math.sin(PHONE_LIFT), ty = wdA.set(...tip).project(camera).y;
    const at = (f: number): V3 => [ce * Math.cos(f), se, ce * Math.sin(f)];
    let lo = -1.4, hi = 1.4; // toward the reader (+z) the cap end drops on screen
    for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2, d = at(mid); if (wdA.set(tip[0] + d[0] * L, tip[1] + d[1] * L, tip[2] + d[2] * L).project(camera).y > ty) lo = mid; else hi = mid; }
    return at((lo + hi) / 2);
  }
  /**
   * One frame of writing. The windows say how far the ink may be at t; the ink itself only grows under the tip: the first
   * unfinished piece is where the pen works, and its ink advances at the pen's pace while the tip is on its head and in frame.
   * A reader who goes back leaves the ink as it is (v6, H2). Returns the pieces whose ink changed.
   */
  function writeFrame(dt: number): Job[] {
    const changed: Job[] = [];
    let current: Job | null = null, backlog = 0; laid = null;
    // the ink's targets follow t as it plays (v13): the pen writes along with the timeline at its own steady pace
    const tt = t;
    for (const j of jobs) {
      const u = targetOf(j, tt), p = penProg.get(j.seq) ?? 0;
      if (RM) { if (u > p) { penProg.set(j.seq, u); changed.push(j); } continue; }
      if (u > p + 1e-9) { backlog += (u - p) * inkLen(j); if (!current) current = j; } // the first unfinished line is where the pen works; ink is never taken back
    }
    if (RM) { goal = null; return changed; }
    // one steady pace
    lastBacklog = backlog;
    if (current) {
      const p = penProg.get(current.seq) ?? 0, u = targetOf(current, tt);
      let head = tipWorld(inkTip(current, p));
      const view = inFrame(head);
      const onHead = !pen.flight && pen.tip.distanceTo(head) <= HEAD_TOL, open = penOpen;
      let step = false;
      if (view && onHead && open) {
        // the ink advances at the pace, and never further than the hand's cap lets the tip move this frame: the furthest point of the
        // stroke within the cap (bisection on the piece's progress; the pen steps along with the head, so the ink is always under the tip)
        // each line's ink eases in and out: slow at its first and last FEEL.strokeEasePx, never under FEEL.strokeMin of the pace
        // a strike-through is one quicker slash
        const slash = current.kind === "strike", pace = PEN_PX_PER_S * (slash ? FEEL.strikePace : 1);
        const L = inkLen(current), edge = Math.min(p * L, (1 - p) * L), soft = FEEL.strokeMin + (1 - FEEL.strokeMin) * ease(clamp01(edge / (slash ? FEEL.strikeEasePx : FEEL.strokeEasePx)));
        const umax = Math.min(u, p + (pace * soft * dt) / L); let np = p;
        if (umax > p) {
          // and never more than FEEL.stepGrow of its last move (+1 px): a gap between words is crossed with a gentle speed-up, not a leap (#502)
          const cap = Math.min(handCap, dbg.move * FEEL.stepGrow + 1), at = (c: number) => tipWorld(inkTip(current, c)); let lo = p, hi = umax;
          // the pose the follower takes for that step: the tip on the new head, the axis turned part way (dt·10) to the line's axis there,
          // not the line's own axis nor the old head's: on a wide screen the axis turns along the line (wideDir), and a step sized to either
          // left the raised cap end swinging past the cap (v13, M7: 68-71 px with the tip at 46-48)
          const wd = new THREE.Vector3(), mv = (c: number) => { const q = at(c); wd.set(...writeDir(q.toArray() as V3)); return penMove(pen.tip, pen.dir, q, wd.copy(pen.dir).lerp(wd, Math.min(1, dt * 10)).normalize()); };
          if (mv(hi) <= cap) lo = hi; else for (let k = 0; k < 7; k++) { const mid = (lo + hi) / 2; if (mv(mid) <= cap) lo = mid; else hi = mid; }
          np = lo > p ? lo : Math.min(umax, p + (umax - p) / 128); // a piece's path is continuous: the smallest step is always within the cap
        }
        if (np > p) { penProg.set(current.seq, np); changed.push(current); head = tipWorld(inkTip(current, np)); laid = { job: current, from: p, to: np }; step = true; }
        lastInk = { job: current, pr: np };
      }
      // the goal: the head when it is in frame (the pen stays on it, poised, while the ink waits for the reader's next notch); else the pen waits where it is
      goal = view ? { pose: { tip: head.toArray() as V3, dir: writeDir(head.toArray() as V3) }, touch: true, job: current, inView: true, step } : { pose: holdPose(), touch: false, job: current, inView: false };
    } else {
      // nothing to write now. A line the scroll stopped in the middle of: the pen stays on its head, poised (v6, H1: it never leaves on its
      // own). Between lines it waits in the paper's right margin level with the last ink, and so it does when the reader goes back; before any
      // ink, and once every line is written and the reader has scrolled on past the writing, it waits in that margin in the middle of the view
      // and travels with the camera (v7, H2 and L3: it never leaves the frame, never turns, and lies across no row)
      const mid = jobs.find((j) => { const p = penProg.get(j.seq) ?? 0; return p > 0 && p < 1; });
      const anyInk = jobs.some((j) => (penProg.get(j.seq) ?? 0) > 0), allDone = anyInk && jobs.every((j) => (penProg.get(j.seq) ?? 0) >= 1);
      if (!allDone) lieZ = null;
      // every line written: the pen is laid down flat on the counter beside our paper, level with the last ink, and stays there
      // (it no longer rises back into the margin to travel with the camera) until the reader's scroll brings more writing
      if (allDone && lastInk) { lieZ ??= tipWorld(inkTip(lastInk.job, lastInk.pr)).z; const lp = liePose(lieZ); goal = { pose: lp, touch: false, job: null, inView: inFrame(sC.set(...lp.tip)) }; }
      else if (mid) { const h = tipWorld(inkTip(mid, penProg.get(mid.seq) ?? 0)); goal = { pose: { tip: h.toArray() as V3, dir: writeDir(h.toArray() as V3) }, touch: true, job: null, inView: inFrame(h) }; }
      else if (anyInk && lastInk && !(allDone && tt >= writeEnd())) { const pz = parkPose(tipWorld(inkTip(lastInk.job, lastInk.pr)).z); goal = { pose: pz, touch: false, job: null, inView: inFrame(sC.set(...pz.tip)) }; }
      else if (!anyInk && camera.aspect < 0.8) goal = { pose: outPose(camA.z), touch: false, job: null, inView: false };
      else if (camera.aspect < 0.8 && !wholeIn(parkPose(camA.z))) goal = { pose: outPose(camA.z), touch: false, job: null, inView: false }; // v11 (F4): the phone's end, the pen wholly in the frame or wholly out
      else { const pz = parkPose(camA.z); goal = { pose: pz, touch: false, job: null, inView: inFrame(sC.set(...pz.tip)) }; }
    }
    // a phone's pen off a line's head (parked in the margin, or held while the head is out of the frame) is wholly in the frame or wholly
    // out, going either way (v11 F4, v14, v15: the margin is the frame's right edge there, and the pen parked in it showed only its nib):
    // one the frame would cut waits past the right edge at its depth. On a head it keeps the writing pose, its barrel out past the paper's
    // right edge (v9)
    if (goal && !goal.touch && camera.aspect < 0.8 && !wholeIn(goal.pose) && anyIn(gT.set(...goal.pose.tip), gD.set(...goal.pose.dir))) goal = { ...goal, pose: outPose(goal.pose.tip[2]), inView: false };
    if (changed.length || backlog <= 0.5) penStuck = 0; else if (penOpen) penStuck += dt; // kept while closed: the reader's next move lays ink and clears it
    return changed;
  }
  const gT = new THREE.Vector3(), gD = new THREE.Vector3();
  let lieZ: number | null = null; // where the pen was laid down once every line was written (null while there is writing to do)
  /** The pen laid down: flat on the counter right of our paper (clear of the polaroid column and the model-alone receipt past it),
   *  cap toward the reader, its middle level with depth z. */
  function liePose(z: number): Pose {
    const r = penDims.radius, L = penDims.length, x = ours.W / 2 + FEEL.lieGap + r, dir = v3.norm([FEEL.lieTurn, 0, 1]);
    const z0 = Math.max(0.02, Math.min(Math.max(0.02, ours.printed - L), z - L / 2));
    return { tip: [x, r + 0.002, z0], dir };
  }
  /** The pen as it is, lifted a little: the hold while the head is out of frame. */
  function holdPose(): Pose { const tip = pen.tip.toArray() as V3; const onPaper = Math.abs(tip[0]) < ours.W / 2 && tip[2] > 0 && tip[2] < ours.printed; if (onPaper && tip[1] < PAPER_Y + HOVER) tip[1] = PAPER_Y + HOVER; return { tip, dir: pen.dir.toArray() as V3 }; }
  /** The tip is on the paper's surface (within 6 mm) and over it. */
  function tipTouches(): boolean {
    const x = pen.tip.x, z = pen.tip.z; if (Math.abs(x) > ours.W / 2 || z < 0 || z > ours.printed) return false;
    return pen.tip.y - (PAPER_Y + ours.surfaceLift(x, z)) < 0.006;
  }

  /* ---------- handwriting ---------- */
  function lineY(li: number): number { return ours.lineTop(li); }
  /** Canvas x where the pen is after writing `frac` of `text`: per glyph, not a linear guess. */
  function revealX(c: CanvasRenderingContext2D, j: Job, frac: number): number {
    if (frac >= 1) return j.tw;
    const n = Math.max(0, Math.min(j.text.length, Math.floor(frac * j.text.length))), f = frac * j.text.length - n;
    c.font = j.font;
    const a = c.measureText(j.text.slice(0, n)).width, b = n < j.text.length ? c.measureText(j.text.slice(0, n + 1)).width : a;
    return a + (b - a) * f;
  }
  /** Draw one job at its progress onto the paper canvas (clipped by the caller). Returns the pen tip in canvas px. */
  function drawJob(c: CanvasRenderingContext2D, j: Job, pr: number): { x: number; y: number } {
    const W = ours.px, y = lineY(j.li), h = ours.lineH(ours.lines[j.li]), base = y + h * 0.78;
    const pt = j.t;
    c.save(); c.lineCap = "round"; c.lineJoin = "round"; c.textAlign = "left";
    let tip = { x: j.x0, y: base - 8 };
    if (j.kind === "scribble") {
      // the twin is already written; the pen scribbles it out, then the saving
      c.font = j.font; c.fillStyle = RED; c.fillText(j.text, j.x0, base);
      if (j.save) { c.textAlign = "right"; c.fillText(j.save, W - ours.pad, base); c.textAlign = "left"; }
      c.strokeStyle = "#3a352e"; c.lineWidth = 3; c.beginPath();
      const n = 40, len = j.tw;
      for (let k = 0; k <= n * pr; k++) { const u = k / n; c.lineTo(j.x0 + len * u, base - h * 0.3 + Math.sin(u * 23) * 7 + Math.sin(u * 7) * 4); }
      c.stroke();
      tip = { x: j.x0 + len * Math.min(1, pr), y: base - h * 0.3 };
    } else if (j.kind === "strike") {
      const { x1, x2, yy } = strikeSpan(c, pt), sp = Math.min(1, pr);
      c.strokeStyle = RED; c.lineWidth = 3.2; c.beginPath();
      for (let k = 0; k <= 20 * sp; k++) { const u = k / 20; c.lineTo(x1 + (x2 - x1) * u, yy + Math.sin(u * 9) * 2.5); } c.stroke();
      tip = { x: x1 + (x2 - x1) * sp, y: yy };
    } else {
      const wp = pr;
      if (wp > 0) {
        const rx = revealX(c, j, wp);
        c.save(); c.beginPath(); c.rect(j.x0 - 10, y - 8, rx + 12, h + 16); c.clip(); c.fillStyle = j.color; c.font = j.font; c.fillText(j.text, j.x0, base); c.restore();
        tip = { x: j.x0 + rx, y: base - 6 };
      }
      if (j.kind === "twin" && j.save && wp > 0.75) { c.font = j.font; c.fillStyle = j.color; c.textAlign = "right"; c.globalAlpha = ease((wp - 0.75) / 0.25); c.fillText(j.save, W - ours.pad, base); c.globalAlpha = 1; }
      // the printed evidence under a twin: Qloo's numbers, machine type; then the short bridge in the same grey. owner feedback: they popped in once
      // the line was done; now they come in behind the pen as it writes the line above, left to right with a soft edge, whole as it finishes
      if (j.kind === "twin" && wp > FEEL.evLag) {
        c.font = `${ours.fs * 0.72}px ${FONT}`; c.textAlign = "left";
        const f = (lag: number) => clamp01((wp - lag) / (1 - lag));
        if (pt.evidence) { const ey = lineY(pt.evLi), eh = ours.lineH(ours.lines[pt.evLi]); c.fillStyle = "#5a544b"; softText(c, pt.evidence, ours.pad + 150, ey + eh * 0.76, f(FEEL.evLag)); }
        if (pt.also && pt.alsoLi != null) { const ay = lineY(pt.alsoLi), ah = ours.lineH(ours.lines[pt.alsoLi]); c.fillStyle = "#6f6960"; softText(c, pt.also, ours.pad + 150, ay + ah * 0.76, f(FEEL.evLag * 2)); }
      }
    }
    c.restore();
    return tip;
  }
  /** Printed text revealed left to right to `frac` of its width, its edge a FEEL.evFeather px fade (in six steps), whole at 1. */
  function softText(c: CanvasRenderingContext2D, text: string, x: number, y: number, frac: number): void {
    if (frac <= 0) return; if (frac >= 1) { c.fillText(text, x, y); return; }
    const F = FEEL.evFeather, w = c.measureText(text).width, edge = x - F + (w + F) * frac, top = y - ours.fs * 1.2, h = ours.fs * 1.6, a0 = c.globalAlpha;
    const band = (x0: number, x1: number, a: number) => { if (x1 <= x0) return; c.save(); c.globalAlpha = a0 * a; c.beginPath(); c.rect(x0, top, x1 - x0, h); c.clip(); c.fillText(text, x, y); c.restore(); };
    band(x - 4, edge, 1);
    for (let k = 0; k < 6; k++) band(Math.max(x - 4, edge + (F * k) / 6), edge + (F * (k + 1)) / 6, 1 - (k + 0.5) / 6);
  }
  /** The ink a job lays in all, in paper px (the probe's inked length is the sum at progress). */
  const inkLen = (j: Job) => Math.max(40, j.tw);
  /** Repaint everything: base print plus all handwriting at its progress. Whole-texture upload, or with `fromY` (the paper on the GPU as it was,
   *  only what lies below that canvas y changed: the next month's block coming in) that part a strip a frame from the top (stripQ): the whole
   *  paper's upload cost a 70-130 ms frame at t 2.4 (#511, G3). */
  function paintAll(fromY?: number): void {
    if (!layout) return;
    const c = ours.ctx, W = ours.px, H = ours.canvas.height;
    stripQ.length = 0;
    // only below fromY (v25, G3: the whole paper's paint was 25 ms of a 83 ms frame at t 2.4): the paper on the GPU as it was above it
    const y0 = fromY != null && texUploaded && base.width === W && base.height === H ? Math.min(H - 1, Math.max(0, Math.floor(fromY))) : null;
    if (baseDirty) {
      if (y0 == null) { base.width = W; base.height = H; }
      ours.paint(nextShown || layout.nextStart == null ? undefined : layout.nextStart, false, y0 ?? 0); // its own upload made the strips moot (v25)
      const bc = base.getContext("2d")!; if (y0 != null) bc.clearRect(0, y0, W, H - y0);
      bc.drawImage(ours.canvas, 0, y0 ?? 0, W, H - (y0 ?? 0), 0, y0 ?? 0, W, H - (y0 ?? 0)); baseDirty = false;
    }
    c.setTransform(1, 0, 0, 1, 0, 0); c.save();
    if (y0 != null) { c.beginPath(); c.rect(0, y0, W, H - y0); c.clip(); }
    c.clearRect(0, y0 ?? 0, W, H - (y0 ?? 0)); c.drawImage(base, 0, y0 ?? 0, W, H - (y0 ?? 0), 0, y0 ?? 0, W, H - (y0 ?? 0));
    for (const j of jobs) { const pr = penProg.get(j.seq) ?? 0; if (pr > 0 || j.kind === "scribble") drawJob(c, j, pr); } // a twin being taken out stays on the paper until scribbled
    c.restore();
    if (y0 != null) { for (let y = y0; y < H; y += STRIP_H) stripQ.push(Math.min(y, H - STRIP_H)); return; }
    ours.tex.needsUpdate = true; texUploaded = false;
  }
  /** Copy one STRIP_H strip of the paper's canvas (from canvas y `y0`) to its texture on the GPU. */
  function copyStrip(y0: number): void {
    const W = ours.px, H = ours.canvas.height, h = STRIP_H;
    stripCtx.clearRect(0, 0, W, h); stripCtx.drawImage(ours.canvas, 0, y0, W, h, 0, 0, W, h);
    try { renderer.copyTextureToTexture(stripTex, ours.tex, null, new THREE.Vector2(0, H - (y0 + h))); }
    catch { ours.tex.needsUpdate = true; texUploaded = false; stripQ.length = 0; }
  }
  /** Region (canvas y, height) a job can touch: its row (strike) down to its evidence line. */
  function jobRegion(j: Job): { y0: number; h: number } {
    const top = j.kind === "bridge" ? lineY(j.li) - 10 : lineY(j.t.rowLi);
    const y0 = Math.max(0, Math.min(ours.canvas.height - STRIP_H, Math.floor(top)));
    return { y0, h: STRIP_H };
  }
  /** Repaint one strip of the paper (a writing frame) and copy only that strip to the GPU. */
  function paintStrip(j: Job): void {
    if (!layout || baseDirty) { paintAll(); return; }
    const c = ours.ctx, W = ours.px, { y0, h } = jobRegion(j);
    c.setTransform(1, 0, 0, 1, 0, 0); c.save(); c.beginPath(); c.rect(0, y0, W, h); c.clip();
    c.clearRect(0, y0, W, h); c.drawImage(base, 0, y0, W, h, 0, y0, W, h);
    for (const k of jobs) {
      const pr = penProg.get(k.seq) ?? 0; if (pr <= 0 && k.kind !== "scribble") continue;
      const r = jobRegion(k); if (r.y0 + r.h <= y0 || r.y0 >= y0 + h) continue;
      drawJob(c, k, pr);
    }
    c.restore();
    if (texUploaded) copyStrip(y0); else ours.tex.needsUpdate = true;
  }

  /* ---------- polaroids ---------- */
  const POLAROID_SCALE = 0.44; // B's size
  /** World z of the first row the pen writes under (the polaroid columns start beside it), else the taste block. */
  function rowsStartZ(): number {
    const first = layout?.pens.find((p) => p.text || p.swap)?.rowLi;
    if (first != null) return ours.lineWorldY(first);
    return Math.max(1.3, layout?.tasteStart != null ? ours.lineWorldY(layout.tasteStart) - 0.35 : 1.3);
  }
  function makeCard(id: string, key: string, orig: boolean, photo: string, caption: string, sub: string): void {
    const m = photoCard(`${o.assetBase}/photos/${photo}.jpg`, caption, { sub: sub || undefined, scale: POLAROID_SCALE, onDraw: (tex) => warmQ.add(tex) });
    m.rotation.x = -Math.PI / 2; m.visible = false; m.castShadow = false; scene.add(m);
    // owner feedback (the first three dropped frames): the polaroids' shader is built ahead of the first drop, off the main thread where the GPU can
    warmDirty = true;
    const i = cardCount++, side = i % 2 === 1 ? 1 : -1;
    cards.set(id, { id, key, orig, k: orig ? origCount++ : 0, i, zBase: Math.max(0.5, rowsStartZ() - 0.1), m, home: new THREE.Vector3(), at: null, rz: side * 0.04 /* v10: a column steps straight down 0.42 m, so a turn shifts the card over a caption sideways by 0.42 tan(rz): at 0.04, 1.7 cm, inside the caption's 2 cm inset (0.07 left its first letter showing) */, live: true, goneAt: 0, lift: 0, y: 1, dv: 0 });
    placeCards();
  }
  const CARD_HALF = 0.3; // m: half a polaroid's length along the counter, its turn included
  /**
   * B's layout: two columns beside the paper, alternating sides, a card apart down the rows the pen writes on (the right column a little ahead);
   * the model-alone receipt lands over the right column's tail, as B's did. The question slip (PM, v5) lies in the left column's place: the
   * cards there that would land under it move down past it (and the rest of the column with them). A card already on the counter stays put.
   */
  function placeCards(): void {
    const r = slipRect(); let shift = 0;
    for (const c of [...cards.values()].sort((a, b) => a.i - b.i)) {
      const right = c.i % 2 === 1, side = right ? 1 : -1, j = c.i >> 1;
      let z = c.zBase + (right ? -0.2 : 0) + j * 0.42;
      if (!right) { z += shift; if (r && z + CARD_HALF > r.z0 - 0.03 && z - CARD_HALF < r.z1 + 0.03) { const nz = r.z1 + 0.03 + CARD_HALF; shift += nz - z; z = nz; } }
      // a card already on the counter moves too (it slides there, see frame()): the question can arrive after the reader's own places landed
      // each column on one line (v10): a card shifted aside from the one landing over its foot left the ends of its caption showing ("Wi")
      c.home.set(side * 1.03, 0.006 + c.i * 0.001 /* the stack stays under the papers at 0.018, so no card pokes through the model-alone receipt */, z);
    }
  }

  /* ---------- the question slip (landscape, v5): a paper on the counter left of the receipt, level with the row it asks about ---------- */
  const SLIP_X = -0.96, SLIP_W = 0.56, SLIP_TURN = 0.025; // m across the counter (the left polaroid column's place), its width, a slight turn (rad)
  let slipEl: HTMLElement | null = null, questionKey: string | null = null, slipLen = 0; // slipLen: its length along the counter, from the element's own aspect
  let slipOn = false, slipA = 0; // the slip shown or not (v12), and its opacity on the way
  let slipShown = false; const slipQuad: [number, number][] = [[0, 0], [0, 0], [0, 0], [0, 0]]; // its corners on screen this frame
  /** Where the slip lies (world z range), or null: on a phone, with no slip, or before the paper is laid. */
  function slipRect(): { z0: number; z1: number } | null {
    if (!slipEl || !slipLen || camera.aspect < 0.8 || !layout) return null;
    const pt = questionKey ? layout.pens.find((p) => p.key === questionKey) : undefined;
    const rowZ = pt ? ours.lineWorldY(pt.rowLi) : layout.tasteStart != null ? ours.lineWorldY(layout.tasteStart) : 1.5;
    const z0 = Math.max(rowZ - 0.12, cupBox ? cupBox.max[2] + 0.06 : 0); // its head a little above the row, clear of the cup and saucer
    return { z0, z1: z0 + slipLen };
  }
  /** The slip's corners in the world, clockwise from its head's left (the element's top-left). */
  function slipCorners(): THREE.Vector3[] | null {
    const r = slipRect(); if (!r) return null;
    const cz = (r.z0 + r.z1) / 2, c = Math.cos(SLIP_TURN), s = Math.sin(SLIP_TURN), hw = SLIP_W / 2, hl = slipLen / 2;
    return ([[-hw, -hl], [hw, -hl], [hw, hl], [-hw, hl]] as const).map(([u, v]) => new THREE.Vector3(SLIP_X + u * c - v * s, 0.004, cz + u * s + v * c));
  }
  /** Lays the slip's element on the counter: a CSS homography from its own box to its corners on screen (the frame's perspective), hidden off the frame. */
  function slipFrame(dt: number): void {
    const el = slipEl; slipShown = false; if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    const len = w && h ? (SLIP_W * h) / w : 0;
    if (Math.abs(len - slipLen) > 1e-3) { slipLen = len; placeCards(); }
    const cs = slipCorners();
    const q = cs?.map((p) => { const v = p.clone().project(camera); return { x: ((v.x + 1) / 2) * viewW, y: ((1 - v.y) / 2) * viewH, front: v.z < 1 }; });
    const off = !q || q.some((p) => !p.front) || q.every((p) => p.x < 0) || q.every((p) => p.x > viewW) || q.every((p) => p.y < 0) || q.every((p) => p.y > viewH);
    if (!q || off) { if (el.style.visibility !== "hidden") el.style.visibility = "hidden"; return; }
    // v11 (F1): the slip never lies under the strip (the nav, the section's figure). v12 (LOW): nor rests part-faded at a stop: it is
    // shown or gone by where its head is (a margin each way), and fades in or out over SLIP_FADE_S; within SLIP_FADE px of the strip's foot
    // it is gone, so a fast scroll carries none of it under the strip mid-fade
    const clear = Math.min(...q.map((p) => p.y)) - topInset;
    slipOn = clear >= SLIP_FADE + (slipOn ? 0 : SLIP_HYST);
    slipA = slipOn ? Math.min(1, slipA + dt / SLIP_FADE_S) : Math.max(0, slipA - dt / SLIP_FADE_S);
    const a = ease(Math.min(slipA, clamp01(clear / SLIP_FADE)));
    const pe = a >= 0.5 ? "auto" : "none"; if (el.style.pointerEvents !== pe) el.style.pointerEvents = pe; // a faded slip takes no clicks
    if (a <= 0.02) { if (el.style.visibility !== "hidden") el.style.visibility = "hidden"; return; }
    q.forEach((p, k) => { slipQuad[k][0] = p.x; slipQuad[k][1] = p.y; }); slipShown = true;
    el.style.transform = homography(w, h, q.map((p) => [p.x, p.y]));
    const op = a >= 0.98 ? "" : a.toFixed(3); if (el.style.opacity !== op) el.style.opacity = op;
    if (el.style.visibility !== "visible") el.style.visibility = "visible";
  }
  /** The slip's bbox on screen this frame, or null. */
  const slipBox = () => (slipShown ? { x0: Math.min(...slipQuad.map((p) => p[0])), y0: Math.min(...slipQuad.map((p) => p[1])), x1: Math.max(...slipQuad.map((p) => p[0])), y1: Math.max(...slipQuad.map((p) => p[1])) } : null);
  /** The highest a polaroid lying at (x, z) may be so the pen's barrel stays FEEL.cardClear above it (owner feedback: a drop went through the
   *  pen); Infinity where the pen is not over it. The card's slight turn is taken as a margin. */
  function underPen(x: number, z: number): number {
    if (!objs.pen) return Infinity;
    const L = penDims.length, r = penDims.radius + FEEL.cardClear, mx = POLAROID_W / 2 + r + 0.03, mz = POLAROID_H / 2 + r + 0.03; let y = Infinity;
    for (let k = 0; k <= 24; k++) {
      cuV.copy(pen.tip).addScaledVector(pen.dir, (L * k) / 24);
      if (Math.abs(cuV.x - x) < mx && Math.abs(cuV.z - z) < mz) y = Math.min(y, cuV.y - r);
    }
    return y;
  }
  const cuV = new THREE.Vector3();
  /** A polaroid's stage is in the frame: the reader's own once the camera's own t is
   *  past FEEL.cardsCamT; a twin's once the pen has written its line and the camera's own t is past that line's window. */
  function cardGate(c: Card): boolean {
    if (c.orig) return RM ? t >= FEEL.cardsCamT : camShown >= FEEL.cardsCamT;
    const j = jobs.find((x) => x.kind === "twin" && x.t.swapId === c.id), w = j && win.get(j.seq);
    if (!j || !w || (penProg.get(j.seq) ?? 0) < 1) return false;
    return RM || w.late || camShown >= w.t1;
  }
  /** How far down a polaroid is (0 above the counter, 1 landed): once its stage is in the frame it drops over FEEL.cardDropS, no sooner than
   *  FEEL.cardStagger of a drop after the last one began (#511: the first three came in together and dropped frames); lifted the same way
   *  when the camera goes back past its stage, or away when its swap is taken out. */
  let dropAt = -1e9;
  function cardU(c: Card, ms: number, dt: number): number {
    const on = cardGate(c);
    if (RM) c.dv = on ? 1 : 0;
    else if (on) { if (c.dv > 0 || ms - dropAt >= FEEL.cardStagger * FEEL.cardDropS * 1000) { if (c.dv === 0) dropAt = ms; c.dv = Math.min(1, c.dv + dt / FEEL.cardDropS); } }
    else c.dv = Math.max(0, c.dv - dt / FEEL.cardDropS);
    let u = ease(c.dv);
    if (!c.live) u *= 1 - ease(clamp01((ms - c.goneAt) / 500));
    return u;
  }

  /* ---------- camera: B's stops along the paper, the writing stretch following the pen's rows ---------- */
  interface Focus { pos: THREE.Vector3; aim: THREE.Vector3 }
  let topInset = 0, bottomInset = 0; // px of the app's top strip and bottom overlay over the canvas (the phone's framing)
  let topInsetR = 0; // how far the strip reaches down over the right half: the wide proof's model-alone header sits there (v5: the figure at the left no longer pushes it down)
  let capBox: { x1: number; y1: number } | null = null, capKey = ""; // the wide screen's caption column (v5, M8: no caption over a row)
  const clearCache = new Map<string, number>();
  /** Screen-space bounds (NDC y) the paper's needed rows must stay inside on a phone: under the top strip by NAV_CLEAR, above the bottom overlay by BOT_CLEAR. */
  function ndcBounds(top = topInset): { yMax: number; yMin: number } {
    const H = canvas.clientHeight || window.innerHeight;
    return { yMax: 1 - (2 * (top + NAV_CLEAR)) / H, yMin: -1 + (2 * (bottomInset + BOT_CLEAR)) / H };
  }
  /**
   * Along the paper (z, from the aim), how far the frame reaches for a camera offset: `top` is the smallest z offset whose point
   * clears the top strip (negative: up the paper), `bot` the largest still above the bottom overlay (`toEdge`: above the frame's own bottom edge). Screen y falls as z grows.
   */
  function reach(off: THREE.Vector3, topPx = topInset, toEdge = false): { top: number; bot: number } {
    const H = canvas.clientHeight || window.innerHeight;
    const key = `${off.x},${off.y},${off.z},${camera.aspect.toFixed(4)},${camera.fov},${topPx},${toEdge ? -1 : bottomInset},${H}`;
    const hit = clearCache.get(key); if (hit != null) return { top: hit, bot: clearCache.get(key + "b")! };
    const { yMax } = ndcBounds(topPx), yMin = toEdge ? -1 : ndcBounds(topPx).yMin;
    const cam = camera.clone(); cam.position.copy(off); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(); const v = new THREE.Vector3();
    let lo = -6, hi = 2;
    for (let k = 0; k < 28; k++) { const mid = (lo + hi) / 2; v.set(0, 0, mid).project(cam); if (v.y > yMax) lo = mid; else hi = mid; }
    const top = hi;
    lo = -2; hi = 6;
    for (let k = 0; k < 28; k++) { const mid = (lo + hi) / 2; v.set(0, 0, mid).project(cam); if (v.y >= yMin) lo = mid; else hi = mid; }
    clearCache.set(key, top); clearCache.set(key + "b", lo); return { top, bot: lo };
  }
  /**
   * The phone's camera for a section (PM, scene-9): aim as close to `zPref` as the top row (`topZ`) allows under the strip; when the last needed
   * row (`botZ`) would then sit under the captions, back the camera off a little (up to `kMax`) until both fit, the top rule winning if even that is short.
   */
  function fitView(off: THREE.Vector3, zPref: number, topZ: number | null, botZ: number | null, kMax: number, kMin = 1): { off: THREE.Vector3; z: number; k: number } {
    const fits = (k: number) => { const r = reach(off.clone().multiplyScalar(k)); return topZ == null || botZ == null || botZ - r.bot <= topZ - r.top; };
    let k = kMin;
    if (!fits(kMin)) { let lo = kMin, hi = kMax; if (fits(kMax)) { for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; } k = hi; } else k = kMax; }
    const o = off.clone().multiplyScalar(k), r = reach(o);
    let z = zPref;
    if (botZ != null) z = Math.max(z, botZ - r.bot);
    if (topZ != null) z = Math.min(z, topZ - r.top);
    return { off: o, z, k };
  }
  // B's camera: pos = aim + (0, 2.55, 2.1) along the paper; the proof swings right and higher, pos = aim + (0.05, 3.55, 2.4)
  const PORTRAIT_OFF = new THREE.Vector3(0, 3.7, 1.1), LAND_OFF = new THREE.Vector3(0, 2.55, 2.1);
  const PROOF_OFF = new THREE.Vector3(0.05, 3.55, 2.4), PROOF_OFF_P = new THREE.Vector3(0, 4.4, 1.3);
  /** World z of the top of a paper line. */
  const lineTopZ = (li: number) => (ours.lineTop(li) / ours.px) * ours.W;
  /** Timeline room past the last section: the phone's second proof viewport. */
  const extraT = () => (camera.aspect < 0.8 ? PHONE_PROOF_EXTRA : 0);
  let lastFit = { k: 1, z: 0 }; // for debug()
  const WRITE_AHEAD = 0.3; // the aim sits this far past the row being written, so the line is above the frame's middle (B: its lines 0.15–0.65 above the aim)
  /** The aim's z while the pen writes: the row of the piece whose window holds tt (between pieces, between their rows), from the first row to the last. */
  function writingZ(tt: number): number | null {
    const ws = jobs.filter((j) => j.kind !== "bridge" && win.get(j.seq) && !win.get(j.seq)!.late).map((j) => ({ w: win.get(j.seq)!, z: ours.lineWorldY(j.t.rowLi) }));
    if (!ws.length) return null;
    const pts = ws.map((x) => ({ t: (x.w.t0 + x.w.t1) / 2, z: x.z + WRITE_AHEAD }));
    if (tt <= pts[0].t) return pts[0].z; if (tt >= pts[pts.length - 1].t) return pts[pts.length - 1].z;
    for (let i = 1; i < pts.length; i++) if (tt <= pts[i].t) { const f = (tt - pts[i - 1].t) / Math.max(1e-6, pts[i].t - pts[i - 1].t); return pts[i - 1].z + (pts[i].z - pts[i - 1].z) * f; }
    return pts[pts.length - 1].z;
  }
  /** A section's camera stop (0..4, plus the phone's 5). */
  function sectionFocus(i: number): Focus {
    const lay = layout, L = ours.L, portrait = camera.aspect < 0.8;
    const at = (li: number | null | undefined, off: number, fallback: number) => (li == null ? fallback : Math.min(ours.lineWorldY(li) + off, Math.max(0.8, L - 0.3)));
    const savedZ = at(lay?.savedLi, 0, Math.max(1.2, L - 0.5));
    const first = writingZ(-Infinity), last = writingZ(Infinity);
    // B's stops: the header under the strip and the statement running off the bottom (aim 0.45); the first rows the pen writes on; the last of them with
    // TOTAL and the taste block below; the plan with the aim 0.55 short of the paper's end, so the receipt fills the height
    // the plan's stop follows the paper as the next month's block prints (T_NEXT0..T_NEXT1), so the frame's lower half is never bare counter
    const aims = [0.45, first ?? at(lay?.tasteStart, 0.42, 1.3), last ?? at(lay?.tasteStart, 0.95, 1.6), Math.max(2.2, Math.min(L, Math.max(0.6, ours.printed)) - 0.55)];
    if (i < 4) {
      const off = portrait ? PORTRAIT_OFF : LAND_OFF;
      if (!portrait) { const z = aims[Math.max(0, Math.min(3, i))]; lastFit = { k: 1, z }; return { pos: new THREE.Vector3(off.x, off.y, z + off.z), aim: new THREE.Vector3(0, 0, z) }; }
      // the phone: the same stops, the paper filling the width; the first view aims at the statement's middle, October sits lower; the frame keeps the
      // section's first needed line from under the strip and its last above the captions, backing off a little when it must (PM, scene-9)
      const topZ = !lay ? null : i === 0 ? 0 : i >= 3 ? lineTopZ(lay.totalLi) : null;
      const bottom = (li: number | null | undefined, pad: number) => (li == null ? null : lineTopZ(li) + pad);
      const botZ = !lay ? null : [null, null, bottom(lay.tasteEnd, 0.02), bottom(lay.endLi != null ? lay.endLi + 1 : null, 0.04)][Math.max(0, Math.min(3, i))];
      const zPref = i === 3 ? savedZ - 0.2 : i === 0 ? at(lay?.statementEnd, -0.12, 0.9) * 0.55 : aims[i] + 0.35;
      const f = fitView(off, zPref, topZ, botZ, ZOOM_MAX_P); lastFit = { k: f.k, z: f.z };
      return { pos: new THREE.Vector3(f.off.x, f.off.y, f.z + f.off.z), aim: new THREE.Vector3(0, 0, f.z) };
    }
    const topZ = lay ? lineTopZ(lay.totalLi) : null;
    const botZ = lay?.endLi != null ? lineTopZ(lay.endLi + 1) + 0.04 : null;
    if (portrait && i === 4) {
      // the phone's proof, first viewport: our plan block whole (the OCTOBER head down to the closing note) at the same closeness as the model's receipt
      // gets on the next viewport, aimed so the closing note sits just above the caption
      const topP = lay?.nextStart != null ? lineTopZ(lay.nextStart) : topZ;
      const zPref = botZ != null ? botZ - reach(PROOF_OFF_P.clone().multiplyScalar(0.8)).bot : savedZ - 0.1;
      const f = fitView(PROOF_OFF_P, zPref, topP, botZ, ZOOM_MAX_P, 0.8); lastFit = { k: f.k, z: f.z };
      return { pos: new THREE.Vector3(0, f.off.y, f.z + f.off.z), aim: new THREE.Vector3(0, 0, f.z) };
    }
    // proof: both receipts end level with SAVED; the frame holds the model-alone header and verdicts and our SAVED (B: the camera swings right and higher)
    // portrait (the phone's second proof viewport): the model-alone receipt, below ours on the counter, whole and centred, its header the top row
    // landscape: the aim a little left of B's (x 0.6, was 0.9), so the pair sits further right and the front door's figure in the strip ends short of our paper at 1920
    const off = portrait ? PROOF_OFF_P : PROOF_OFF, x = portrait ? 0 : 0.6;
    const zPref = portrait ? savedZ - 0.35 : savedZ - 0.3;
    let top = topZ, bot = botZ;
    if (th.ready || th.asking) {
      const tz = theirs.group.position.z, theirsTop = tz + theirs.pad / theirs.px;
      top = portrait ? theirsTop : Math.min(top ?? Infinity, theirsTop);
      if (th.endLi != null) bot = Math.max(bot ?? -Infinity, tz + (theirs.lineTop(th.endLi + 1) / theirs.px) * theirs.W + 0.04);
      if (portrait && th.ready) bot = Math.max(bot ?? -Infinity, tz + theirs.L + 0.03); // the phone's end (v11, F2): the whole of it, to its barcode and torn end
    }
    if (!portrait) {
      // B: the model-alone header is the frame's top row (under what the strip puts over the right half). v13 (2): both papers' tails, to
      // the barcode and the torn end, above the frame's bottom edge: the camera backs off as little as that takes (up to PROOF_BACK)
      const tail = Math.max(ours.L, th.ready ? theirs.group.position.z + theirs.L : -Infinity) + 0.03;
      const at = (k: number) => { const o = off.clone().multiplyScalar(k), r = reach(o, topInsetR); let z = zPref; if (top != null && top !== Infinity) z = Math.min(z, top - r.top); return { o, z, ok: tail <= z + reach(o, topInsetR, true).bot }; };
      let f = at(1);
      if (!f.ok) { let lo = 1, hi = PROOF_BACK; if (at(hi).ok) { for (let k = 0; k < 12; k++) { const mid = (lo + hi) / 2; if (at(mid).ok) hi = mid; else lo = mid; } } f = at(hi); lastFit = { k: hi, z: f.z }; } else lastFit = { k: 1, z: f.z };
      return { pos: new THREE.Vector3(x + f.o.x, f.o.y, f.z + f.o.z), aim: new THREE.Vector3(x, 0, f.z) };
    }
    const f = fitView(off, zPref, top === Infinity ? null : top, bot === -Infinity ? null : bot, ZOOM_MAX_P); lastFit = { k: f.k, z: f.z };
    const aim = new THREE.Vector3(x, 0, f.z);
    return { pos: new THREE.Vector3(x, f.off.y, aim.z + f.off.z), aim };
  }
  /**
   * The wide screen's caption clear of our paper (v5, M8): when our paper's left edge, where the caption's lowest line sits, is closer
   * than CAP_GAP px to the caption's ink (on the way into the proof, where the pair moves left), the frame moves left (the paper right) just
   * enough; no further than keeps the model-alone receipt CAP_GAP inside the frame's right edge.
   */
  let capEl: HTMLElement | null = null; const capV = new THREE.Vector3();
  function setCaptionEl(el: HTMLElement | null): void { if (capEl && capEl !== el) capEl.style.visibility = ""; capEl = el; }
  /** Our paper's left edge on screen where the caption's lowest line sits, through `cam` (null: the paper doesn't reach that row of the screen). */
  function capEdge(cam: THREE.Camera, cb: { x1: number; y1: number }): number | null {
    const W = canvas.clientWidth || window.innerWidth, H = canvas.clientHeight || window.innerHeight, v = capV;
    const sy = (zz: number) => { v.set(-ours.W / 2, PAPER_Y, zz).project(cam); return ((1 - v.y) * H) / 2; };
    let lo = 0, hi = Math.max(0.02, ours.printed); if (sy(lo) > cb.y1 || sy(hi) < cb.y1) return null;
    for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2; if (sy(mid) < cb.y1) lo = mid; else hi = mid; }
    v.set(-ours.W / 2, PAPER_Y, (lo + hi) / 2).project(cam); return ((v.x + 1) * W) / 2;
  }
  /** Each frame: the caption hides while the frame (the springs still on their way to a new target) has our paper under its ink. */
  function captionFrame(): void {
    if (!capEl) return;
    const e = capBox && camera.aspect >= 0.8 ? capEdge(camera, capBox) : null, hide = e != null && e < capBox!.x1 + 4;
    const vis = hide ? "hidden" : ""; if (capEl.style.visibility !== vis) capEl.style.visibility = vis;
  }
  function clearCaption(out: Focus, tt: number): void {
    if (!capBox || camera.aspect < 0.8) return;
    const W = canvas.clientWidth || window.innerWidth, H = canvas.clientHeight || window.innerHeight, CAP_GAP = 16, cb = capBox;
    const cam = camera.clone(), v = new THREE.Vector3(), off = out.pos.clone().sub(out.aim), z = out.aim.z;
    const at = (xa: number) => { cam.position.set(xa + off.x, out.pos.y, out.pos.z); cam.lookAt(xa, out.aim.y, z); cam.updateMatrixWorld(); };
    // where a paper edge (world x `ex`, from z0 to z1) crosses screen y `py`: its screen x, or null when the paper doesn't reach that row of the screen
    const edgeX = (ex: number, z0: number, z1: number, py: number) => {
      const sy = (zz: number) => { v.set(ex, PAPER_Y, zz).project(cam); return ((1 - v.y) * H) / 2; };
      if (sy(z0) > py || sy(z1) < py) return null;
      let lo = z0, hi = z1;
      for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2; if (sy(mid) < py) lo = mid; else hi = mid; }
      v.set(ex, PAPER_Y, (lo + hi) / 2).project(cam); return ((v.x + 1) * W) / 2;
    };
    const oursOk = (xa: number) => { at(xa); const e = capEdge(cam, cb); return e == null || e >= cb.x1 + CAP_GAP; };
    const theirsOk = (xa: number) => {
      const tl = theirsFrameLen(tt); if (tl <= 0.04) return true; at(xa); const tz = theirs.group.position.z;
      const e = edgeX(theirs.group.position.x + theirs.W / 2, tz, tz + tl, H - 1); return e == null || e <= W - CAP_GAP;
    };
    const x0 = out.aim.x; if (oursOk(x0)) return;
    // both edges' screen x fall as the aim moves right: bisect for the least move left that clears the caption, then hold it where the right edge allows
    let lo = x0 - 1.2, hi = x0; for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (oursOk(mid)) lo = mid; else hi = mid; }
    let xa = lo;
    if (!theirsOk(xa)) { let a = xa, b = x0; for (let k = 0; k < 16; k++) { const mid = (a + b) / 2; if (theirsOk(mid)) b = mid; else a = mid; } xa = b; }
    out.aim.x = xa; out.pos.x = xa + off.x;
  }
  /* the quiet "asking…" mark (v6, M4): on the model-alone receipt's blank paper, under its header, while its answer is on its way (v7, M2:
     the paper lies over the polaroids there, so nothing covers the mark) */
  let askEl: HTMLElement | null = null, askClip = { top: 0, bottom: 0 }, askKey = "";
  function askFrame(): void {
    const el = askEl; if (!el) return;
    let key = "";
    if (th.asking && !th.ready && theirs.mesh.visible && theirs.lines.length > TH_HEAD + 1) {
      const z = theirs.group.position.z + theirs.lineWorldY(TH_HEAD + 1);
      if (z < theirs.group.position.z + theirs.printed - 0.03) {
        const v = new THREE.Vector3(theirs.group.position.x - theirs.W / 2 + 0.05, PAPER_Y + 0.02, z).project(camera), x = ((v.x + 1) / 2) * viewW, y = ((1 - v.y) / 2) * viewH;
        if (v.z < 1 && x > 8 && x < viewW - 160 && y > askClip.top + 8 && y < viewH - askClip.bottom - 24) key = `${x.toFixed(1)},${y.toFixed(1)}`;
      }
    }
    if (key === askKey) return; askKey = key;
    if (!key) { el.style.display = "none"; return; }
    const [x, y] = key.split(","); el.style.transform = `translate(${x}px, ${y}px)`; el.style.display = "block";
  }
  /** Where the handwriting's windows end on the timeline: T_W1, or later when there are more pieces than SLOT_MIN lets into T_W0..T_W1. */
  function writeEnd(): number { let e = T_W1; for (const w of win.values()) if (!w.late) e = Math.max(e, w.t1); return e; }
  /** The camera's target at t: between the stops, linearly; through the writing (T_W0..writeEnd) its aim follows the rows being written. */
  function focusAt(tt: number): Focus {
    if (doorSlot && camera.aspect < 0.8) return doorFocus(doorSlot).f;
    const i = Math.max(0, Math.min(N - 2 + extraT(), Math.floor(tt))); let f = Math.max(0, Math.min(1, tt - i));
    const W1 = writeEnd();
    if (i === Math.floor(W1)) f *= f; // the stage the writing ends in: the move to the next stop starts gently, so the last lines (and the pen's tail past them) keep the writing's frame
    const a = sectionFocus(i), b = sectionFocus(i + 1);
    const out = { pos: a.pos.lerp(b.pos, f), aim: a.aim.lerp(b.aim, f) };
    if (tt > T_W0 && tt < W1 && jobs.length) {
      const z = writingZ(tt);
      if (z != null) {
        // the aim's z blends from the stop at T_W0 to the writing path and back to the stop at T_W1, so the path joins the stops without a kink
        const w = Math.sin(Math.PI * clamp01((tt - T_W0) / (W1 - T_W0)));
        const dz = (z - out.aim.z) * w; out.aim.z += dz; out.pos.z += dz;
      }
    }
    if (camera.aspect >= 0.8) {
      // through the writing's range of t (eased in before it, out after): the frame a tenth tighter, and the aim at least PAPER_END_REACH short of the paper's end
      const zo = clamp01((tt - W1) / ZOOM_OUT), wz = Math.min(clamp01((tt - (T_W0 - ZOOM_IN)) / ZOOM_IN), 1 - zo * zo); // the zoom-out too starts gently past the windows' end
      if (wz > 0) {
        const cap = Math.max(1.0, ours.printed - PAPER_END_REACH); if (out.aim.z > cap) { const dz = (cap - out.aim.z) * wz; out.aim.z += dz; out.pos.z += dz; }
        const k = 1 - (1 - WRITE_ZOOM) * wz; out.pos.sub(out.aim).multiplyScalar(k).add(out.aim);
      }
      // past the writing, on the way to October's stop, the frame's bottom edge stays on the paper too, printing behind the reader
      // (a burst or a flick outran the printer: 30% bare counter under the paper's end); a function of t, eased out over the last 0.12
      // into the stop (the October lines are still being written to ~2.9)
      if (tt < 3) { const w = clamp01((3 - tt) / 0.12), r = reach(out.pos.clone().sub(out.aim).multiplyScalar(1e3).round().multiplyScalar(1e-3), topInset, true), cap = Math.max(1.0, printedFor(tt) + 0.01 - r.bot);
        if (out.aim.z > cap) { const dz = (cap - out.aim.z) * w; out.aim.z += dz; out.pos.z += dz; } }
      clearCaption(out, tt);
    } else if (tt < 3) {
      // the phone, up to October: the paper fills the frame down to its bottom edge; the frame follows the paper's end down, never past it
      // (v7, M1: late in Swaps the writing's path left 30-45% of bare counter under it); eased out on the way into October's stop
      const w = clamp01((3 - tt) / 0.3), r = reach(out.pos.clone().sub(out.aim).multiplyScalar(1e3).round().multiplyScalar(1e-3)), cap = printedFor(tt) + 0.01 - r.bot;
      if (out.aim.z > cap) { const dz = (cap - out.aim.z) * w; out.aim.z += dz; out.pos.z += dz; }
    }
    if (camera.aspect < 0.8) fitWidth(out, tt);
    return out;
  }
  const fwCam = new THREE.PerspectiveCamera(), fwV = new THREE.Vector3();
  /**
   * The phone (v13, 2: the owner saw the receipts' edges cut): each paper's left and right edges, on the part of it the canvas shows, stay
   * SIDE_CLEAR px inside the screen. Where they would not, the camera backs off from its aim as little as that takes (bisection).
   */
  function fitWidth(out: Focus, tt: number): void {
    const W = viewW, H = viewH, off = out.pos.clone().sub(out.aim), y0 = topInset, y1 = H - bottomInset;
    const papers = [{ x: 0, w: ours.W, z0: 0, z1: ours.printed }];
    { const tl = theirsFrameLen(tt); if (tl > 0.04) papers.push({ x: theirs.group.position.x, w: theirs.W, z0: theirs.group.position.z, z1: theirs.group.position.z + tl }); }
    fwCam.copy(camera);
    const ok = (k: number) => {
      fwCam.position.copy(out.aim).addScaledVector(off, k); fwCam.lookAt(out.aim); fwCam.updateMatrixWorld();
      // an edge is a straight line on screen: its part within the shown band, end to end
      const scr = (x: number, z: number) => { fwV.set(x, PAPER_Y, z).project(fwCam); return { x: ((fwV.x + 1) / 2) * W, y: ((1 - fwV.y) / 2) * H, front: fwV.z < 1 }; };
      for (const p of papers) for (const ex of [p.x - p.w / 2, p.x + p.w / 2]) {
        const a = scr(ex, p.z0), b = scr(ex, p.z1); if (!a.front || !b.front) continue;
        const dy = b.y - a.y; let s0 = 0, s1 = 1;
        if (Math.abs(dy) < 1e-6) { if (a.y < y0 || a.y > y1) continue; } else { const u0 = (y0 - a.y) / dy, u1 = (y1 - a.y) / dy; s0 = Math.max(0, Math.min(u0, u1)); s1 = Math.min(1, Math.max(u0, u1)); if (s0 > s1) continue; }
        for (const u of [s0, s1]) { const sx = a.x + (b.x - a.x) * u; if (sx < SIDE_CLEAR || sx > W - SIDE_CLEAR) return false; }
      }
      return true;
    };
    if (ok(1)) return;
    let lo = 1, hi = SIDE_BACK; if (ok(hi)) for (let k = 0; k < 12; k++) { const mid = (lo + hi) / 2; if (ok(mid)) hi = mid; else lo = mid; }
    out.pos.copy(out.aim).addScaledVector(off, hi);
  }
  const camP = new THREE.Vector3(0, 2.55, 2.55), camA = new THREE.Vector3(0, 0, 0.45);
  let camSnap = true; // the camera goes straight to its target on the next frame (the start, the first data, a resize, the door)
  let camGlide = false; // the framing changed (the strip, the bottom band, the caption) with the camera still: it eases to the new stop, then holds
  /** The entrance: the scene is on screen and the reader has not moved yet (the door, a pick): the camera eases onto its stop
   *  on a critically damped spring (FEEL.enterOmega), its speed in camVP/camVA, and the paper prints out to its length over FEEL.enterS. */
  let camSoft = false, shownMs = -1, enterAt = -1e9, enterFrom = 0;
  const camVP = new THREE.Vector3(), camVA = new THREE.Vector3(), sprX = new THREE.Vector3(), sprB = new THREE.Vector3();
  const onScreenYet = () => !RM && shownMs >= 0 && now() - shownMs > 300;
  /** One exact step of a critically damped spring of p (speed v) toward `to`. */
  function spring(p: THREE.Vector3, v: THREE.Vector3, to: THREE.Vector3, w: number, dt: number): void {
    const e = Math.exp(-w * dt); sprX.copy(p).sub(to); sprB.copy(v).addScaledVector(sprX, w);
    sprX.addScaledVector(sprB, dt).multiplyScalar(e); v.addScaledVector(sprB, -w * dt).multiplyScalar(e); p.copy(to).add(sprX);
  }
  /** The page's framing changed: before the reader's first move the camera is put on the new stop at once while the scene has only just
   *  appeared (no pop at the first scroll, v6 M3), and eases there on the entrance's spring once it is on screen (owner feedback: a pick
   *  was a hard cut); after the first move it eases there (FEEL.camOmega) and stops. */
  function reframe(): void { if (lastMoveMs >= 0) camGlide = true; else if (onScreenYet()) camSoft = true; else camSnap = true; }
  /** Our paper's printed length this frame: during the entrance it prints out from where it was, eased. */
  function enterPrinted(v: number): number {
    const k = (now() - enterAt) / (FEEL.enterS * 1000); if (k >= 1 || RM) return v;
    return enterFrom + (v - enterFrom) * ease(clamp01(k));
  }

  /* ---------- the pen's world: every object's bounds, and its moves over them ---------- */
  const POLAROID_W = POLAROID_SCALE, POLAROID_H = (POLAROID_SCALE * 620) / 512;
  /** Everything the pen must stay out of, as world boxes: the cup, the card, both receipts (surface and curled end), the counter, the polaroids on the counter. */
  function obstacleBoxes(): Box[] {
    const out: Box[] = [];
    if (cupBox) out.push(cupBox); if (cardBox) out.push(cardBox);
    const e = Math.max(0.02, ours.printed), c = ours.curlAt(e);
    out.push({ name: "paper", min: [-ours.W / 2, -0.01, 0], max: [ours.W / 2, PAPER_Y - 0.003, e] });
    if (c.top > 0.004) out.push({ name: "curl", min: [-ours.W / 2, 0, c.start], max: [ours.W / 2, PAPER_Y + c.top - 0.003, c.end + 0.04] });
    const theirsE = theirs.mesh.visible ? theirs.printed : 0;
    if (theirsE > 0.04) { const tz = theirs.group.position.z, tc = theirs.curlAt(Math.max(0.02, theirsE)); out.push({ name: "theirs", min: [theirs.group.position.x - theirs.W / 2, -0.01, tz], max: [theirs.group.position.x + theirs.W / 2, PAPER_Y + tc.top - 0.003, tz + Math.max(0.02, theirsE) + 0.04] }); }
    out.push({ name: "counter", min: [-20, -1, -20], max: [20, -0.001, 20] });
    for (const c of cards.values()) if (c.m.visible && c.y < 0.1) out.push(flatBox(`photo:${c.key}`, c.home.x, c.home.y, c.home.z, POLAROID_W, POLAROID_H, c.rz, 0.003));
    const sr = slipRect(); if (sr) out.push(flatBox("slip", SLIP_X, 0.004, (sr.z0 + sr.z1) / 2, SLIP_W, sr.z1 - sr.z0, SLIP_TURN, 0.003));
    return out;
  }
  /** The surfaces the tip may touch: only the pen's axis entering them counts. */
  const slackFor = (b: Box) => (b.name === "paper" || b.name === "curl" || b.name === "theirs" || b.name === "counter" ? penDims.radius : 0);
  function flightTo(from: Pose, to: Pose, boxes: Box[]): Flight {
    // owner feedback: the pen glides low onto the paper and from line to line (its arcs of 6-10 cm read as a jump up and a bounce at each hop):
    // the least lift that clears what is in the way, FEEL.hopLift at the least, FEEL.hopClear over the paper mid-way
    const f = planFlight(from, to, penDims, boxes, { slackFor, minHeight: FEEL.hopLift, margin: FEEL.hopClear });
    f.dur = Math.max(FLIGHT_MIN_S, f.dur); // played FEEL.hopSpeed times faster (follow)
    return f;
  }
  /** World point of a canvas (x, y) on our paper, riding its surface (sway and curl). */
  function tipWorld(p: { x: number; y: number }): THREE.Vector3 {
    const x = (p.x / ours.px - 0.5) * ours.W, d = (p.y / ours.px) * ours.W;
    return new THREE.Vector3(x, PAPER_Y + ours.surfaceLift(x, d) + 0.002, d);
  }
  /** Where the pen waits when it has nothing to write (v7): the tip hovering in our paper's right margin, at depth z along it, held as for
   *  writing, so the barrel lies off the paper to the right over no row, and going to or from a line never turns the pen. Where the barrel
   *  would lie over the model-alone receipt (the wide screen's proof, beside ours; the phone's, below), the nearest depth in the frame clear of it. */
  function parkPose(z: number): Pose {
    const x = ours.W / 2 - PARK_IN, at = (zz: number): V3 => [x, PAPER_Y + ours.surfaceLift(x, zz) + 0.002 + HOVER, zz];
    const zOf = (v: number) => Math.max(0.02, Math.min(Math.max(0.02, ours.printed - 0.02), v)), L = penDims.length;
    // on screen (the barrel rises toward the camera, so its footprint on the counter is not where it shows): the pen's points against the
    // other paper's box through the frame's camera
    const clear = (zz: number) => {
      // a wide screen (v10): the barrel clear of the strip's reach over the right half (the swap panel's halo there washes it out)
      if (camera.aspect >= 0.8 && topInsetR > 0) {
        const tip = at(zz), [dx, dy, dz] = writeDir(tip);
        for (let f = 0; f <= 1; f += 0.125) { sC.set(tip[0] + dx * L * f, tip[1] + dy * L * f, tip[2] + dz * L * f).project(camera); if (sC.x > 0 && ((1 - sC.y) / 2) * viewH < topInsetR + PANEL_CLEAR) return false; }
      }
      // its whole length once its answer is asked for (v25, row 18: it prints on its own clock after the reader stops, under a pen parked
      // clear of only what was printed then)
      const len = Math.max(theirs.printed, th.ready || th.asking ? theirs.L : 0); if (len <= 0.04) return true;
      const g = theirs.group.position; let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const [cx, cz] of [[-1, 0], [1, 0], [1, 1], [-1, 1]]) { sC.set(g.x + (cx * theirs.W) / 2, PAPER_Y, g.z + cz * len).project(camera); bx0 = Math.min(bx0, sC.x); bx1 = Math.max(bx1, sC.x); by0 = Math.min(by0, sC.y); by1 = Math.max(by1, sC.y); }
      const m = 0.03, tip = at(zz), [dx, dy, dz] = writeDir(tip);
      for (let f = 0; f <= 1; f += 0.125) { sC.set(tip[0] + dx * L * f, tip[1] + dy * L * f, tip[2] + dz * L * f).project(camera); if (sC.x > bx0 - m && sC.x < bx1 + m && sC.y > by0 - m && sC.y < by1 + m) return false; }
      return true;
    };
    let zz = zOf(z);
    if (!clear(zz)) {
      let first: number | null = null;
      for (let k = 1; k <= 80; k++) for (const c of [zOf(z - 0.02 * k), zOf(z + 0.02 * k)]) {
        if (!clear(c)) continue; first ??= c;
        if (inFrame(sC.set(...at(c))) && inFrame(sC.set(...at(c)).addScaledVector(pA.set(...writeDir(at(c))), L))) { zz = c; k = 99; break; }
      }
      if (zz === zOf(z) && first != null) zz = first;
    }
    const tz = at(zz); return { tip: tz, dir: writeDir(tz) };
  }

  let penShadow = true;
  /** Some of the pen (its barrel by eighths, its radius in px with it) on the screen. */
  function anyIn(tip: THREE.Vector3, dir: THREE.Vector3): boolean {
    const L = penDims.length, m = 10;
    for (let f = 0; f <= 1; f += 0.125) {
      sC.copy(tip).addScaledVector(dir, L * f).project(camera); if (sC.z >= 1) continue;
      const x = ((sC.x + 1) / 2) * viewW, y = ((1 - sC.y) / 2) * viewH;
      if (x > -m && x < viewW + m && y > -m && y < viewH + m) return true;
    }
    return false;
  }
  /** The whole pen (its barrel by eighths, its radius in px aside) within the frame the canvas shows (under the strip, above the bottom band). */
  function wholeIn(p: Pose): boolean {
    const L = penDims.length, m = 8;
    for (let f = 0; f <= 1; f += 0.125) {
      sC.set(p.tip[0] + p.dir[0] * L * f, p.tip[1] + p.dir[1] * L * f, p.tip[2] + p.dir[2] * L * f).project(camera);
      const x = ((sC.x + 1) / 2) * viewW, y = ((1 - sC.y) / 2) * viewH;
      if (x < m || x > viewW - m || y < topInset + m || y > viewH - bottomInset - m) return false;
    }
    return true;
  }
  /** The phone before any ink (its front door, the statement's first view; v10): the pen waits wholly out of the frame past its right edge,
   *  held as for writing, level with depth z, so the first view shows all of it or none of it. It comes in with the scroll to the first line. */
  function outPose(z: number): Pose {
    const W = canvas.clientWidth || window.innerWidth, x0 = ours.W / 2 - PARK_IN, y = PAPER_Y + ours.surfaceLift(x0, z) + 0.002 + HOVER;
    const left = (x: number) => { const t: V3 = [x, y, z], d = writeDir(t); let m = Infinity; for (let f = 0; f <= 1; f += 0.125) { sC.set(t[0] + d[0] * penDims.length * f, t[1] + d[1] * penDims.length * f, t[2] + d[2] * penDims.length * f).project(camera); m = Math.min(m, ((sC.x + 1) / 2) * W); } return m; };
    let lo = x0, hi = x0 + 4; // the tip moved right until the pen's leftmost point is 24 px past the frame's edge (its barrel's radius and the shadow's blur)
    for (let k = 0; k < 20; k++) { const mid = (lo + hi) / 2; if (left(mid) > W + 24) hi = mid; else lo = mid; }
    const t: V3 = [hi, y, z]; return { tip: t, dir: writeDir(t) };
  }

  /** On a phone with no ink yet: the pen straight to its place past the frame's edge (outPose), through the camera as it is now. */
  function restOut(): void {
    if (camera.aspect >= 0.8 || !objs.pen || jobs.some((j) => (penProg.get(j.seq) ?? 0) > 0)) return;
    const r = outPose(camA.z); pen.tip.set(...r.tip); pen.dir.set(...r.dir); pen.flight = null; pen.off.set(0, 0, 0);
    objs.pen.quaternion.copy(tmpQ.setFromUnitVectors(PEN_UP, pen.dir)); objs.pen.position.copy(pen.tip).addScaledVector(pen.dir, -penTipOff);
  }

  /* the follower: the pen is at the writer's goal; when that goal jumps it lifts and flies there on a planned arc, so it never teleports */
  const pen = { tip: new THREE.Vector3(REST_X, 0.1, REST_Z), dir: new THREE.Vector3(...REST_DIR), flight: null as Flight | null, ft: 0, fr: 0, off: new THREE.Vector3() };
  const fT = new THREE.Vector3(), fD = new THREE.Vector3();
  /** The hand's cap this frame for a move with `rest` px still to go: it brakes into its landing (v = sqrt(2 a d), FEEL.brake), never under 0.5 px. */
  const brakeCap = (rest: number, hop = false) => Math.min(hop ? hopCap : handCap, Math.max(0.5, Math.sqrt(2 * (hop ? FEEL.hopBrake : FEEL.brake) * rest)));
  function follow(g: Pose, dt: number, step = false): boolean {
    if (RM) { pen.tip.set(...g.tip); pen.dir.set(...g.dir); pen.flight = null; pen.off.set(0, 0, 0); return false; }
    const cur: Pose = { tip: pen.tip.toArray() as V3, dir: pen.dir.toArray() as V3 };
    dbg.jump = v3.dist(g.tip, v3.sub(cur.tip, pen.off.toArray() as V3)); dbg.off = pen.off.length();
    if (!step) {
      if (pen.flight && v3.dist(g.tip, pen.flight.to.tip) > JUMP) { pen.flight = flightTo(cur, g, obstacleBoxes()); pen.ft = pen.fr = 0; } // the goal moved on: a fresh arc from here
      if (!pen.flight && dbg.jump > JUMP) { pen.flight = flightTo(cur, g, obstacleBoxes()); pen.ft = pen.fr = 0; } // the goal jumped from where it was last frame
    } // writing: the tip moves along the line with the ink head, however far this frame; no flight
    if (pen.flight) {
      const fl = pen.flight, ft0 = pen.ft; pen.ft += dt * FEEL.hopSpeed; pen.fr += dt; // the arc runs FEEL.hopSpeed times its planned time, but never under two frames
      const uOf = (ft: number) => Math.min(1, ft / fl.dur, pen.fr / FLIGHT_MIN_S);
      let pose = flightPose(fl, uOf(pen.ft));
      const mvTo = (q: Pose) => penMove(pen.tip, pen.dir, fT.set(...q.tip), fD.set(...q.dir));
      const handCap = brakeCap(mvTo(fl.to), true); // the hop's cap, and the brake into the landing
      if (mvTo(pose) > handCap) {
        // the hand's cap, on every frame, in view or not (v6: flights in and out of view too), on every point of the pen (v7): the arc
        // advances only as far as the cap lets the pen move this frame (bisection on the arc's time)
        const cap = handCap; let lo = ft0, hi = pen.ft;
        for (let k = 0; k < 7; k++) { const mid = (lo + hi) / 2; if (mvTo(flightPose(fl, uOf(mid))) <= cap) lo = mid; else hi = mid; }
        pen.ft = lo; pose = flightPose(fl, uOf(pen.ft));
      }
      const u = uOf(pen.ft);
      pen.tip.set(...pose.tip); pen.dir.set(...pose.dir);
      if (u >= 1) { pen.off.copy(pen.tip).sub(new THREE.Vector3(...g.tip)); pen.flight = null; } // the small drift since the plan fades over the next frames
      return true;
    }
    pen.off.multiplyScalar(Math.max(0, 1 - dt * 10));
    const want = new THREE.Vector3(...g.tip).add(pen.off), wantDir = pen.dir.clone().lerp(new THREE.Vector3(...g.dir), Math.min(1, dt * 10)).normalize();
    // a short move (under JUMP, no arc) and the turn toward the goal's axis, at the hand's cap on every point of the pen; a writing step's
    // tip move was sized to the cap already, so there only the turn gives way
    const at = (f: number) => [step ? want : fT.copy(pen.tip).lerp(want, f), fD.copy(pen.dir).lerp(wantDir, f).normalize()] as const;
    const cap = step ? handCap : brakeCap(penMove(pen.tip, pen.dir, ...at(1)));
    let f = 1; { const [a, b] = at(1); if (penMove(pen.tip, pen.dir, a, b) > cap) { let lo = 0, hi = 1; for (let k = 0; k < 8; k++) { const mid = (lo + hi) / 2, [c, d] = at(mid); if (penMove(pen.tip, pen.dir, c, d) <= cap) lo = mid; else hi = mid; } f = lo; } }
    const [nt, nd] = at(f); pen.tip.copy(nt); pen.dir.copy(nd);
    return false;
  }

  /** Every program the scene will need, compiled now: with the lights and environment in, each material (an object out of the frame, like the
   *  phone's pen, or not shown yet, like the polaroids and the model-alone paper, compiled the moment it first appeared: owner feedback's dropped
   *  frames at the first photos), and the shadow pass's own, in a render with every mesh shown and casting that this frame's real render
   *  overwrites (never on screen). On the first frame, in the load's own pause. New polaroids later (v25, G3: the forced render uploaded all
   *  their canvases at once, a 170-230 ms frame as the data came in): their programs compile in parallel (KHR_parallel_shader_compile) and
   *  their textures go up one a frame (warmQ), long before their drop. */
  let warmed = false;
  function warmUp(): void {
    warmDirty = false;
    if (warmed) { renderer.compileAsync(scene, camera).catch(() => {}); return; }
    warmed = true;
    const shown: THREE.Object3D[] = [], cast: THREE.Object3D[] = [];
    scene.traverse((x) => { if (!(x as THREE.Mesh).isMesh) return; if (!x.visible) { x.visible = true; shown.push(x); } if (!x.castShadow) { x.castShadow = true; cast.push(x); } });
    renderer.compile(scene, camera); renderer.render(scene, camera);
    // never stripTex (v25, H1): a texture with a GPU copy makes copyTextureToTexture blit that copy (r186), not the strip's canvas, so the
    // pen's fresh rows were overwritten by the blank strip it was warmed with
    for (const x of shown) x.visible = false; for (const x of cast) x.castShadow = false;
  }
  /* ---------- per frame ---------- */
  let last = performance.now(); let raf = 0; let lastCamKey = "";
  const tmpQ = new THREE.Quaternion();
  function frame(nowMs: number): void {
    if (disposed) return;
    // never negative (v25): the first frame's rAF time can be earlier than the start's performance.now(), and a negative step ran every
    // polaroid's drop backwards, up off the counter, at the load
    const dt = Math.max(0, Math.min(0.05, (nowMs - last) / 1000)); last = nowMs;
    const c0 = performance.now();
    if (pendingData) { const d = pendingData; pendingData = null; applyData(d); cost.apply = Math.max(cost.apply, performance.now() - c0); }
    // the hand this frame: the cap; it eases up from a pause (FLICK_ACC of the cap a frame), and once t has landed it slows to a stop at
    // the allowance's end (v8, LOW; v13: the same for every input)
    const ms = now(); const t0 = t; advance(dt);
    handCap = capPx(); hopCap = capPx() * FEEL.hopCapK;
    if (!RM) {
      handCap = Math.min(handCap, dbg.move + FLICK_ACC * capPx()); hopCap = Math.min(hopCap, dbg.move + FEEL.hopAcc * capPx());
      if (t === tTarget && ms - lastMoveMs > OPEN_S * 1000 && !camCatch) { const k = Math.min(1, Math.max(0, penUntil() - ms) / (FLICK_EASE_S * 1000)); handCap *= k; hopCap *= k; }
    }
    const open = (penOpen = inkOpen(ms)), live = open || t !== t0; // the reader is moving (or t still playing toward their scroll): only then does anything move
    // what changed on the model-alone paper: before its print-out it is unseen, and from it its rows come in on their clock (#511), so at once
    // (it used to wait for the reader's next move: an answer that came after the reader stopped was never printed)
    if (th.held) applyTheirs();
    if (thAt == null && (th.ready || th.asking) && (RM ? t : camShown) >= T_PROOF0) thAt = ms; // the camera has reached the proof: its print-out begins (#511)
    { const k = theirsUpto(); if (k !== theirs.printedLines) { theirs.printedLines = k; theirs.paint(); } } // the late rows print on the blank paper on their clock
    if (!theirs.group.position.equals(theirsHome)) { if (!theirs.mesh.visible) theirs.group.position.copy(theirsHome); else if (live) { theirs.group.position.lerp(theirsHome, 1 - Math.exp(-dt * 12)); if (theirs.group.position.distanceTo(theirsHome) < 1e-3) theirs.group.position.copy(theirsHome); } }
    // the papers: printed to the timeline's length, on t only (the next month's lines appear as it prints: L1)
    const showNext = t >= T_NEXT0; if (showNext !== nextShown) { const c1 = performance.now(); nextShown = showNext; baseDirty = true; if (ready) paintAll(layout?.nextStart != null ? lineY(layout.nextStart) - 8 : undefined); cost.paint = Math.max(cost.paint, performance.now() - c1); }
    ours.time = 0; theirs.time = 0; // the lying paper's sway is a still: nothing moves on its own clock
    setPrinted(ours, enterPrinted(printedFor(t))); ours.update(0);
    setPrinted(theirs, theirsAt(ms)); theirs.mesh.visible = theirs.printed > 0.04; if (theirs.mesh.visible) theirs.update(0);
    // the ink: laid by the pen; repaint what changed
    const changed = writeFrame(dt);
    // the polaroids
    for (const c of cards.values()) {
      // a polaroid whose place is under the model-alone receipt lies there flat: no drop through the air and no hover lift over that paper (v5, M8)
      const under = theirs.mesh.visible && Math.abs(c.home.x - theirs.group.position.x) < theirs.W / 2 + POLAROID_W / 2
        && c.home.z + POLAROID_H / 2 > theirs.group.position.z && c.home.z - POLAROID_H / 2 < theirs.group.position.z + theirs.printed;
      // the hover lift answers the pointer (or a card scrolled under a still one) within ~0.12 s and then holds (v6, M2: nothing drifts after
      // the reader stops; v7: everything still within 0.25 s of the scroll)
      const liftTo = hoverKey === c.key && c.live && !under ? 0.12 : 0;
      c.lift += (liftTo - c.lift) * Math.min(1, dt * 30);
      if (under || Math.abs(liftTo - c.lift) < 3e-3) c.lift = liftTo;
      const u0 = cardU(c, ms, dt), u = under && u0 > 0.001 ? 1 : u0;
      if (u <= 0.001) { c.m.visible = false; c.y = 1; continue; }
      // a landed card the slip moved aside slides to its new place while the reader moves (v6, M2: never on its own after a stop)
      const at = (c.at ??= c.home.clone()); if (c.m.visible && !RM) { if (live) at.lerp(c.home, 1 - Math.exp(-dt * 20)); if (at.distanceTo(c.home) < 1e-3) at.copy(c.home); } else at.copy(c.home);
      c.m.visible = true; c.m.castShadow = u > 0.98; { const m = c.m.material as THREE.MeshStandardMaterial, op = RM ? 1 : ease(clamp01(u / FEEL.cardFade)); if (m.opacity !== op) { m.opacity = op; m.depthWrite = op > 0.99; } } { const px = at.x - 0.3 * (1 - u), pz = at.z - 0.3 * (1 - u); c.m.position.set(px, Math.max(at.y, Math.min(at.y + CARD_FALL * (1 - u) + c.lift, underPen(px, pz))), pz); } c.m.rotation.z = c.rz; c.y = c.m.position.y;
    }
    // the pen (B: always on the counter; v7: at rest it lies in our paper's right margin, in the frame)
    if (objs.pen) {
      const g = goal ?? { pose: parkPose(camA.z), touch: false, job: null, inView: false };
      const tipBefore = pen.tip.clone(), dirBefore = pen.dir.clone();
      // the pen moves only within OPEN_S of the reader's last move (a flick's allowance): past it, it stays where it is (v6, H1 and M9)
      // and, off the paper, while the camera catches up after the reader stopped (v25): the pen keeps its place in the moving frame
      const inFlight = open || (camCatch && !g.touch) ? follow(g.pose, dt, !!g.step) : !!pen.flight;
      // the ink laid this frame stays only if the tip is on it now (the pen never flies off a line it is writing: if it had to, the line waits)
      if (laid && (inFlight || pen.tip.distanceTo(tipWorld(inkTip(laid.job, laid.to))) > HEAD_TOL)) {
        penProg.set(laid.job.seq, laid.from); if (lastInk?.job === laid.job) lastInk.pr = laid.from; dbg.reverted++;
        if (laid.from <= 0 && changed.length === 1) changed.length = 0;
        // and the pen goes back to where the ink stopped, so it does not land past it and bounce between the two
        const bt = tipWorld(inkTip(laid.job, laid.from)).toArray() as V3, back: Pose = { tip: bt, dir: writeDir(bt) };
        pen.flight = flightTo({ tip: pen.tip.toArray() as V3, dir: pen.dir.toArray() as V3 }, back, obstacleBoxes()); pen.ft = pen.fr = 0;
        if (goal) goal.pose = back;
      }
      dbg.move = penMove(tipBefore, dirBefore, pen.tip, pen.dir);
      // the pen has work left: on a flight, ink behind t, or short of its goal (a stop that lands as a line opens leaves it mid-way in: v13)
      penBusy = !!pen.flight || lastBacklog > 0.5 || pen.tip.distanceTo(sC.set(...g.pose.tip)) > 0.002;
      const penObj = objs.pen; penObj.visible = true;
      // a phone (v11, F4): a pen wholly out of the frame casts no shadow into it (its shadow alone read as a smudge in the corner)
      const shadow = camera.aspect >= 0.8 || anyIn(pen.tip, pen.dir);
      if (shadow !== penShadow) { penShadow = shadow; penObj.traverse((x) => { if ((x as THREE.Mesh).isMesh) x.castShadow = shadow; }); }
      penObj.quaternion.copy(tmpQ.setFromUnitVectors(PEN_UP, pen.dir));
      penObj.position.copy(pen.tip).addScaledVector(pen.dir, -penTipOff);
      // the check: the pen's capsule against every object's bounds, every frame
      const pose: Pose = { tip: pen.tip.toArray() as V3, dir: pen.dir.toArray() as V3 };
      const boxes = obstacleBoxes(); const hit = hits(pose, penDims, boxes, slackFor);
      if (hit.length) { collisions++; if (firstHits.length < 8) firstHits.push({ t: +t.toFixed(3), hit, tip: pose.tip.map((v) => +v.toFixed(3)) as V3 }); }
      if (penFrames.length < 20000) penFrames.push([...[...pose.tip, ...pose.dir].map((v) => +v.toFixed(4)), boxSetId(boxes), inFlight ? 1 : 0, +t.toFixed(4)] as PenLog["frames"][number]);
    }
    { const c1 = performance.now(); if (changed.length === 1) paintStrip(changed[0]); else if (changed.length) paintAll(); cost.paint = Math.max(cost.paint, performance.now() - c1); }
    // the camera: the timeline's focus at t, held back to where the pen's ink is, on a spring (FEEL.camOmega) for what jumps
    // without the scroll (a caption, the data); it moves only while the reader does (v6, M1/L2: no glide after a stop), and snaps on arrival
    const camGoal = Math.min(t, penT(), runCap());
    if (RM || camSnap) { camT = camGoal; camTV = 0; camCatch = false; } else {
      const d = camGoal - camT;
      if (!camCatch && Math.abs(d) > FEEL.camCatchGap) camCatch = true;
      if (!camCatch) { camT = camGoal; camTV = 0; } else {
        const a = FEEL.camCatchA, want = Math.sign(d) * Math.min(FEEL.camCatchV, Math.sqrt(2 * a * Math.abs(d)));
        camTV += Math.max(-a * dt, Math.min(a * dt, want - camTV)); camT += camTV * dt;
        if (Math.abs(camGoal - camT) < 2e-3 || Math.sign(camGoal - camT) !== Math.sign(d)) { camT = camGoal; camTV = 0; camCatch = false; }
      }
    }
    if (RM || camSnap) { camShown = camT; camShownV = 0; } else {
      const w = camSoft ? FEEL.enterOmega : FEEL.camOmega, x = camShown - camT, e = Math.exp(-w * dt), b = camShownV + w * x;
      camShown = camT + (x + b * dt) * e; camShownV = (camShownV - w * b * dt) * e;
    }
    let snapped = false;
    if (live || camSnap || camGlide || camSoft || camCatch || RM) {
      const f = focusAt(camT);
      if (camSnap || RM) { camP.copy(f.pos); camA.copy(f.aim); camSnap = camGlide = camSoft = false; camVP.set(0, 0, 0); camVA.set(0, 0, 0); snapped = true; }
      else if (camSoft && lastMoveMs < 0) {
        spring(camP, camVP, f.pos, FEEL.enterOmega, dt); spring(camA, camVA, f.aim, FEEL.enterOmega, dt);
        if (camP.distanceTo(f.pos) < CAM_SNAP && camA.distanceTo(f.aim) < CAM_SNAP && camVP.length() + camVA.length() < 0.01 && now() - enterAt > FEEL.enterS * 1000) { camP.copy(f.pos); camA.copy(f.aim); camVP.set(0, 0, 0); camVA.set(0, 0, 0); camSoft = false; }
        if (lastMoveMs < 0) restOut(); // the phone's pen waits past the frame's edge, with the frame
      } else {
        // the camera rides its own critically damped spring on the stops' path at t (owner feedback: on Dev's October and proof the path's
        // kinks between stops and its clamps' bursts showed as hitches and sudden speed-ups): no kink reaches the frame, and its speed
        // never jumps; its speed stays under CAM_STEP a frame. It settles on its stop and holds
        camSoft = false;
        spring(camP, camVP, f.pos, FEEL.camOmega, dt); spring(camA, camVA, f.aim, FEEL.camOmega, dt);
        const vmax = CAM_STEP * 60; if (camVP.length() > vmax) camVP.setLength(vmax); if (camVA.length() > vmax) camVA.setLength(vmax);
        if (camP.distanceTo(f.pos) < CAM_SNAP && camA.distanceTo(f.aim) < CAM_SNAP && camVP.length() + camVA.length() < 0.01) { camP.copy(f.pos); camA.copy(f.aim); camVP.set(0, 0, 0); camVA.set(0, 0, 0); camGlide = false; } else camGlide = true;
      }
    }
    look.x += (look.to - look.x) * (RM ? 1 : 1 - Math.exp(-dt * FEEL.lookK)); if (Math.abs(look.to - look.x) < 1e-4) look.x = look.to;
    camera.position.copy(camP); camera.position.x += look.x * 0.08; camera.lookAt(camA); camera.updateMatrixWorld();
    if (snapped && lastMoveMs < 0) restOut(); // the first view (and the door's frame, set before the reader's first move): the phone's pen waits past the edge
    // what the app laid over the frame follows the camera: the slip on the counter, the hover tag beside its row (re-checked when the view moved)
    slipFrame(dt); captionFrame(); doorFrame(); veilFrame(dt);
    const camKey = `${camera.position.toArray().map((v) => v.toFixed(4))}|${camA.toArray().map((v) => v.toFixed(4))}`;
    if (camKey !== lastCamKey) { lastCamKey = camKey; if (pointer.mouse || tipShown) hover(); }
    // the section the nav and the captions show: Swaps from the moment the pen starts on the swaps (v6, L1), else the nearest stop
    //
    const sec = camT >= T_W0 + 0.05 && camT < 2.5 ? 2 : Math.min(N - 1, Math.round(camT)); if (sec !== lastSec) { lastSec = sec; o.onSection(sec); }
    // the model-alone question goes out as the reader reaches October, so its blank paper is in its place when Proof comes in (v7, M2: no paper popping in);
    // on the reader's t, not the camera's (#511: held behind the pen, the camera asked so late the answer missed the proof's print-out)
    if (t >= 3 && !proofFired) { proofFired = true; o.onProofVisible(); }
    // the model-alone rows on its paper: the caption quoting them follows the paper, never the data's arrival (v7, M2: nothing pops without a scroll)
    { const tp = th.ready && theirs.mesh.visible && theirs.printedLines > TH_HEAD; if (tp !== theirsShown) { theirsShown = tp; o.onTheirsPrinted?.(tp); } }
    steam?.update(ms, camera.position);
    askFrame();
    const c2 = performance.now();
    if (stripQ.length) copyStrip(stripQ.shift()!); // the next month's block, a strip a frame
    if (warmDirty) warmUp(); else { const wt = warmQ.values().next().value; if (wt) { warmQ.delete(wt); renderer.initTexture(wt); } } // one polaroid texture a frame, ahead of its drop
    const c3 = performance.now(); renderer.render(scene, camera); texUploaded = true; raf = requestAnimationFrame(frame);
    const c4 = performance.now(); cost.upload = Math.max(cost.upload, c3 - c2); cost.render = Math.max(cost.render, c4 - c3); cost.frame = Math.max(cost.frame, c4 - c0);
    if (!shown) { shown = true; shownMs = now(); o.onReady(); } // the first real frame is on the canvas: the page shows it (v6, M3: nothing before it)
  }

  /* ---------- pointer ---------- */
  function lineAt(): number {
    ndc.set(pointer.x, pointer.y); ray.setFromCamera(ndc, camera); return ours.hitLine(ray);
  }
  function targetAt(): PenTarget | null {
    if (!layout) return null; const li = lineAt(); const l = li >= 0 ? ours.lines[li] : null; const k = l && (l.t === "pen" || l.t === "row" || l.t === "ev" || l.t === "bridge") ? l.key : undefined;
    return k ? layout.pens.find((x) => x.key === k) ?? null : null;
  }
  /**
   * The hover: which row the mouse is on (its twin's photo lifts, the cursor says it can be clicked) and its tag. The tag sits beside the paper,
   * level with the row, on the side clear of the other receipt and the slip (PM, v5: never over row text); never on a phone or under a finger.
   * Re-checked whenever the camera moves, so a tag never stays behind on a row that scrolled away from under a still mouse.
   */
  let tipEl: HTMLElement | null = null, tipShown = "";
  const TIP_GAP = 0.03; // m between the paper's edge and the tag
  function hover(): void {
    const pt = pointer.mouse && camera.aspect >= 0.8 ? targetAt() : null;
    const k = pt && pt.tip ? pt.key : null;
    if (k !== mutedKey) mutedKey = null;
    if (k !== hoverKey) {
      hoverKey = k; // the twin's photo lifts under the pointer (in the frame loop)
      canvas.style.cursor = pt && pt.swapId && (pt.status === "proposed" || pt.status === "accepted" || pt.status === "rejected") ? "pointer" : "";
    }
    placeTip(pt && pt.tip && pt.key !== mutedKey ? pt : null);
  }
  function placeTip(pt: PenTarget | null): void {
    const el = tipEl; if (!el) return;
    let at: { x: number; y: number; left: boolean } | null = null;
    if (pt) {
      const z = ours.lineWorldY(pt.rowLi), w = Math.ceil(pt.tip.length * 7.4 + 26), hh = 16; // the tag's size at 13 px (its text is short)
      const scr = (x: number) => { const v = new THREE.Vector3(x, PAPER_Y, z).project(camera); return { x: ((v.x + 1) / 2) * viewW, y: ((1 - v.y) / 2) * viewH }; };
      const sb = slipBox(), theirsIn = theirs.mesh.visible && camera.aspect >= 0.8;
      const fits = (x0: number, y: number) => x0 >= 4 && x0 + w <= viewW - 4 && y - hh >= 0 && y + hh <= viewH && !(sb && x0 < sb.x1 && x0 + w > sb.x0 && y - hh < sb.y1 && y + hh > sb.y0);
      const r = scr(ours.W / 2 + TIP_GAP), l = scr(-ours.W / 2 - TIP_GAP);
      if (!theirsIn && fits(r.x, r.y)) at = { x: r.x, y: r.y, left: false };
      else if (fits(l.x - w, l.y)) at = { x: l.x, y: l.y, left: true };
    }
    const key = at && pt ? `${pt.tip}|${Math.round(at.x)}|${Math.round(at.y)}|${at.left ? 1 : 0}` : "";
    if (key === tipShown) return; tipShown = key;
    if (!at || !pt) { el.style.display = "none"; return; }
    if (el.textContent !== pt.tip) el.textContent = pt.tip;
    el.style.left = `${at.x.toFixed(1)}px`; el.style.top = `${at.y.toFixed(1)}px`; el.style.transform = at.left ? "translate(-100%, -50%)" : "translate(0, -50%)"; el.style.display = "block";
  }
  /** The mouse parallax's target: the pointer's x across the window (-1..1), anywhere on the page, the door's cards included; 0 when it leaves. */
  function setLook(x: number): void { look.to = Math.max(-1, Math.min(1, x)); }
  function setPointer(x: number, y: number, cx: number, cy: number, mouse = true): void {
    pointer.x = x; pointer.y = y; pointer.cx = cx; pointer.cy = cy; pointer.mouse = mouse;
    hover();
  }
  function click(): void {
    const pt = targetAt(), a = answerFor(pt); if (!pt || !a) return;
    mutedKey = pt.key; placeTip(null); // the answer is on the paper, not in a box
    if ("reject" in a) o.onReject(a.reject); else o.onUndo(a.undo);
  }

  /* ---------- misc ---------- */
  function resize(): void {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    viewW = w; viewH = h; renderer.setSize(w, h, false); camera.aspect = w / h; camera.fov = camera.aspect < 0.8 ? 36 : 28; camera.updateProjectionMatrix(); clearCache.clear();
    tTarget = clampT(tTarget); t = Math.min(t, N - 1 + extraT()); camSnap = true; // a phone turned sideways past the proof's second viewport
    placeTheirs(); // beside ours or below it, by the aspect
    fitPen();
  }
  function savePng(): void {
    if (!layout) return;
    const src = ours.canvas, c = document.createElement("canvas"); c.width = 1080; c.height = 1920; const g = c.getContext("2d")!;
    g.fillStyle = "#e8e2d6"; g.fillRect(0, 0, 1080, 1920);
    const y0 = lineY(layout.nextStart ?? layout.tasteStart ?? 0), hh = src.height - y0, s = Math.min(760 / src.width, 1700 / hh);
    g.drawImage(src, 0, y0, src.width, hh, (1080 - src.width * s) / 2, (1920 - hh * s) / 2, src.width * s, hh * s);
    const a = document.createElement("a"); a.download = "sametaste-receipt.png"; a.href = c.toDataURL("image/png"); a.click();
  }
  const clampT = (x: number) => Math.max(0, Math.min(N - 1 + extraT(), x));
  function setScroll(pp: number, px?: number): void {
    if (o.controlled) return; const v = clampT(pp); if (v !== tTarget) moved(px); tTarget = v; if (RM || !ready) t = tTarget;
  }
  let veilLine = -1, veilUp = false, veilTop = NaN;
  const vV = new THREE.Vector3(), vCam = new THREE.PerspectiveCamera();
  /** Whether a receipt is under the top bar or nearing it (its corners' highest point on screen, led by its speed), told on a change. */
  function veilFrame(dt: number): void {
    if (veilLine < 0 || !o.onPaperUnder) return;
    let top = Infinity;
    const at = (v: THREE.Vector3) => { v.project(camera); if (v.z < 1) top = Math.min(top, ((1 - v.y) / 2) * viewH); };
    for (const x of [-ours.W / 2, ours.W / 2]) for (const z of [0, ours.printed]) at(vV.set(x, PAPER_Y, z));
    if (theirs.mesh.visible) for (const x of [-theirs.W / 2, theirs.W / 2]) for (const z of [0, theirs.printed]) at(theirs.group.localToWorld(vV.set(x, 0, z)));
    const speed = Number.isFinite(veilTop) && Number.isFinite(top) && dt > 0 ? (veilTop - top) / dt : 0; veilTop = top;
    const near = (y: number) => y < veilLine + VEIL_LEAD + (veilUp ? VEIL_HYST : 0);
    let up = near(top - Math.max(0, speed) * VEIL_LEAD_S);
    // and where t is going (v14, LOW: on /demo's first flick the paper starts ~90 px under the bar and is under the nav's text in 0.2 s,
    // before its speed on screen told): our paper's head along the way to the target, at the camera's focus there; t lands within ~0.7 s,
    // so the veil (0.5 s to come up) is up as it arrives
    if (!up && Math.abs(tTarget - t) > 1e-3) for (const k of VEIL_PATH) {
      const f = focusAt(t + (tTarget - t) * k); vCam.copy(camera); vCam.position.copy(f.pos); vCam.lookAt(f.aim); vCam.updateMatrixWorld();
      let y = Infinity;
      for (const x of [-ours.W / 2, ours.W / 2]) for (const z of [0, ours.printed]) { vV.set(x, PAPER_Y, z).project(vCam); if (vV.z < 1) y = Math.min(y, ((1 - vV.y) / 2) * viewH); }
      if (near(y)) { up = true; break; }
    }
    if (up !== veilUp) { veilUp = up; o.onPaperUnder(up); }
  }
  function setVeilLine(px: number): void { veilLine = px; }
  function setTopInset(px: number, rightPx = px): void { if (px !== topInset || rightPx !== topInsetR) { topInset = px; topInsetR = rightPx; clearCache.clear(); reframe(); } }
  function setBottomInset(px: number): void { px = Math.round(px); if (px !== bottomInset) { bottomInset = px; clearCache.clear(); reframe(); } }
  /** The phone's front door (v10): the slot the page keeps for our paper between the persona cards and the drop card. */
  let doorSlot: { top: number; bottom: number } | null = null;
  const doorV = new THREE.Vector3();
  /** The door's camera (the first stop's offset, nothing tighter): its aim so that the paper's printed part (its head) sits in the middle of the
   *  slot; and that part's height on screen there. A point's place on screen depends only on its z less the aim's, the camera moving with it. */
  function doorFocus(slot: { top: number; bottom: number }): { f: Focus; h: number } {
    const H = canvas.clientHeight || window.innerHeight, e = Math.max(0.02, ours.printed), mid = (slot.top + slot.bottom) / 2;
    const cam = camera.clone(); cam.position.copy(PORTRAIT_OFF); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
    // the head's top and foot on screen with the aim at z: its surface as the probe draws it (the curl's lift too), at its edges and middle
    const span = (z: number): [number, number] => {
      let a = Infinity, b = -Infinity;
      for (let i = 0; i <= 16; i++) for (const x of [-ours.W / 2, 0, ours.W / 2]) { const pz = (e * i) / 16; doorV.set(x, PAPER_Y + ours.surfaceLift(x, pz), pz - z).project(cam); const y = ((1 - doorV.y) / 2) * H; a = Math.min(a, y); b = Math.max(b, y); }
      return [a, b];
    };
    let lo = -4, hi = 4; // the aim's z: further down the paper moves the paper up the screen
    for (let k = 0; k < 32; k++) { const z = (lo + hi) / 2, [a, b] = span(z); if ((a + b) / 2 > mid) lo = z; else hi = z; }
    const z = (lo + hi) / 2, [a, b] = span(z);
    return { f: { pos: new THREE.Vector3(PORTRAIT_OFF.x, PORTRAIT_OFF.y, z + PORTRAIT_OFF.z), aim: new THREE.Vector3(0, 0, z) }, h: b - a };
  }
  let doorCb: ((px: number) => void) | null = null, doorKey = "";
  function setDoorSlot(slot: { top: number; bottom: number } | null, onHeight?: (px: number) => void): void {
    const was = doorSlot; doorSlot = slot && slot.bottom > slot.top ? slot : null; doorCb = onHeight ?? null; doorKey = "";
    if (JSON.stringify(was) !== JSON.stringify(doorSlot)) reframe();
    doorFrame();
  }
  /** Each frame: the head's height on screen to the page when it changed (the header printed, a resize) */
  function doorFrame(): void {
    if (!doorSlot || !doorCb || camera.aspect >= 0.8) return;
    const k = `${ours.printed.toFixed(4)}|${canvas.clientHeight}|${camera.aspect.toFixed(4)}`; if (k === doorKey) return; doorKey = k;
    doorCb(Math.round(doorFocus(doorSlot).h));
  }
  function setCaptionBox(r: { x1: number; y1: number } | null): void {
    const k = r ? `${Math.round(r.x1)},${Math.round(r.y1)}` : ""; if (k !== capKey) { capKey = k; capBox = r && { x1: Math.round(r.x1), y1: Math.round(r.y1) }; clearCache.clear(); reframe(); }
    captionFrame(); // a new caption: hidden at once if the frame has our paper under it
  }
  function setSection(i: number): void { const v = clampT(i); if (v !== tTarget) moved(); tTarget = v; if (RM || !ready) t = tTarget; }
  /** Back to the door: t = 0 at once, the pen at rest, the camera on the first stop; the data stays (its ink and papers follow t, so they are as before the start). */
  function reset(): void {
    t = 0; tTarget = 0; tv = 0; tLandMs = -1e9; lieZ = null; thAt = thRowsAt = null; th.ink = false; camShown = camShownV = 0; camT = camTV = 0; camCatch = false; if (runHold != null) runHold = 0; dropAt = -1e9; for (const c of cards.values()) c.dv = 0; proofFired = false; lastSec = -1; lastInk = null; goal = null; lastMoveMs = flickUntil = -1e9; scrollHist.length = 0;
    for (const j of jobs) penProg.set(j.seq, 0);
    pen.flight = null; pen.off.set(0, 0, 0); const r = parkPose(focusAt(0).aim.z); pen.tip.set(...r.tip); pen.dir.set(...r.dir);
    camSnap = true;
    hoverKey = null; mutedKey = null; placeTip(null); canvas.style.cursor = "";
    if (ready) paintAll();
  }
  function seek(i: number): void { const v = clampT(i); if (v !== tTarget) moved(); tTarget = v; if (RM || !ready) t = tTarget; }

  /* ---------- the probe (eval/motion) ---------- */
  const ROW_TYPES = new Set(["head", "sub", "row", "swap", "kv", "total", "big", "note", "pen", "ev", "bridge"]);
  const rv = new THREE.Vector3(), rRay = new THREE.Ray(), rHit = new THREE.Vector3(), rBox = new THREE.Box3();
  const quad = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  /**
   * M8: every printed row with ink of both receipts that is on screen, as its screen bbox (the paper's text width, the row's height), and the
   * 3D object, if any, between the camera and the row (three points along its middle; boxes for the cup, the card and the other receipt,
   * the quad for a polaroid; the pen is not counted).
   */
  function rowRects(glyphs?: number[][]): number[][] {
    const out: number[][] = []; if (!layout) return out;
    const inked = new Set<number>();
    for (const j of jobs) { const p = penProg.get(j.seq) ?? 0; if (p > 0) inked.add(j.li); if (j.kind === "twin" && p >= 1) { inked.add(j.t.evLi); if (j.t.alsoLi != null) inked.add(j.t.alsoLi); } }
    const boxes = obstacleBoxes(), boxOf = (n: string) => boxes.find((b) => b.name === n);
    const cup = boxOf("cup"), card = boxOf("card"), curl = boxOf("curl"), other = boxOf("theirs");
    const photos = [...cards.values()].filter((c) => c.m.visible).map((c) => { c.m.updateMatrixWorld(); const g = c.m.geometry; if (!g.boundingBox) g.computeBoundingBox(); const b = g.boundingBox!; return [[b.min.x, b.min.y], [b.max.x, b.min.y], [b.max.x, b.max.y], [b.min.x, b.max.y]].map(([x, y]) => new THREE.Vector3(x, y, 0).applyMatrix4(c.m.matrixWorld)); });
    const hitBox = (b: { min: V3; max: V3 } | undefined, dist: number) => !!b && !!rRay.intersectBox(rBox.set(rv.set(...b.min), new THREE.Vector3(...b.max)), rHit) && rHit.distanceTo(rRay.origin) < dist - 0.005;
    const occluder = (p: THREE.Vector3, which: 0 | 1): number => {
      const dist = p.distanceTo(camera.position); rRay.origin.copy(camera.position); rRay.direction.copy(p).sub(camera.position).normalize();
      if (hitBox(cup, dist)) return 1; if (hitBox(card, dist)) return 2;
      for (const q of photos) { if ((rRay.intersectTriangle(q[0], q[1], q[2], false, rHit) || rRay.intersectTriangle(q[0], q[2], q[3], false, rHit)) && rHit.distanceTo(rRay.origin) < dist - 0.005) return 3; }
      if (hitBox(which === 0 ? other : curl, dist)) return 4;
      return 0;
    };
    const one = (r: Receipt, which: 0 | 1, li: number, fromTotal: number) => {
      const l = r.lines[li]; if (!l || !ROW_TYPES.has(l.t)) return;
      if (which === 0 && (l.t === "pen" || l.t === "ev" || l.t === "bridge") && !inked.has(li)) return; // a pen line is blank paper until written
      if (which === 0 && !nextShown && layout && layout.nextStart != null && li >= layout.nextStart) return; // so is the next month's block before it prints
      if (which === 1 && li >= r.printedLines) return; // and the model-alone receipt's rows before they print on its blank paper
      const top = r.lineTop(li), h = r.lineH(l), d0 = (top / r.px) * r.W, d1 = ((top + h) / r.px) * r.W;
      if (d1 > r.printed) return;
      const x0 = (r.pad / r.px - 0.5) * r.W, x1 = (0.5 - r.pad / r.px) * r.W;
      let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
      for (const [x, d] of [[x0, d0], [x1, d0], [x1, d1], [x0, d1]]) {
        r.group.localToWorld(rv.set(x, r.surfaceLift(x, d), d)); const v = rv.project(camera); if (v.z >= 1) return;
        const sx = ((v.x + 1) / 2) * viewW, sy = ((1 - v.y) / 2) * viewH; sx0 = Math.min(sx0, sx); sy0 = Math.min(sy0, sy); sx1 = Math.max(sx1, sx); sy1 = Math.max(sy1, sy);
      }
      if (sx1 < 0 || sx0 > viewW || sy1 < 0 || sy0 > viewH) return;
      let occ = 0;
      for (const f of [0.15, 0.5, 0.85]) { const x = x0 + (x1 - x0) * f, d = (d0 + d1) / 2; const p = r.group.localToWorld(quad[0].set(x, r.surfaceLift(x, d) + 0.001, d)).clone(); occ = occluder(p, which); if (occ) break; }
      out.push([+sx0.toFixed(1), +sy0.toFixed(1), +sx1.toFixed(1), +sy1.toFixed(1), which, li, fromTotal, occ]);
      if (glyphs) glyphs.push(glyphBoxes(r, top, h));
    };
    for (let li = 0; li < ours.lines.length; li++) one(ours, 0, li, li >= layout.totalLi ? 1 : 0);
    if (theirs.mesh.visible) for (let li = 0; li < theirs.lines.length; li++) one(theirs, 1, li, 1);
    return out;
  }
  /**
   * The row's ink on screen (v9 ruling: the barrel may not cover a glyph of another row): its painted pixels (print and handwriting, darker
   * than the paper by 60 or red) in the receipt's canvas, by runs of columns a glyph's width apart, each run's box projected; flat [x0, y0, x1, y1, …].
   */
  function glyphBoxes(r: Receipt, top: number, h: number): number[] {
    const y0 = Math.max(0, Math.floor(top)), hh = Math.min(r.canvas.height - y0, Math.ceil(h)), W = r.px; if (hh <= 0) return [];
    const px = r.ctx.getImageData(0, y0, W, hh).data, lum = (i: number) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    const pc = new THREE.Color(r.paper), paperL = 255 * (0.299 * pc.r + 0.587 * pc.g + 0.114 * pc.b);
    const colTop = new Array<number>(W).fill(-1), colBot = new Array<number>(W).fill(-1);
    for (let x = 0; x < W; x++) for (let y = 0; y < hh; y++) { const i = (y * W + x) * 4; if (px[i + 3] > 128 && (lum(i) < paperL - 60 || px[i] - px[i + 1] > 60)) { if (colTop[x] < 0) colTop[x] = y; colBot[x] = y; } }
    const out: number[] = []; const GAP = 3;
    for (let x = 0; x < W; ) {
      if (colTop[x] < 0) { x++; continue; }
      let x1 = x, t = colTop[x], b = colBot[x], gap = 0;
      for (let k = x + 1; k < W && gap <= GAP; k++) { if (colTop[k] < 0) { gap++; continue; } gap = 0; x1 = k; t = Math.min(t, colTop[k]); b = Math.max(b, colBot[k]); }
      let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
      for (const [cx, cy] of [[x, y0 + t], [x1 + 1, y0 + t], [x1 + 1, y0 + b + 1], [x, y0 + b + 1]]) {
        const lx = (cx / W - 0.5) * r.W, d = (cy / W) * r.W; r.group.localToWorld(rv.set(lx, r.surfaceLift(lx, d), d)); const v = rv.project(camera);
        const sx = ((v.x + 1) / 2) * viewW, sy = ((1 - v.y) / 2) * viewH; sx0 = Math.min(sx0, sx); sy0 = Math.min(sy0, sy); sx1 = Math.max(sx1, sx); sy1 = Math.max(sy1, sy);
      }
      out.push(+sx0.toFixed(1), +sy0.toFixed(1), +sx1.toFixed(1), +sy1.toFixed(1)); x = x1 + 1;
    }
    return out;
  }
  /** the previous probe's camera and pen (tip, middle, cap end), for the pen's own move between two samples: `pen.rel` */
  const probePrev = { vp: new THREE.Matrix4(), pts: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], ok: false };
  function probe(): SceneProbe {
    const W = canvas.clientWidth || window.innerWidth, H = canvas.clientHeight || window.innerHeight;
    const penPts = [0, 0.5, 1].map((f) => pen.tip.clone().addScaledVector(pen.dir, penDims.length * f));
    let rel = 0;
    if (probePrev.ok) for (let k = 0; k < 3; k++) { const a = probePrev.pts[k].clone().applyMatrix4(probePrev.vp), b = penPts[k].clone().applyMatrix4(probePrev.vp); rel = Math.max(rel, Math.hypot(((b.x - a.x) * W) / 2, ((b.y - a.y) * H) / 2)); }
    probePrev.vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); penPts.forEach((q, k) => probePrev.pts[k].copy(q)); probePrev.ok = true;
    const scr = (p: THREE.Vector3) => { const v = p.clone().project(camera); return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H, front: v.z < 1 && Math.abs(v.x) < 4 && Math.abs(v.y) < 4 }; };
    const tip = scr(pen.tip);
    // the barrel's screen box (v9), and the same box for each 1/20 of its length (`segs`, tip first), so a check can take only the part
    // over a row's width. Per frame: its axis moved by the barrel's radius along the camera's right and up (a cylinder's, an upper bound);
    // with `window.__probeRows` (a still's probe): the pen model's own vertices on screen, its true outline
    const segs: number[][] = Array.from({ length: 20 }, () => [Infinity, Infinity, -Infinity, -Infinity]);
    const addSeg = (k: number, q: { x: number; y: number }) => { const sb = segs[Math.min(19, Math.max(0, k))]; sb[0] = Math.min(sb[0], q.x); sb[1] = Math.min(sb[1], q.y); sb[2] = Math.max(sb[2], q.x); sb[3] = Math.max(sb[3], q.y); };
    if ((globalThis as { __probeRows?: boolean }).__probeRows && objs.pen) {
      const v = new THREE.Vector3(), d = new THREE.Vector3(); objs.pen.updateMatrixWorld(true);
      objs.pen.traverse((o) => {
        const pos = (o as THREE.Mesh).isMesh ? (o as THREE.Mesh).geometry.getAttribute("position") : null; if (!pos) return;
        for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); addSeg(Math.floor((d.subVectors(v, pen.tip).dot(pen.dir) / penDims.length) * 20), scr(v)); }
      });
    } else {
      const cR = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), cU = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
      for (let k = 0; k < 20; k++) for (const f of [k / 20, (k + 1) / 20]) for (const [a, b] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) addSeg(k, scr(pen.tip.clone().addScaledVector(pen.dir, penDims.length * f).addScaledVector(cR, a * penDims.radius).addScaledVector(cU, b * penDims.radius)));
    }
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const sb of segs) { bx0 = Math.min(bx0, sb[0]); by0 = Math.min(by0, sb[1]); bx1 = Math.max(bx1, sb[2]); by1 = Math.max(by1, sb[3]); sb.forEach((x, i) => (sb[i] = +x.toFixed(1))); }
    // the ink head: where the last ink was laid
    const hj = lastInk?.job ?? null, hp = lastInk?.pr ?? 0;
    const headS = hj ? scr(tipWorld(inkTip(hj, hp))) : { x: NaN, y: NaN, front: false };
    let len = 0; for (const j of jobs) len += (penProg.get(j.seq) ?? 0) * inkLen(j);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const e = ours.printed, n = 48;
    for (let i = 0; i <= n; i++) for (const x of [-ours.W / 2, 0, ours.W / 2]) { const z = (e * i) / n; const s = scr(new THREE.Vector3(x, PAPER_Y + ours.surfaceLift(x, z), z)); if (!s.front) continue; x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y); x1 = Math.max(x1, s.x); y1 = Math.max(y1, s.y); }
    return {
      t: +t.toFixed(4), target: +tTarget.toFixed(4),
      pen: { x: +tip.x.toFixed(1), y: +tip.y.toFixed(1), touch: tipTouches() ? 1 : 0, vis: objs.pen?.visible ? 1 : 0, seen: objs.pen?.visible && penSeen(pen.tip, pen.dir) ? 1 : 0, flight: pen.flight ? 1 : 0, writing: goal?.job ? 1 : 0, inView: goal?.inView ? 1 : 0, off: +dbg.off.toFixed(4), jump: +dbg.jump.toFixed(4), reverted: dbg.reverted, move: +dbg.move.toFixed(1), rel: +rel.toFixed(1), pts: penPts.map((p) => { const q = scr(p); return [+q.x.toFixed(1), +q.y.toFixed(1)] as [number, number]; }), box: [bx0, by0, bx1, by1].map((v) => +v.toFixed(1)), segs, open: penOpen ? 1 : 0, head: goal?.touch ? 1 : 0 },
      ink: { x: +headS.x.toFixed(1), y: +headS.y.toFixed(1), len: +len.toFixed(1), job: hj?.seq ?? null, progress: +hp.toFixed(3) },
      paper: { x0: +x0.toFixed(1), y0: +y0.toFixed(1), x1: +x1.toFixed(1), y1: +y1.toFixed(1), printed: +e.toFixed(3) },
      camT: +camT.toFixed(4), cam: { p: camera.position.toArray().map((v) => +v.toFixed(3)) as [number, number, number], a: camA.toArray().map((v) => +v.toFixed(3)) as [number, number, number] },
      theirs: +theirs.printed.toFixed(3), theirsL: +theirs.L.toFixed(3), camShown: +camShown.toFixed(4), drops: [...cards.values()].map((c) => +c.dv.toFixed(3)), gates: [...cards.values()].map((c) => (cardGate(c) ? 1 : 0)), dropAt: +dropAt.toFixed(1), progs: renderer.info.programs?.length ?? 0, texs: renderer.info.memory.textures, hold: runHold == null ? -1 : +runCap().toFixed(3), cost: Object.fromEntries(Object.entries(cost).map(([k, v]) => { (cost as Record<string, number>)[k] = 0; return [k, +v.toFixed(1)]; })),
      cards: +[...cards.values()].reduce((a, c) => a + (c.m.visible ? c.m.position.x + 3 * c.m.position.y + 7 * c.m.position.z : 0), 0).toFixed(4),
      ...(() => { const rowGlyphs = (globalThis as { __probeRows?: boolean }).__probeRows ? ([] as number[][]) : undefined; return { rows: rowRects(rowGlyphs), rowGlyphs }; })(),
    };
  }

  /* ---------- start ---------- */
  (async () => {
    await Promise.all([loadFonts(o.assetBase), objsDone, hdriDone]);
    if (disposed) return;
    resize();
    if (pendingData) { const d = pendingData; pendingData = null; applyData(d); }
    const lay = layout as SceneLayout | null;
    if (lay) {
      baseDirty = true; ours.setLines(lay.ours); theirs.setLines(theirs.lines, theirs.printedLines); placeTheirs();
      for (const j of jobs) { if (j.kind === "strike") { const s = strikeSpan(ours.ctx, j.t); j.tw = s.x2 - s.x1; } else { ours.ctx.font = j.font; j.tw = ours.ctx.measureText(j.text).width; } } // with the fonts in
      win.clear(); assignWindows();
    }
    nextShown = t >= T_NEXT0; paintAll();
    const r = parkPose(focusAt(t).aim.z); pen.tip.set(...r.tip); pen.dir.set(...r.dir);
    camSnap = true;
    ready = true;
    last = performance.now(); raf = requestAnimationFrame(frame); // onReady comes with the first frame drawn
  })();

  return {
    setData, setScroll, setSection, setLook, setTopInset, setBottomInset, setDoorSlot, setCaptionBox, setCaptionEl, setPointer, click,
    setTipEl(el: HTMLElement | null) { if (tipEl && tipEl !== el) tipEl.style.display = "none"; tipEl = el; tipShown = "!"; hover(); },
    setVeilLine,
    setSlipEl(el: HTMLElement | null) { if (el !== slipEl) { if (slipEl) slipEl.style.visibility = "hidden"; slipEl = el; slipLen = 0; placeCards(); } }, resize, savePng, reset, seek, probe,
    setAskEl(el: HTMLElement | null, clip?: { top: number; bottom: number }) { if (askEl && askEl !== el) askEl.style.display = "none"; askEl = el; askKey = "!"; if (clip) askClip = clip; },
    // a scroll past the page's end moves the scene only where something waits for the reader's next move: the model-alone answer held
    input() { /* v13: a touch and a wheel play the same eased timeline */ },
    nudge(px: number) { if (o.controlled || !px || !th.held) return; moved(); },
    get layout() { return layout; },
    debug() { return { t: +t.toFixed(4), p: +t.toFixed(4), target: +tTarget.toFixed(4), topInset, bottomInset, fit: lastFit, L: ours.L, printed: ours.printed, tasteStart: layout?.tasteStart, nextStart: layout?.nextStart, savedLi: layout?.savedLi, pens: layout?.pens.length, jobs: jobs.length, windows: [...win.entries()].map(([k, w]) => [k, +w.t0.toFixed(3), +w.t1.toFixed(3), w.late ? 1 : 0]), ink: [...penProg.entries()].map(([k, v]) => [k, +v.toFixed(3)]), goal: goal ? { job: goal.job?.seq ?? null, touch: goal.touch, inView: goal.inView } : null, cards: cards.size, shown: [...cards.values()].filter((c) => c.m.visible).length, pen: !!objs.pen, cup: !!objs.cup, card: !!objs.card, scales, theirsZ: +theirs.group.position.z.toFixed(2), cam: camera.position.toArray().map((v) => +v.toFixed(2)), aim: camA.toArray().map((v) => +v.toFixed(2)), penTip: pen.tip.toArray().map((v) => +v.toFixed(3)), flight: !!pen.flight, move: +dbg.move.toFixed(1), collisions }; },
    penLog() { return { dims: penDims, boxes: obstacleBoxes(), sets: boxSets, frames: penFrames, collisions, first: firstHits }; },
    dispose() {
      disposed = true; cancelAnimationFrame(raf); placeTip(null);
      ours.dispose(); theirs.dispose(); stripTex.dispose(); for (const c of cards.values()) { c.m.geometry.dispose(); (c.m.material as THREE.Material).dispose(); }
      steam?.dispose(); pmrem.dispose(); renderer.dispose();
    },
  };
}
