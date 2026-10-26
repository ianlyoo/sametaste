/**
 * The pen's path, planned over the bounds of everything on the counter, and the
 * check that it never intersects any of them. Pure maths (no three.js, no DOM) so
 * the same code runs in the scene per frame and in the tests over recorded frames.
 *
 * The pen is a capsule: a segment from the tip along `dir` for `length`, with `radius`.
 * Every object is an axis-aligned box in world space. The paper is a box too, so the
 * pen's body never goes through it; only the tip is allowed to touch its surface.
 */
export type V3 = [number, number, number];
export interface Box { name: string; min: V3; max: V3 }
export interface PenDims { length: number; radius: number }
export interface Pose { tip: V3; dir: V3 }
export interface Flight { from: Pose; to: Pose; height: number; dur: number }

const EPS = 1e-9;
export const v3 = {
  add: (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s],
  lerp: (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
  len: (a: V3): number => Math.hypot(a[0], a[1], a[2]),
  norm: (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  dot: (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  dist: (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
};
/** Unit vector between two unit vectors, by angle (slerp); falls back to lerp when they are opposite. */
export function slerp(a: V3, b: V3, t: number): V3 {
  const d = Math.max(-1, Math.min(1, v3.dot(a, b)));
  if (d > 0.9995 || d < -0.9995) return v3.norm(v3.lerp(a, b, t));
  const th = Math.acos(d), s = Math.sin(th);
  return v3.norm(v3.add(v3.scale(a, Math.sin((1 - t) * th) / s), v3.scale(b, Math.sin(t * th) / s)));
}
export const easeInOut = (u: number): number => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);

/** Distance from a point to a box (0 inside). */
export function pointBoxDist(p: V3, b: Box): number {
  let s = 0;
  for (let i = 0; i < 3; i++) { const d = Math.max(b.min[i] - p[i], 0, p[i] - b.max[i]); s += d * d; }
  return Math.sqrt(s);
}
/** Smallest distance from the segment tip→tip+dir*length to the box. Point-to-box distance is convex along a segment, so a ternary search finds it. */
export function segmentBoxDist(tip: V3, dir: V3, length: number, b: Box): number {
  const at = (t: number) => pointBoxDist(v3.add(tip, v3.scale(dir, t)), b);
  let lo = 0, hi = length;
  for (let k = 0; k < 40; k++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (at(m1) < at(m2)) hi = m2; else lo = m1; }
  return Math.min(at(0), at(length), at((lo + hi) / 2));
}
/** The pen capsule overlaps the box (with `slack` allowed, for a tip touching the paper). */
export function capsuleHitsBox(pose: Pose, dims: PenDims, b: Box, slack = 0): boolean {
  const th = dims.radius - slack, d = segmentBoxDist(pose.tip, pose.dir, dims.length, b);
  return th > EPS ? d < th - EPS : d <= 0; // slack >= radius: only the axis entering the box counts (a tip touching the paper's top is fine)
}
/** Names of every box the pen overlaps in this pose. */
export function hits(pose: Pose, dims: PenDims, boxes: Box[], slackFor?: (b: Box) => number): string[] {
  const out: string[] = [];
  for (const b of boxes) if (capsuleHitsBox(pose, dims, b, slackFor ? slackFor(b) : 0)) out.push(b.name);
  return out;
}

/** Pose along a flight at u in 0..1: an eased straight line with a sine arc of `height` above it; the axis turns by angle. */
export function flightPose(f: Flight, u: number): Pose {
  const e = easeInOut(Math.max(0, Math.min(1, u)));
  const tip = v3.lerp(f.from.tip, f.to.tip, e);
  tip[1] += f.height * Math.sin(e * Math.PI);
  return { tip, dir: slerp(f.from.dir, f.to.dir, e) };
}
export interface PlanOptions {
  /** Clearance above any object the capsule would otherwise cut (world units). */
  margin?: number;
  /** Lowest arc for any flight, so even a hop to the next line visibly lifts. */
  minHeight?: number;
  /** Boxes the tip may touch (the paper, the counter): the capsule must stay clear by `radius` minus this. */
  slackFor?: (b: Box) => number;
  samples?: number;
}
/**
 * Plan a flight from one pose to another whose capsule, sampled along the way, overlaps no box.
 * The arc is raised in steps until every sample is clear; the duration grows with distance.
 */
export function planFlight(from: Pose, to: Pose, dims: PenDims, boxes: Box[], o: PlanOptions = {}): Flight {
  const margin = o.margin ?? 0.03, minH = o.minHeight ?? 0.08, n = o.samples ?? 24;
  const d = v3.dist(from.tip, to.tip);
  const f: Flight = { from, to, height: minH, dur: 0.3 + Math.min(0.6, d * 0.3) };
  for (let k = 0; k < 40; k++) {
    let worst = 0;
    for (let i = 0; i <= n; i++) {
      const pose = flightPose(f, i / n), mid = Math.sin(easeInOut(i / n) * Math.PI); // 0 at the ends (the tip may rest on a surface there), 1 mid-arc
      for (const b of boxes) {
        const slack = o.slackFor ? o.slackFor(b) : 0;
        const dist = segmentBoxDist(pose.tip, pose.dir, dims.length, b);
        // a touchable surface: the axis clears it by the full margin mid-arc (the paper's curl moves under a flight while the reader scrubs), by a hair at the ends
        const need = (dims.radius - slack > EPS ? dims.radius - slack + margin : 0.004 + (margin - 0.004) * mid) - dist;
        if (need > worst) worst = need;
      }
    }
    if (worst <= 0) break;
    f.height += Math.max(0.02, worst);
  }
  return f;
}
/** The first pose along +z from `pose` (in steps) whose capsule is clear of every box; the rest place beside the paper. */
export function freePose(pose: Pose, dims: PenDims, boxes: Box[], step: V3 = [0, 0, 0.1], tries = 30, margin = 0.02): Pose {
  let p = pose;
  for (let k = 0; k < tries; k++) {
    let clear = true;
    for (const b of boxes) if (segmentBoxDist(p.tip, p.dir, dims.length, b) < dims.radius + margin) { clear = false; break; }
    if (clear) return p;
    p = { tip: v3.add(p.tip, step), dir: p.dir };
  }
  return p;
}
/** Axis-aligned world box of a thin rectangle (a polaroid, the card) lying flat at `y`, rotated about y by `rz`. */
export function flatBox(name: string, cx: number, y: number, cz: number, w: number, h: number, rz: number, thickness = 0.004): Box {
  const c = Math.abs(Math.cos(rz)), s = Math.abs(Math.sin(rz)), ex = (w * c + h * s) / 2, ez = (w * s + h * c) / 2;
  return { name, min: [cx - ex, y - thickness, cz - ez], max: [cx + ex, y + thickness, cz + ez] };
}
