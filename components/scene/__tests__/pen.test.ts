import { describe, expect, it } from "vitest";
import { capsuleHitsBox, flatBox, flightPose, freePose, hits, planFlight, pointBoxDist, segmentBoxDist, type Box, type PenDims, type Pose } from "../pen";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PEN: PenDims = { length: 1.09, radius: 0.035 };
const cup: Box = { name: "cup", min: [-1.5, 0, 0.4], max: [-0.9, 0.22, 1.0] };
const card: Box = flatBox("card", 1.55, 0.007, 0.02, 0.81, 0.51, -0.55, 0.007);
const paper: Box = { name: "paper", min: [-0.5, 0, 0], max: [0.5, 0.018 - 0.003, 6] }; // a hair under the surface: the tip touches, the body never dips
const polaroids: Box[] = [0, 1, 2, 3].map((i) => flatBox(`polaroid${i}`, -0.7 - (i % 2) * 0.33, 0.01, 1.2 + i * 0.4, 0.3, 0.36, 0.06));
const boxes = [cup, card, paper, ...polaroids];
const slackFor = (b: Box) => (b.name === "paper" ? PEN.radius : 0); // the tip may touch the paper
const WRITE: [number, number, number] = [0.42, 0.84, 0.35];

describe("capsule maths", () => {
  it("point and segment distances to a box", () => {
    expect(pointBoxDist([0, 0, 0], { name: "b", min: [-1, -1, -1], max: [1, 1, 1] })).toBe(0);
    expect(pointBoxDist([3, 0, 0], { name: "b", min: [-1, -1, -1], max: [1, 1, 1] })).toBeCloseTo(2);
    expect(segmentBoxDist([-3, 0, 0], [1, 0, 0], 6, { name: "b", min: [-1, -1, -1], max: [1, 1, 1] })).toBe(0);
    expect(segmentBoxDist([-3, 2, 0], [1, 0, 0], 6, { name: "b", min: [-1, -1, -1], max: [1, 1, 1] })).toBeCloseTo(1);
    expect(segmentBoxDist([2, 2, 2], [0, 1, 0], 1, { name: "b", min: [-1, -1, -1], max: [1, 1, 1] })).toBeCloseTo(Math.sqrt(3));
  });
  it("a pen lying through the cup hits it; lifted above it, it does not", () => {
    expect(capsuleHitsBox({ tip: [-1.6, 0.03, 0.4], dir: [0.95, 0.01, 0.31] }, PEN, cup)).toBe(true);
    expect(capsuleHitsBox({ tip: [-1.6, 0.3, 0.4], dir: [0.95, 0.01, 0.31] }, PEN, cup)).toBe(false);
  });
  it("writing with the tip on the paper is allowed, the body below the paper is not", () => {
    const writing: Pose = { tip: [-0.3, 0.018, 1.1], dir: WRITE };
    expect(hits(writing, PEN, boxes, slackFor)).toEqual([]);
    expect(hits({ tip: [-0.3, 0.018, 1.1], dir: [0.42, -0.2, 0.35] }, PEN, boxes, slackFor)).toContain("paper");
  });
});

describe("planFlight", () => {
  it("lifts over the polaroids and the cup between the rest place and a line, every sample clear", () => {
    const rest: Pose = { tip: [-1.6, 0.035, 0.6], dir: [-0.5, 0, 0.87] };
    const line: Pose = { tip: [-0.35, 0.018, 1.3], dir: WRITE };
    const f = planFlight(rest, line, PEN, boxes, { slackFor });
    expect(f.height).toBeGreaterThan(0.05);
    for (let i = 0; i <= 60; i++) expect(hits(flightPose(f, i / 60), PEN, boxes, slackFor)).toEqual([]);
    flightPose(f, 0).tip.forEach((v, i) => expect(v).toBeCloseTo(rest.tip[i], 6)); flightPose(f, 1).tip.forEach((v, i) => expect(v).toBeCloseTo(line.tip[i], 6));
  });
  it("a hop to the next line still lifts by the minimum and stays clear", () => {
    const a: Pose = { tip: [0.1, 0.018, 1.3], dir: WRITE }, b: Pose = { tip: [-0.35, 0.018, 1.5], dir: WRITE };
    const f = planFlight(a, b, PEN, boxes, { slackFor, minHeight: 0.06 });
    expect(f.height).toBeGreaterThanOrEqual(0.06);
    expect(flightPose(f, 0.5).tip[1]).toBeGreaterThan(0.05);
    for (let i = 0; i <= 40; i++) expect(hits(flightPose(f, i / 40), PEN, boxes, slackFor)).toEqual([]);
  });
  it("freePose moves a rest place out of the cup", () => {
    const inCup: Pose = { tip: [-1.6, 0.035, 0.4], dir: [0.95, 0.01, 0.31] };
    const p = freePose(inCup, PEN, boxes);
    expect(hits(p, PEN, boxes)).toEqual([]);
    expect(p.tip[2]).toBeGreaterThan(0.4);
  });
});

/** A recorded frame: tip, direction, the box set on the counter, 1 on a planned flight, t (round-6 logs; older ones have no flag). */
type Frame = [number, number, number, number, number, number, number, number?, number?];
/** The largest step the tip may take between two frames that are not part of a planned flight (m): the ink's own pace, never a teleport. */
const STEP = 0.06;

/** Recorded runs from the Mac (design/r6 recorder → __tests__/recorded/*.json): the pen in every frame against the objects' bounds, and its path frame to frame. */
describe("recorded frames", () => {
  const dir = join(__dirname, "recorded");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  it("has at least one recording", () => { expect(files.length).toBeGreaterThan(0); });
  for (const f of files) {
    const rec = JSON.parse(readFileSync(join(dir, f), "utf8")) as { dims: PenDims; boxes: Box[]; sets: Box[][]; frames: Frame[]; collisions: number; first: unknown[] };
    it(`${f}: the pen overlaps nothing in any frame`, () => {
      expect(rec.collisions, `collisions seen live: ${JSON.stringify(rec.first)}`).toBe(0);
      expect(rec.frames.length).toBeGreaterThan(100);
      expect(rec.sets.length).toBeGreaterThan(0);
      // the runtime's rule: on the flat things (both receipts, the curl, the counter) the capsule may touch, the axis may not enter
      const slack = (b: Box) => (b.name === "paper" || b.name === "curl" || b.name === "theirs" || b.name === "counter" ? rec.dims.radius : 0);
      const bad: string[] = [];
      rec.frames.forEach((fr, i) => { const h = hits({ tip: [fr[0], fr[1], fr[2]], dir: [fr[3], fr[4], fr[5]] }, rec.dims, rec.sets[fr[6]], slack); if (h.length) bad.push(`frame ${i}: ${h.join(",")}`); });
      expect(bad).toEqual([]);
    });
    it(`${f}: the tip is continuous frame to frame, except through a planned flight`, () => {
      const bad: string[] = [];
      let flights = 0;
      for (let i = 1; i < rec.frames.length; i++) {
        const a = rec.frames[i - 1], b = rec.frames[i];
        if (a[7] || b[7]) { flights++; continue; } // lifted and moving between places on its planned arc
        const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        if (d > STEP) bad.push(`frame ${i} (t ${b[8]}): ${d.toFixed(3)} m`);
      }
      expect(bad).toEqual([]);
      expect(flights, "the log carries the flight flag").toBeGreaterThan(0);
    });
  }
});
