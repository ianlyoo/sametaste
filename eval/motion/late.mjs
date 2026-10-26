// late.mjs VIDEO [VIDEO…]: the v8 H1 check on the video itself (here, ffmpeg): a change that lands after the scene had gone still, with
// no input. Per frame, the per mille of pixels (half size, gray) whose luma changed by more than 24 from the previous frame; a frame "moves"
// over 0.3 per mille (the encoder's refreshes stay under it). A late jump is a still run of 0.15-0.6 s (the recorder's
// ~25 fps: a frame of the 0.2 s may be the stop's own; a drag's start comes after a longer still), then a short burst (<= 0.15 s, peak >= 1 per
// mille) of moving frames, then still again for >= 0.5 s: input would keep it moving, the scene's own late move does not. Prints each one;
// they are candidates to look at (a drag through a stop of the timeline, where nothing moves, can show one change in a still stretch).
// Note: on a phone (mobile emulation) the recorder shows no frame for ~0.25 s after a touch scroll ends; whatever the scene changes after
// the finger's last frame lands as one such jump (see README).
import { spawn, spawnSync } from "node:child_process";
const MOVE = 0.3, PEAK = 1, STILL_S = 0.15, STILL_MAX_S = 0.6, BURST_S = 0.15, AFTER_S = 0.5;
let bad = 0;
for (const video of process.argv.slice(2)) {
  const pr = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", video]);
  const [W, H] = pr.stdout.toString().trim().split(",").map(Number), w = Math.round(W / 4) * 2, h = Math.round(H / 4) * 2, n = w * h;
  const ts = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time", "-of", "csv=p=0", video], { maxBuffer: 1 << 28 }).stdout.toString().split("\n").map(parseFloat);
  const ff = spawn("ffmpeg", ["-v", "error", "-i", video, "-vf", `scale=${w}:${h},format=gray`, "-f", "rawvideo", "-"]);
  const mv = []; let prev = null, buf = Buffer.alloc(0);
  for await (const chunk of ff.stdout) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= n) { const b = Buffer.from(buf.subarray(0, n)); buf = buf.subarray(n); if (prev) { let c = 0; for (let k = 0; k < n; k++) if (Math.abs(prev[k] - b[k]) > 24) c++; const i = mv.length + 1; mv.push([Number.isFinite(ts[i]) ? ts[i] : i / 25, (c / n) * 1000]); } prev = b; }
  }
  // runs of still and moving frames: [moving, start s, end s (the next run's start), peak per mille]
  const runs = []; for (const [t, c] of mv) { const m = c > MOVE, r = runs[runs.length - 1]; if (r && r[0] === m) r[3] = Math.max(r[3], c); else { if (r) r[2] = t; runs.push([m, t, t, c]); } }
  const out = [];
  for (let i = 1; i + 1 < runs.length; i++) {
    const [s0, b, s1] = [runs[i - 1], runs[i], runs[i + 1]];
    if (b[0] && !s0[0] && !s1[0] && s0[2] - s0[1] >= STILL_S && s0[2] - s0[1] <= STILL_MAX_S && b[3] >= PEAK && b[2] - b[1] <= BURST_S && s1[2] - s1[1] >= AFTER_S && b[1] > 1.5) out.push(`${b[1].toFixed(2)}s: ${b[3].toFixed(1)} per mille after ${(s0[2] - s0[1]).toFixed(2)} s still`);
  }
  bad += out.length; console.log(`${video}: ${mv.length} frames, late jumps ${out.length}`); if (out.length) console.log(out.join("\n"));
}
process.exitCode = bad ? 1 : 0;
