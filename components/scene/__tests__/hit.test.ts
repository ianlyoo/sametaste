import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { Receipt, type Line } from "../receipt";
import { answerFor } from "../runtime";
import type { PenTarget } from "../lines";

/* a canvas for node: the receipt paints into it and measures text; nothing is looked at */
function fakeCanvas() {
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (o, k) => (k in o ? o[k] : k === "measureText" ? (s: string) => ({ width: 8 * s.length }) : k === "createLinearGradient" ? () => ({ addColorStop() {} }) : () => undefined),
    set: (o, k, v) => { o[k] = v; return true; },
  });
  return { width: 0, height: 0, style: {}, getContext: () => ctx };
}
Object.assign(globalThis, { document: { createElement: fakeCanvas } });

const PAPER_Y = 0.018;
const lines: Line[] = [
  { t: "head", text: "SAMETASTE" }, { t: "sub", text: "TASTE READ WITH QLOO" }, { t: "rule" },
  ...Array.from({ length: 40 }, (_, i) => ({ t: "row", text: `09/${String(1 + (i % 28)).padStart(2, "0")}   MTA*NYCT PAYGO`, amt: "$2.90" })), // the statement: the twins sit well down the paper
  { t: "row", text: "LILIA", amt: "$455.39", key: "lilia" },
  { t: "pen", text: "→ Linden Badger Trattoria   $245.22", key: "lilia" },
  { t: "ev", text: "QLOO 0.83   ITALIAN", key: "lilia" },
  { t: "row", text: "WHOLE FOODS MARKET", amt: "$316.89", key: "wf" },
  { t: "pen", text: "→ Wren Comet Market   $237.68", key: "wf" },
  { t: "blank" }, { t: "barcode" },
] as Line[];

/** A ray straight down onto the paper at `d` along its length (the paper lies in XZ, header at z = 0). */
function castAt(r: Receipt, d: number): number {
  const ray = new THREE.Raycaster(new THREE.Vector3(0.05, 1, d), new THREE.Vector3(0, -1, 0));
  return r.hitLine(ray);
}

describe("a click on a written twin", () => {
  it("finds the twin's line under the pointer, also after a first look at the blank paper, and says no", () => {
    const r = new Receipt({ width: 1, mode: "lie", curlRadius: 0.16, curlLength: 0.22, maxLength: 6.2, segments: 600, sway: 1 });
    const scene = new THREE.Scene(); scene.add(r.group); r.group.position.set(0, PAPER_Y, 0);
    r.setLines(lines);
    const twin = lines.findIndex((l) => l.t === "pen" && l.key === "wf");
    // the door: the paper is a stub; a hover here must not spoil later casts
    r.print(0.02, true); r.update(0); scene.updateMatrixWorld(true);
    castAt(r, r.lineWorldY(twin));
    // the swaps are written: the paper is printed past the twin
    r.print(r.L, true); r.update(0); scene.updateMatrixWorld(true);
    expect(castAt(r, r.lineWorldY(twin))).toBe(twin);
    expect(castAt(r, r.lineWorldY(twin - 1))).toBe(twin - 1);
    expect(castAt(r, r.L + 0.5)).toBe(-1); // past the paper's end: nothing
    // the click: a proposed twin is rejected, a rejected one taken back, a bare row is nothing
    const pt = { key: lines[twin].key, swapId: "sw-wf", status: "proposed" } as unknown as PenTarget;
    expect(answerFor(pt)).toEqual({ reject: "sw-wf" });
    expect(answerFor({ ...pt, status: "rejected" } as PenTarget)).toEqual({ undo: "sw-wf" });
    expect(answerFor({ key: "lilia" } as PenTarget)).toBeNull();
    expect(answerFor(null)).toBeNull();
  });
  it("hits the lines the paper has printed so far, and nothing beyond", () => {
    const r = new Receipt({ width: 1, mode: "lie", maxLength: 6.2, segments: 600 });
    const scene = new THREE.Scene(); scene.add(r.group); r.group.position.set(0, PAPER_Y, 0);
    r.setLines(lines);
    const first = lines.findIndex((l) => l.t === "pen");
    r.print(r.lineWorldY(first) + 0.4, true); r.update(0); scene.updateMatrixWorld(true);
    expect(castAt(r, r.lineWorldY(first))).toBe(first);
  });
});
