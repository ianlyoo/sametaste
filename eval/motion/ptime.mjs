// ptime.mjs NAME.probe.json: from a run's probe, the seconds from the pick to Proof-ready (owner feedback: the camera's own t at the proof and the
// model-alone receipt printed whole), when the writing ended, the frame pacing, and the order checks of #511 (photos after the camera)
import fs from "node:fs";
const f = process.argv[2], d = JSON.parse(fs.readFileSync(f, "utf8")), L = d.log.filter((x) => x.p && x.p.t != null);
// seconds on the scene's own clock: its frame step is capped at 50 ms, so on a slow software-GL host wall time overstates it
const pick = (d.marks.find((m) => m[1] === "pick") ?? [L[0]?.ms ?? 0])[0];
const sceneS = (ms) => { let a = 0; for (let i = 1; i < d.log.length; i++) { const t0 = d.log[i - 1].ms, t1 = d.log[i].ms; if (t1 <= pick || t0 >= ms) continue; a += Math.min(50, Math.min(t1, ms) - Math.max(t0, pick)); } return a / 1000; };
const s = (ms) => ms == null ? "never" : `${sceneS(ms).toFixed(1)} s (wall ${((ms - pick) / 1000).toFixed(1)})`;
const first = (fn) => L.find(fn)?.ms ?? null;
const camAt = first((x) => (x.p.camShown ?? 0) >= 3.45), whole = first((x) => x.p.theirsL > 0 && x.p.theirs >= x.p.theirsL - 1e-3);
const ink = L.filter((x) => x.p.ink?.job), inkStart = ink[0]?.ms ?? null;
let inkEnd = null; for (const x of L) if (x.p.pen?.writing) inkEnd = x.ms;
const dts = []; for (let i = 1; i < d.log.length; i++) dts.push(d.log[i].ms - d.log[i - 1].ms);
const sorted = [...dts].sort((a, b) => a - b), p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
// a polaroid on its way down while the camera's own t was short of the first photos' stage (FEEL.cardsCamT 0.98): sampled frames, so any drop > 0 counts
let early = 0; for (const x of L) if ((x.p.drops ?? []).some((v) => v > 0) && (x.p.camShown ?? 0) < 0.98) early++;
const pcs = d.log.filter((x) => x.pc != null).map((x) => x.pc).sort((a, b) => a - b), pc95 = pcs[Math.floor(pcs.length * 0.95)] ?? 0;
// the model-alone receipt un-printing (scrubbed back by a scroll)
let unprint = 0; for (let i = 1; i < L.length; i++) if (L[i].p.theirs < L[i - 1].p.theirs - 1e-3) unprint++;
// the camera's t ahead of the pen's ink: camT must equal min(t, penT); held frames are where t ran ahead
let held = 0; for (const x of L) if (x.p.t - (x.p.camT ?? x.p.t) > 0.01) held++;
// v25 (H2): the proof open while the agent's run was going (the camera at the proof with a hold set), and the camera's t going back while
// the reader's t stayed past it (flown back with no scroll back)
let openRun = 0, flyBack = 0; for (let i = 0; i < L.length; i++) { const x = L[i], c = x.p.camT ?? x.p.t; if ((x.p.hold ?? -1) >= 0 && (x.p.camShown ?? 0) >= 3.45) openRun++; if (i && c < (L[i - 1].p.camT ?? L[i - 1].p.t) - 1e-4 && x.p.t >= L[i - 1].p.t - 1e-4) flyBack += (L[i - 1].p.camT ?? L[i - 1].p.t) - c; }
// the slowest frames and what the scene spent in them (the probe's cost: the most each part took since the probe before)
const slow = d.log.map((x, i) => [i ? x.ms - d.log[i - 1].ms : 0, i]).filter(([g]) => g > 40).sort((a, b) => b[0] - a[0]).slice(0, 8)
  .map(([g, i]) => `${g.toFixed(0)}ms@${((d.log[i].ms - pick) / 1000).toFixed(1)}s ${JSON.stringify(d.log[i].p?.cost ?? d.log[i + 1]?.p?.cost ?? {})}`);
const cmax = {}; for (const x of L) for (const [k, v] of Object.entries(x.p.cost ?? {})) cmax[k] = Math.max(cmax[k] ?? 0, v);
console.log(`${d.meta.name}: renderer ${d.meta.gpu?.renderer?.slice(0, 50)} ${d.meta.gpu?.fps?.toFixed(0)} fps | pick→first ink ${s(inkStart)}, last ink ${s(inkEnd)}, camera at Proof ${s(camAt)}, Proof-ready (right receipt whole) ${s(whole)} | frames p95 ${p95.toFixed(1)} ms, max ${Math.max(...dts).toFixed(0)} ms (probe p95 ${pc95.toFixed(1)} ms) | camera held ${held} frames | early photos ${early} | right receipt un-printed ${unprint} | errors ${d.meta.errors?.length ?? "?"} warnings ${d.meta.warnings?.length ?? 0} | proof open during the run ${openRun} frames, camera flown back ${flyBack.toFixed(2)} sections | cost max ${JSON.stringify(cmax)}\n  slowest: ${slow.join(" | ")}`);
