/**
 * The M1–M9 verdicts from a recording's probe log (record.mjs), plus a per-stage account of what moved.
 *
 *   node analyze.mjs NAME.probe.json [--cam-bound 0.2] [--json out.json]
 *
 * M1  inked length grows only on frames where the pen's tip touches the paper within 12 px of the ink head
 * M2  the tip is inside the viewport on every frame where ink grows
 * M3  the receipt's bbox covers ≥ 40% of the viewport (≥ 35% where the scene frames the pair: the model-alone receipt in the frame, or a landscape frame headed for the proof stop (t's target 4),
 *     which leaves it room while it is still being asked for on /: the PM's v5 acceptance at the proof stop) (area; the height share is reported too) during writing (frames within --write-pad of ink growing), and the camera's per-frame move stays under the bound
 * M4  the first input moves the scene (t, the paper, the ink or the pen) within 100 ms; inked length (and the printed length) never drop while the scroll moves forward
 * M5  frame time p95 ≤ 20 ms (the logger's own animation-frame loop, from the sequence's start to its end)
 * M6  ink grows only within 1.2 s of the scroll's last move (v13: the timeline plays toward the scroll under a speed limit, and the
 *     catch-up, the pen's backlog included, is done within 1.2 s; was 0.3 s, and 1.2 s for the flick sequences)
 * M7  on every frame the pen is drawn (v6: in view or not, flights in and out of view included), the pen's own move is ≤ 3% of the
 *     viewport's width per frame (PM, v4: no teleports). v7: the whole pen, not its tip: pen.move is the largest move of its tip, its
 *     middle and its cap end through the frame's own camera (a flight that turns the pen swings its cap end far further than its tip).
 *     The pen's own move between two samples (pen.rel: its three points then and now, both through the earlier sample's camera, so a
 *     frame the probe log missed is still seen) is judged too wherever any part of the pen is on screen in either sample: over 8% of the
 *     width is a teleport. The raw on-screen move (pen.pts, camera included) is reported beside it: a flick's pan carries paper and pen alike
 * M8  no receipt row (both receipts, every printed row with ink on screen) is covered by a DOM overlay or by a 3D object other than the pen;
 *     and the question slip, where it shows, lies under none of the strip's text (v11, F1); nor rests part-faded (opacity between 5% and 95% more than
 *     past the catch-up window, M9_MS), nor takes clicks below 50% opacity (v12)
 *     (v5, v6): every overlay (the slip, the hover tag, the captions, the strip and the bands, fades included) on every frame, moving or
 *     not, above the phone's bottom band (a row below its top is under its frost). v13 (nav draft A, the canvas uncut): a row under
 *     the top bar passes only with the bar's veil up (m8.veil ≥ 0.5: faded), else it is a cover ("bar"); under the strip's ink unveiled, "strip". The 3D objects (cup, card, polaroids, the other receipt) on every frame.
 * M9  nothing moves more than 1.2 s after the scroll's last move (v6; v13: the catch-up window, for every sequence): the pen (its tip on screen by
 *     ≥ 1 px, or its own move), the camera, t, the papers' printed lengths, the ink and the polaroids. Each "stop" mark's settle time
 *     (the last change after it) is reported too.
 * data  the run's data was live (no "Sample Qloo" badge on the page); reported, and a failure when the run asked for live data (--live)
 *
 * A log without a probe (prototype B) gets M5 and the scroll account only; M1–M4 are "n/a".
 */
import fs from "node:fs";

const argv = process.argv.slice(2); const file = argv[0];
const opt = (k, d) => { const i = argv.indexOf("--" + k); return i >= 0 ? argv[i + 1] : d; };
const CAM_BOUND = +opt("cam-bound", 0.2), jsonOut = opt("json", null);
const CAP_FRAC = +opt("cap", 0.03);
const WRITE_PAD = +opt("write-pad", 12); // frames either side of a frame where ink grew that count as "during writing" (~200 ms at 60 fps)
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const { meta, log, firstInput, marks } = data;
const [W, H] = meta.size;
const M6_MS = +opt("m6-ms", 1200), M9_MS = +opt("m9-ms", 1200); // v13: the catch-up window
const pct = (v) => Math.round(v * 1000) / 10;
const q = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const start = marks.find((m) => String(m[1]).startsWith("seq:"))?.[0] ?? log[0]?.ms ?? 0, end = marks.find((m) => m[1] === "end")?.[0] ?? log[log.length - 1]?.ms ?? 0;
const back = marks.find((m) => m[1] === "back" || m[1] === "up")?.[0] ?? null; // the way back up (slowstops, flicks: "back"; asking: "up")
const frames = log.filter((f) => f.ms >= start && f.ms <= end);
const probed = frames.filter((f) => f.p && f.p.t != null);
const res = { name: meta.name, url: meta.url, size: meta.size, seq: meta.seq, gpu: meta.gpu, frames: frames.length, probed: probed.length, errors: meta.errors || [], checks: {} };

/* M5: frame time */
{
  const dts = []; for (let i = 1; i < frames.length; i++) dts.push(frames[i].ms - frames[i - 1].ms);
  const p95 = q(dts, 0.95), p99 = q(dts, 0.99), max = Math.max(0, ...dts);
  res.checks.M5 = { pass: p95 <= 20, p95: +p95.toFixed(1), p99: +p99.toFixed(1), max: +max.toFixed(1), fps: +(1000 / (dts.reduce((a, b) => a + b, 0) / Math.max(1, dts.length))).toFixed(1), long: dts.filter((d) => d > 33).length };
}

if (probed.length < 10) {
  res.checks.M1 = res.checks.M2 = res.checks.M3 = res.checks.M4 = res.checks.M6 = res.checks.M7 = res.checks.M8 = res.checks.M9 = { pass: null, note: "no probe" };
} else {
  const EPS = 0.5; // canvas px of ink
  let m1 = 0, m2 = 0, grow = 0; const m1Worst = []; const m2Worst = [];
  let m4Ink = 0, m4Print = 0; const m4Worst = [];
  const camMoves = [], writingIdx = new Set();
  for (let i = 1; i < probed.length; i++) {
    const a = probed[i - 1].p, b = probed[i].p, f = probed[i];
    const dIlk = (b.ink?.len ?? 0) - (a.ink?.len ?? 0);
    if (dIlk > EPS) {
      grow++; for (let k = Math.max(0, i - WRITE_PAD); k <= Math.min(probed.length - 1, i + WRITE_PAD); k++) writingIdx.add(k);
      const d = Math.hypot(b.pen.x - b.ink.x, b.pen.y - b.ink.y);
      if (!b.pen.touch || d > 12) { m1++; if (m1Worst.length < 12) m1Worst.push({ ms: f.ms, t: b.t, d: +d.toFixed(1), touch: b.pen.touch, pen: [Math.round(b.pen.x), Math.round(b.pen.y)], ink: [Math.round(b.ink.x), Math.round(b.ink.y)], grew: +dIlk.toFixed(1) }); }
      if (!(b.pen.x >= 0 && b.pen.x <= W && b.pen.y >= 0 && b.pen.y <= H)) { m2++; if (m2Worst.length < 12) m2Worst.push({ ms: f.ms, t: b.t, pen: [Math.round(b.pen.x), Math.round(b.pen.y)], grew: +dIlk.toFixed(1) }); }
    }
    const forward = f.sy >= probed[i - 1].sy && (back == null || f.ms < back);
    if (forward && dIlk < -EPS) { m4Ink++; if (m4Worst.length < 8) m4Worst.push({ ms: f.ms, t: b.t, ink: +dIlk.toFixed(1) }); }
    if (forward && (b.paper?.printed ?? 0) < (a.paper?.printed ?? 0) - 1e-3) { m4Print++; if (m4Worst.length < 8) m4Worst.push({ ms: f.ms, t: b.t, printed: [+a.paper.printed.toFixed(3), +b.paper.printed.toFixed(3)] }); }
    if (a.cam && b.cam) camMoves.push({ i, v: dist(a.cam.p, b.cam.p) + dist(a.cam.a, b.cam.a) });
  }
  res.checks.M1 = { pass: m1 === 0, growFrames: grow, violations: m1, worst: m1Worst };
  res.checks.M2 = { pass: m2 === 0, growFrames: grow, violations: m2, worst: m2Worst };
  // M3: paper coverage on writing frames, camera move everywhere
  const cover = [], hcover = []; let coverShort = 0, pairFrames = 0;
  for (const k of writingIdx) {
    const p = probed[k].p.paper; if (!p) continue;
    const x0 = Math.max(0, p.x0), y0 = Math.max(0, p.y0), x1 = Math.min(W, p.x1), y1 = Math.min(H, p.y1);
    const c = Math.max(0, x1 - x0) * Math.max(0, y1 - y0) / (W * H), pair = (probed[k].p.theirs ?? 0) > 0 || (W > H && probed[k].p.target >= 4 - 1e-3);
    cover.push(c); hcover.push(Math.max(0, y1 - y0) / H); if (pair) pairFrames++; if (c < (pair ? 0.35 : 0.4)) coverShort++;
  }
  const camMax = camMoves.reduce((m, c) => (c.v > m.v ? c : m), { i: -1, v: 0 });
  const camP99 = q(camMoves.map((c) => c.v), 0.99);
  const coverMin = cover.length ? Math.min(...cover) : null, coverMed = q(cover, 0.5), hMin = hcover.length ? Math.min(...hcover) : null;
  res.checks.M3 = { pass: coverShort === 0 && camMax.v <= CAM_BOUND, framesUnderFloor: coverShort, pairFrames, coverMinPct: coverMin == null ? null : pct(coverMin), coverMedianPct: cover.length ? pct(coverMed) : null, heightMinPct: hMin == null ? null : pct(hMin), writingFrames: writingIdx.size, camMaxPerFrame: +camMax.v.toFixed(4), camP99PerFrame: +camP99.toFixed(4), camBound: CAM_BOUND, camMaxAt: camMax.i >= 0 ? { ms: probed[camMax.i].ms, t: probed[camMax.i].p.t } : null };
  // M4: latency from the first input to the first change of t
  // from the first input event (a wheel notch, a finger down), and from the first change of scrollY (a touch drag scrolls only after
  // the browser's ~15 px slop, which at 200 px/s is most of the budget; the scene can only follow the scroll it is given)
  let latency = null, scrollLatency = null;
  if (firstInput != null) {
    const before = probed.filter((f) => f.ms <= firstInput).pop() ?? probed[0];
    // "the scene moved": t by more than 1e-3 (a notch's worth when a stage is one viewport), or anything the reader can see: the paper's bbox by
    // half a pixel, the ink growing, the pen's tip by a pixel (a stage many viewports long moves t little per px; the pen answers at once)
    const seen = (f) => Math.abs(f.p.t - before.p.t) > 1e-3 || (f.p.paper && before.p.paper && Math.abs(f.p.paper.y0 - before.p.paper.y0) + Math.abs(f.p.paper.x0 - before.p.paper.x0) >= 0.5)
      || ((f.p.ink?.len ?? 0) - (before.p.ink?.len ?? 0) > EPS) || (f.p.pen.vis && before.p.pen.vis && Math.hypot(f.p.pen.x - before.p.pen.x, f.p.pen.y - before.p.pen.y) >= 1);
    const moved = probed.find((f) => f.ms > firstInput && seen(f));
    latency = moved ? +(moved.ms - firstInput).toFixed(1) : Infinity;
    const scrolled = probed.find((f) => f.ms > firstInput && f.sy !== before.sy);
    scrollLatency = scrolled && moved ? +Math.max(0, moved.ms - scrolled.ms).toFixed(1) : latency;
  }
  /* M6: ink growth only within M6_MS of the last change of scrollY */
  let m6 = 0, m6Max = 0; const m6Worst = []; let lastScroll = probed[0].ms;
  for (let i = 1; i < probed.length; i++) {
    const f = probed[i]; if (f.sy !== probed[i - 1].sy) lastScroll = f.ms;
    const dIlk = (f.p.ink?.len ?? 0) - (probed[i - 1].p.ink?.len ?? 0);
    if (dIlk > EPS) { const since = f.ms - lastScroll; if (since > m6Max) m6Max = since; if (since > M6_MS) { m6++; if (m6Worst.length < 8) m6Worst.push({ ms: f.ms, t: f.p.t, sinceScrollMs: +since.toFixed(0), grew: +dIlk.toFixed(1) }); } }
  }
  res.checks.M6 = { pass: m6 === 0, violations: m6, maxSinceScrollMs: +m6Max.toFixed(0), limitMs: M6_MS, worst: m6Worst };
  /* M7: the whole pen's own move per frame, every frame the pen is drawn (v6: in view or not; v7: tip, middle and cap end) */
  const capPx = CAP_FRAC * W, inV = (p) => p.pen.vis === 1, onS = ([x, y]) => x >= 0 && x <= W && y >= 0 && y <= H;
  const ptsOf = (p) => p.pen.pts ?? [[p.pen.x, p.pen.y]];
  let m7 = 0, m7Max = 0, rawMax = 0, raw8 = 0, rawOver = 0, relMax = 0, rel8 = 0, m7Frames = 0, m7Seen = 0; const m7Worst = [];
  for (let i = 1; i < probed.length; i++) {
    const a = probed[i - 1].p, b = probed[i].p; if (!inV(a) || !inV(b)) continue; m7Frames++;
    const pa = ptsOf(a), pb = ptsOf(b), seen = pa.some(onS) || pb.some(onS) || a.pen.seen === 1 || b.pen.seen === 1; if (seen) m7Seen++;
    const raw = seen ? Math.max(...pb.map((q, k) => Math.hypot(q[0] - pa[k][0], q[1] - pa[k][1]))) : 0, own = b.pen.move ?? raw;
    const rel = !seen ? 0 : b.pen.rel ?? raw; // camera held: a pan carries the paper and the pen alike
    if (raw > rawMax) rawMax = raw; if (raw > 0.08 * W) raw8++; if (raw > capPx) rawOver++; if (rel > relMax) relMax = rel; if (rel > 0.08 * W) rel8++;
    if (own > m7Max) m7Max = own;
    if (own > capPx || rel > 0.08 * W) { m7++; if (m7Worst.length < 8) m7Worst.push({ ms: probed[i].ms, t: b.t, movePx: +own.toFixed(1), relPx: +rel.toFixed(1), rawPx: +raw.toFixed(1), flight: b.pen.flight, writing: b.pen.writing, open: b.pen.open, seen: seen ? 1 : 0 }); }
  }
  /* M8: what covers a receipt row */
  if (probed.some((f) => f.p.m8)) {
    const OBJ = ["", "cup", "card", "polaroid", "other receipt"];
    let m8 = 0, judged = 0, rowsMax = 0; const byKind = {}, worst = [], clips = new Set();
    let lastS = probed[0].ms;
    for (let i = 0; i < probed.length; i++) {
      if (i && probed[i].sy !== probed[i - 1].sy) lastS = probed[i].ms;
      const f = probed[i], m = f.p.m8; if (!m) continue; judged++; rowsMax = Math.max(rowsMax, m.rows); if (m.clip) clips.add(m.clip.join("/"));
      const hit = (k, e) => { m8++; byKind[k] = (byKind[k] || 0) + 1; if (worst.length < 12) worst.push({ ms: +f.ms.toFixed(0), t: f.p.t, ...e }); };
      for (const [which, li, fromTotal, kind, ox, oy] of m.dom) hit(kind, { by: kind, receipt: which ? "model's" : "ours", line: li, fromTotal, ox, oy });
      if (m.domN > m.dom.length) hit("truncated", { more: m.domN - m.dom.length });
      for (const [which, li, , occ] of m.obj) hit(OBJ[occ] || "3d", { receipt: which ? "model's" : "ours", line: li });
      if (m.slipStrip) hit("slip under strip", { rects: m.slipStrip }); // v11 (F1): the question slip under the strip's text
      if (m.slipA != null && m.slipA > 0.05 && m.slipA < 0.95 && f.ms - lastS > M9_MS) hit("slip part-faded at rest", { opacity: m.slipA }); // v12
      if (m.slipA != null && m.slipA < 0.5 && m.slipPe) hit("faded slip takes clicks", { opacity: m.slipA });
    }
    res.checks.M8 = { pass: m8 === 0, violations: m8, byKind, framesJudged: judged, rowsOnScreenMax: rowsMax, clips: [...clips], worst };
  } else res.checks.M8 = { pass: null, note: "no m8 in the probe" };
  /* M9: nothing moves past M9_MS after the scroll's last move */
  {
    const kinds = {}, worst = []; let m9 = 0, lastS = probed[0].ms, maxSince = 0;
    const stops = marks.filter((m) => m[1] === "stop").map((m) => m[0]), settle = stops.map(() => 0);
    for (let i = 1; i < probed.length; i++) {
      const f = probed[i], a = probed[i - 1].p, b = f.p; if (f.sy !== probed[i - 1].sy) lastS = f.ms;
      const moved = [];
      if (a.pen.vis && b.pen.vis && (Math.max(...ptsOf(b).map((q, k) => Math.hypot(q[0] - ptsOf(a)[k][0], q[1] - ptsOf(a)[k][1]))) >= 1 || (b.pen.move ?? 0) >= 1)) moved.push("pen");
      if (a.cam && b.cam && dist(a.cam.p, b.cam.p) + dist(a.cam.a, b.cam.a) > 0) moved.push("camera");
      if (b.t !== a.t) moved.push("t");
      if (Math.abs((b.paper?.printed ?? 0) - (a.paper?.printed ?? 0)) >= 1e-3 || Math.abs((b.theirs ?? 0) - (a.theirs ?? 0)) >= 1e-3) moved.push("paper");
      if ((b.ink?.len ?? 0) - (a.ink?.len ?? 0) > EPS) moved.push("ink");
      if (b.cards != null && a.cards != null && Math.abs(b.cards - a.cards) >= 1e-3) moved.push("polaroids");
      if (!moved.length) continue;
      const since = f.ms - lastS; if (since > maxSince) maxSince = since;
      for (let k = stops.length - 1; k >= 0; k--) if (f.ms >= stops[k]) { if (f.ms - lastS >= 0 && lastS <= stops[k]) settle[k] = Math.max(settle[k], f.ms - stops[k]); break; }
      if (since > M9_MS) { m9++; for (const k of moved) kinds[k] = (kinds[k] || 0) + 1; if (worst.length < 12) worst.push({ ms: +f.ms.toFixed(0), t: b.t, sinceScrollMs: +since.toFixed(0), moved }); }
    }
    res.checks.M9 = { pass: m9 === 0, violations: m9, byKind: kinds, maxSinceScrollMs: +maxSince.toFixed(0), limitMs: M9_MS, stops: stops.length, stopSettleMaxMs: settle.length ? +Math.max(...settle).toFixed(0) : null, worst };
  }
  res.checks.M7 = { pass: m7 === 0, violations: m7, maxMovePx: +m7Max.toFixed(1), capPx: +capPx.toFixed(1), framesDrawn: m7Frames, framesSeen: m7Seen, points: probed.some((f) => f.p.pen.pts) ? 3 : 1, relMaxPx: +relMax.toFixed(1), relOver8pct: rel8, rawMaxPx: +rawMax.toFixed(1), rawOverCap: rawOver, rawOver8pct: raw8, worst: m7Worst };
  const touch = /touch/.test(meta.seq) || W < H; // a phone size scrolls by touch drags (slowstops too)
  const lat = touch ? scrollLatency : latency;
  res.checks.M4 = { pass: lat != null && lat <= 100 && m4Ink === 0 && m4Print === 0, firstInputLatencyMs: latency, firstScrollLatencyMs: scrollLatency, judgedOn: touch ? "scroll" : "input", inkDrops: m4Ink, printDrops: m4Print, worst: m4Worst };
  /* the account per stage: what moved while t was in each section */
  const stages = [];
  for (let s = 0; s < 6; s++) {
    const fr = probed.filter((f) => Math.floor(f.p.t) === s); if (fr.length < 2) continue;
    let cam = 0, ink = 0, pen = 0, touch = 0, vis = 0;
    for (let i = 1; i < fr.length; i++) { const a = fr[i - 1].p, b = fr[i].p; if (a.cam && b.cam) cam += dist(a.cam.p, b.cam.p); ink += Math.max(0, (b.ink?.len ?? 0) - (a.ink?.len ?? 0)); if (a.pen && b.pen) pen += Math.hypot(b.pen.x - a.pen.x, b.pen.y - a.pen.y); if (b.pen?.touch) touch++; if (b.pen?.vis) vis++; }
    stages.push({ section: s, frames: fr.length, ms: +(fr[fr.length - 1].ms - fr[0].ms).toFixed(0), cameraTravel: +cam.toFixed(2), inkGrown: Math.round(ink), penTravelPx: Math.round(pen), penTouchFrames: touch, penVisibleFrames: vis, printed: [+fr[0].p.paper?.printed.toFixed(2), +fr[fr.length - 1].p.paper?.printed.toFixed(2)] });
  }
  res.stages = stages;
  res.final = probed[probed.length - 1].p;
}
/* the data: live or the sample */
if (meta.sampleBadge != null) res.checks.data = { pass: meta.live ? !meta.sampleBadge : null, live: !meta.sampleBadge, badge: meta.sampleBadge, source: meta.live || "page's own" };
// a run whose page never finished its run (/'s agent, e.g. production's 429) or that laid no ink at all proves nothing: it fails rather than passing vacuously
// (a --no-probe run counts no ink: only its page's state is judged)
{ const state = meta.demo?.run ?? null, grow = res.checks.M1?.growFrames ?? 0, probedRun = !!res.probed; res.checks.run = { pass: (state == null || state === "done") && (grow > 0 || !probedRun), state, growFrames: probedRun ? grow : null }; }
const passes = Object.entries(res.checks).map(([k, v]) => `${k}:${v.pass === null ? "n/a" : v.pass ? "ok" : "FAIL"}`).join(" ");
res.pass = Object.values(res.checks).every((v) => v.pass !== false);
console.log(`${res.name}  ${passes}  frames ${res.frames} (probed ${res.probed})  p95 ${res.checks.M5.p95}ms fps ${res.checks.M5.fps}` + (res.checks.M1.violations != null ? `  M1 ${res.checks.M1.violations}/${res.checks.M1.growFrames}  M2 ${res.checks.M2.violations}  cover ${res.checks.M3.coverMinPct}% (h ${res.checks.M3.heightMinPct}%)  cam max ${res.checks.M3.camMaxPerFrame}  latency ${res.checks.M4.firstInputLatencyMs}ms  drops ${res.checks.M4.inkDrops}/${res.checks.M4.printDrops}  M6 ${res.checks.M6.maxSinceScrollMs}ms/${res.checks.M6.limitMs}  M7 ${res.checks.M7.maxMovePx}px/${res.checks.M7.capPx} (between samples ${res.checks.M7.relMaxPx}px, >8% ${res.checks.M7.relOver8pct}; raw with the camera ${res.checks.M7.rawMaxPx}px, >8% ${res.checks.M7.rawOver8pct})` + (res.checks.M8.violations != null ? `  M8 ${res.checks.M8.violations}${Object.keys(res.checks.M8.byKind).length ? " " + JSON.stringify(res.checks.M8.byKind) : ""}` : "") + (res.checks.M9?.violations != null ? `  M9 ${res.checks.M9.violations}${Object.keys(res.checks.M9.byKind).length ? " " + JSON.stringify(res.checks.M9.byKind) : ""} (max ${res.checks.M9.maxSinceScrollMs}ms/${res.checks.M9.limitMs}${res.checks.M9.stops ? `, stops settle ≤ ${res.checks.M9.stopSettleMaxMs}ms` : ""})` : "") : "") + (res.checks.data ? `  data ${res.checks.data.live ? "live" : "SAMPLE"}` : "") + (res.errors.length ? `  errors ${res.errors.length}` : ""));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(res, null, 1));
