/**
 * Records the counter scene's motion on a real GPU (the Mac: headless Chrome, ANGLE Metal) and logs the scene's probe every frame.
 *
 * Runs on the Mac:  /opt/homebrew/bin/node record.mjs --out DIR --url URL --name NAME --size 1920x1080 --seq wheel [--pick Maya] [--wait-run] [--no-probe] [--probe-every N] [--live ORIGIN] [--shots]
 *
 * --no-video: no recording (v25: the review's own bare runs held 60 fps at 1920 where its cast ones dropped every other frame)
 * --snap-at S,S: screenshots NAME-snap-S.png S seconds into the sequence, and NAME-end.png at its end
 * --shots (tslow, tstops, tfast): 1 s into each stop (tfast: 1.3 s, past the pen's catch-up), a screenshot NAME-stop-NN.png and the probe with every printed row's screen box
 * (rowBoxes), into NAME.stops.json for pose.mjs.
 *
 * --live ORIGIN (e.g. https://qloo-sametaste.vercel.app): the page's data requests (GET /api/recording/*, POST /api/agent) are answered
 * from that origin, so a local build shows the live recordings without any key; the page is checked for the "Sample Qloo" badge after the run.
 *
 * It fails (exit 2) unless the WebGL renderer is Metal and the display loop runs at ≥ 55 fps. Then it plays one input sequence
 * against the page and writes NAME.webm (the video), NAME.probe.json (one record per animation frame: time, scrollY, the scene's
 * `__sceneProbe()`), and NAME.meta.json. `analyze.mjs` turns the probe log into the M1–M9 verdicts.
 *
 * Sequences (px are CSS px; D = the page's scrollable distance):
 *   trackpad  120+ wheel events of 20–40 px every 16 ms, in bursts of 30 with 500 ms pauses, until D
 *   wheel     100 px notches every 120 ms until D (a mouse wheel, ~830 px/s)
 *   slow      ~200 px/s (10 px every 50 ms) to the end
 *   normal    ~800 px/s (40 px every 50 ms) to the end
 *   tfast-hold / fast-hold   fast drags (a fast wheel) to the end, then 50 s still (v25, H2: run without --wait-run)
 *   normal-hold   normal, then 40 s still (the pen writing out what the scroll put in front of it, the camera following it)
 *   fast      a flick: ~3000 px/s (50 px every 16 ms) to the end, a 2 s hold, then back to the top the same way
 *   flick     = fast
 *   touch-slow / touch-normal / touch-fast   touch drags (CDP synthesizeScrollGesture, with fling) at 200 / 800 / 3000 px/s
 *   tstops    (a phone size) the v7 reviewer's touch read: 300 px drags at 200 px/s without fling, a 2.5 s stop after each, then back
 *             in 600 px drags at 400 px/s with the same stops; "stop"/"go" marks
 *   tslow     (a phone size) the v8 reviewer's slow touch read: 380 px drags at 200 px/s without fling, a 1.5 s stop after each, to the
 *             end; the stops fall at 380, 760, 1140 … px (the reviewer's); "go"/"stop" marks
 *   asking    (/ only, with --live) the v7 reviewer's: a mouse wheel to Proof with the model-alone answer held back, 6 s, the answer
 *             let through (marks "release", "baseline"), 4 s still, then up 1500 px at ~200 px/s, a 2.5 s stop, and down 1800 px
 *   slowstops a slow read with stops mid-writing (the v6 reviewer's): ~200 px/s (10 px every 50 ms; on a phone, finger drags of 350 px at
 *             200 px/s, no fling), a 2.5 s stop every 700 px to the end; a 2.5 s hold; then back to the top at ~400 px/s with a 2.5 s stop
 *             every 1400 px. Marks: "stop" / "go" around each stop, "back" before the way up
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
// owner feedback (no Mac): --soft, a Linux host's headless Chromium on ANGLE's software GL: for the timeline's logic and its seconds only, no GPU
// gate; --win, a Windows host's Chrome on ANGLE D3D11 (its real GPU), gated like the Mac's (no SwiftShader, ≥ 55 fps). Neither records video
const win = process.argv.includes("--win"), soft = win || process.argv.includes("--soft");
const { chromium } = require(soft ? "playwright-core" : "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright-core");

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => { if (x.startsWith("--")) a.push([x.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "1"]); return a; }, []));
const out = args.out, url0 = args.url, name = args.name || "run", seq = args.seq || "wheel";
const [vw, vh] = (args.size || "1920x1080").split("x").map(Number);
const phone = vw < vh, dpr = phone ? 2 : 1;
const probeOn = args["no-probe"] !== "1";
const live = args.live && args.live !== "1" ? args.live.replace(/\/$/, "") : null;
if (!out || !url0) { console.error("usage: --out DIR --url URL [--name N] [--size WxH] [--seq S] [--pick Maya] [--wait-run] [--no-probe]"); process.exit(1); }
fs.mkdirSync(out, { recursive: true });
const log = (m) => console.error(`[${name}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = win
  ? await chromium.launch({ channel: "chrome", headless: true, args: ["--headless=new", "--enable-gpu", "--use-angle=d3d11", "--force_high_performance_gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"] })
  : soft ? await chromium.launch({ headless: true, args: [`--use-angle=${process.env.ANGLE || "swiftshader"}`, "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] })
  : await chromium.launch({ channel: "chrome", headless: true, args: ["--headless=new", "--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"] });
const meta = { name, url: url0, size: [vw, vh, dpr], seq, live, startedAt: new Date().toISOString() };
try {
  /* ---- the GPU gate ---- */
  {
    const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr });
    const p = await ctx.newPage();
    await p.goto("about:blank");
    const gpu = await p.evaluate(async () => {
      const c = document.createElement("canvas"); const gl = c.getContext("webgl2") || c.getContext("webgl");
      const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
      const renderer = gl ? (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : "none";
      const frames = []; let last = performance.now();
      await new Promise((res) => { const tick = (now) => { frames.push(now - last); last = now; if (frames.length < 90) requestAnimationFrame(tick); else res(); }; requestAnimationFrame(tick); });
      const dts = frames.slice(10); const fps = 1000 / (dts.reduce((a, b) => a + b, 0) / dts.length);
      return { renderer, fps };
    });
    await ctx.close();
    meta.gpu = gpu;
    log(`renderer: ${gpu.renderer}; display loop ${gpu.fps.toFixed(1)} fps`);
    if (win ? /swiftshader|basic render/i.test(gpu.renderer) || gpu.fps < 55 : !soft && (!/metal/i.test(gpu.renderer) || gpu.fps < 55)) { meta.fail = "gpu gate"; fs.writeFileSync(path.join(out, `${name}.meta.json`), JSON.stringify(meta, null, 1)); log("GPU gate failed"); process.exit(2); }
  }

  /* ---- the page ---- */
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr, hasTouch: phone, isMobile: phone, ...(soft || args["no-video"] ? {} : { recordVideo: { dir: out, size: { width: vw, height: vh } } }) });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e).slice(0, 300))); page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 300)); else if (m.type() === "warning") (meta.warnings ??= []).push(m.text().slice(0, 300)); });
  // the per-frame logger: its own animation-frame loop, so a choked main thread shows as long frames here too
  // --probe-every N: the full probe on every Nth frame only (it reads the DOM's boxes; per frame it can cost the frame it measures), each call timed (pc, ms)
  await page.addInitScript((every) => {
    const L = []; window.__plog = L; let n = 0; window.__firstInput = null; window.__inputs = [];
    const mark = (k) => (e) => { const now = performance.now(); if (window.__firstInput == null) window.__firstInput = now; if (window.__inputs.length < 5000) window.__inputs.push([+now.toFixed(1), k, e.deltaY != null ? +e.deltaY.toFixed(1) : 0]); };
    addEventListener("wheel", mark("wheel"), { passive: true, capture: true }); addEventListener("touchstart", mark("touch"), { passive: true, capture: true }); addEventListener("touchmove", mark("touchmove"), { passive: true, capture: true }); addEventListener("keydown", mark("key"), { capture: true });
    const tick = (now) => {
      let pr = null, pc = 0; const go = n++ % every === 0, c0 = performance.now();
      try { pr = go && typeof window.__sceneProbe === "function" ? window.__sceneProbe() : null; } catch (e) { pr = { err: String(e).slice(0, 80) }; } pc = performance.now() - c0;
      // --no-probe: the page as a reader gets it; only the pen's last logged pose (tip, dir, t) and the frame count, to catch what the probe might hide
      if (!pr && typeof window.__penLog === "function") { const f = window.__penLog()?.frames; if (f && f.length) pr = { penOnly: f[f.length - 1], n: f.length }; }
      if (L.length < 40000) L.push({ ms: +now.toFixed(2), sy: scrollY, p: pr, ...(go ? { pc: +pc.toFixed(2) } : {}) });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, Math.max(1, Number(args["probe-every"]) || 1));
  // `asking`: the model-alone answer (the llm_only run) is fetched at once but handed to the page only when the sequence releases it
  let releaseLLM = () => {}; const llmGate = seq === "asking" ? new Promise((r) => { releaseLLM = r; }) : Promise.resolve();
  if (live) {
    // the data from the live site: the same path and query (and body), fulfilled from there
    let routed = 0;
    await page.route((u) => /\/api\/(recording|agent)(\/|\?|$)/.test(u.pathname + u.search), async (route) => {
      let mode = null; try { mode = JSON.parse(route.request().postData() || "{}").mode ?? null; } catch {}
      try { const r = await route.fetch({ url: live + new URL(route.request().url()).pathname + new URL(route.request().url()).search }); routed++; if (mode === "llm_only") await llmGate; await route.fulfill({ response: r }); }
      catch (e) { errors.push("live route: " + String(e).slice(0, 160)); await route.continue(); }
    });
    meta.routed = () => routed;
  }
  const u = new URL(url0); if (probeOn) u.searchParams.set("probe", "1");
  await page.goto(u.toString(), { waitUntil: "load" });
  if (args.pick) {
    // the front door: pick a sample statement by its stub
    const stub = page.locator(`[aria-label^="${args.pick}"]`).first();
    await stub.waitFor({ timeout: 60000 }); await stub.click(); log(`picked ${args.pick}`);
    await page.evaluate(() => { (window.__marks = window.__marks || []).push([+performance.now().toFixed(1), "pick"]); });
  }
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
  if (args["wait-run"]) {
    try { await page.waitForFunction(() => { const q = window.__demo || window.__app; return q && (q.run === "done" || q.run === "error"); }, null, { timeout: 480000 }); } catch { errors.push("run timeout"); }
    const st = await page.evaluate(() => (window.__demo || window.__app || {}).run);
    if (st !== "done") { meta.fail = "run " + st; meta.errors = errors; fs.writeFileSync(path.join(out, `${name}.meta.json`), JSON.stringify(meta, null, 1)); log(`run ${st}: not recorded`); process.exit(3); } // e.g. production's 429 on /api/agent: no video of a page with nothing written
  }
  await sleep(1200);
  const D = await page.evaluate(() => Math.max(0, document.documentElement.scrollHeight - innerHeight));
  meta.scrollable = D; log(`ready; scrollable ${D}px`);
  await page.mouse.move(vw / 2, vh / 2);
  const cdp = phone ? await ctx.newCDPSession(page) : null;
  const mark = async (k) => page.evaluate((k) => { (window.__marks = window.__marks || []).push([+performance.now().toFixed(1), k]); }, k);

  /* ---- the sequences ---- */
  // wheel events are fired on the clock, not awaited: a page whose main thread is choked must not slow the input down (the
  // dispatch only resolves once the renderer has handled the event, which stalled the fast run against production for minutes)
  const pending = [];
  async function wheelRun(px, everyMs, dist, { burst = 0, pause = 0 } = {}) {
    let done = 0, n = 0; let s = 7; const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    while (done < dist) {
      const d = typeof px === "function" ? px(rnd) : px;
      pending.push(page.mouse.wheel(0, d).catch((e) => errors.push("wheel: " + String(e).slice(0, 120)))); done += Math.abs(d); n++; // abs: the flick back scrolls by negative deltas
      if (burst && n % burst === 0) await sleep(pause); else await sleep(everyMs);
    }
    return n;
  }
  const settle = (ms) => Promise.race([Promise.all(pending), sleep(ms).then(() => errors.push(`input still unacknowledged after ${ms} ms`))]);
  async function touchRun(speed, dist) {
    let done = 0;
    while (done < dist) {
      const d = Math.min(vh * 0.8, dist - done);
      await cdp.send("Input.synthesizeScrollGesture", { x: vw / 2, y: vh * 0.7, yDistance: -d, speed, gestureSourceType: "touch", preventFling: speed < 1500 });
      done += d; await sleep(speed >= 1500 ? 900 : 120);
    }
  }
  // the slow read with stops: `chunk` px at `pxPerS`, a `stopMs` stop after each, until `dist` (dir -1: up)
  async function slowStops(dist, chunk, pxPerS, stopMs, dir) {
    let done = 0;
    while (done < dist - 1) {
      const d = Math.min(chunk, dist - done);
      if (cdp) { for (let k = 0; k < d; k += 350) { const dd = Math.min(350, d - k); await cdp.send("Input.synthesizeScrollGesture", { x: vw / 2, y: dir > 0 ? vh * 0.75 : vh * 0.25, yDistance: -dir * dd, speed: pxPerS, gestureSourceType: "touch", preventFling: true }); } }
      else { const step = pxPerS / 20; for (let k = 0; k < d; k += step) { pending.push(page.mouse.wheel(0, dir * Math.min(step, d - k)).catch((e) => errors.push("wheel: " + String(e).slice(0, 120)))); await sleep(50); } }
      done += d;
      if (done < dist - 1) { await mark("stop"); await sleep(stopMs); await mark("go"); }
    }
  }
  // --shots (v9): 1 s into each stop of tslow/tstops, a screenshot (NAME-stop-NN.png) and the probe with every row's screen box
  // (NAME.stops.json, for pose.mjs: the pen's barrel against the rows)
  const shots = [];
  const rest = async (ms, at = 1000) => {
    if (!args.shots) return sleep(ms);
    await sleep(at); const n = shots.length;
    const p = await page.evaluate(() => { window.__probeRows = true; try { return typeof window.__sceneProbe === "function" ? window.__sceneProbe() : null; } finally { window.__probeRows = false; } });
    await page.screenshot({ path: path.join(out, `${name}-stop-${String(n).padStart(2, "0")}.png`) });
    shots.push({ n, sy: await page.evaluate(() => scrollY), vw, vh, probe: p }); await sleep(Math.max(0, ms - at - 300));
  };
  const t0 = Date.now();
  await mark("seq:" + seq);
  // --snap-at S,S,...: a screenshot NAME-snap-S.png that many seconds into the sequence (v25: the receipt's rows, the pen's place)
  const snaps = String(args["snap-at"] ?? "").split(",").filter(Boolean).map(Number).map(async (sec) => { await sleep(sec * 1000); await mark("snap"); await page.screenshot({ path: path.join(out, `${name}-snap-${sec}.png`) }).catch((e) => errors.push("snap: " + String(e).slice(0, 80))); });
  switch (seq) {
    case "trackpad": await wheelRun((r) => Math.round(20 + r() * 20), 16, D, { burst: 30, pause: 500 }); break;
    case "wheel": await wheelRun(100, 120, D); break;
    case "slow": await wheelRun(10, 50, D); break;
    case "normal": await wheelRun(40, 50, D); break;
    case "normal-hold": await wheelRun(40, 50, D); await sleep(40000); break; // owner feedback: the pen writes on after the stop and the camera waits for it
    case "fast": case "flick": await wheelRun(50, 16, D); await sleep(2000); await mark("back"); await wheelRun(-50, 16, D); break;
    case "slowstops": await slowStops(D, 700, 200, 2500, 1); await mark("stop"); await sleep(2500); await mark("back"); await slowStops(await page.evaluate(() => scrollY), 1400, 400, 2500, -1); break;
    case "tstops": { // the v7 reviewer's touch read: 300 px drags at 200 px/s (no fling), a 2.5 s stop after each; back in 600 px drags at 400 px/s
      const drag = (dy, speed) => cdp.send("Input.synthesizeScrollGesture", { x: vw / 2, y: dy > 0 ? vh * 0.75 : vh * 0.25, yDistance: -dy, speed, gestureSourceType: "touch", preventFling: true });
      for (let k = 0; k < 80 && (await page.evaluate(() => scrollY)) < D - 5; k++) { await mark("go"); await drag(300, 200); await mark("stop"); await rest(2500); }
      await mark("back");
      for (let k = 0; k < 80 && (await page.evaluate(() => scrollY)) > 5; k++) { await mark("go"); await drag(-600, 400); await mark("stop"); await rest(2500); }
      break;
    }
    case "tslow": { // the v8 reviewer's slow touch read: 380 px drags at 200 px/s (no fling), a 1.5 s stop after each, to the end
      const drag = (dy) => cdp.send("Input.synthesizeScrollGesture", { x: vw / 2, y: vh * 0.75, yDistance: -dy, speed: 200, gestureSourceType: "touch", preventFling: true });
      for (let k = 0; k < 80 && (await page.evaluate(() => scrollY)) < D - 5; k++) { await mark("go"); await drag(380); await mark("stop"); await rest(1500); }
      break;
    }
    case "tfast": { // the v15 reviewer's fast touch read: 600 px flung drags at 1500 px/s, a 1.5 s stop after each, to the end and back up
      const drag = (dy) => cdp.send("Input.synthesizeScrollGesture", { x: vw / 2, y: dy > 0 ? vh * 0.75 : vh * 0.25, yDistance: -dy, speed: 1500, gestureSourceType: "touch" });
      for (let k = 0; k < 80 && (await page.evaluate(() => scrollY)) < D - 5; k++) { await mark("go"); await drag(600); await mark("stop"); await rest(1500, 1300); }
      await mark("back");
      for (let k = 0; k < 80 && (await page.evaluate(() => scrollY)) > 5; k++) { await mark("go"); await drag(-600); await mark("stop"); await rest(1500, 1300); }
      break;
    }
    case "tfast-hold": case "fast-hold": { // v25 (H2): the reviewer's fast drags (a fast wheel) to the end while the agent's run still goes (no
      // --wait-run), its question answered when it shows, then 50 s still: the proof must wait for the run, and nothing fly back
      let answered = false;
      const answer = async () => {
        if (answered || !(await page.evaluate(() => !!window.__app?.question))) return false;
        try {
          const tab = page.locator('button[aria-label^="A question"]');
          // clicked in the page: the slip rides the camera, so it is never still for a pointer click (30 s timeouts)
          const press = (l) => l.evaluate((el) => el.click());
          if (phone) { if (!(await tab.count()) || !(await tab.first().isVisible())) return false; await press(tab.first()); await sleep(800); }
          const opt = page.locator('[role="dialog"] button[aria-pressed]').first(), f = page.locator('input[id^="qt-"]').first();
          const optVis = (await opt.count()) && (await opt.isVisible()), fVis = (await f.count()) && (await f.isVisible());
          if (!optVis && !fVis) return false;
          const q = await page.locator('[role="dialog"] p').first().innerText().catch(() => "?");
          if (optVis && !(/where|place|neighbo|city|live/i.test(q) && fVis)) await press(opt);
          else { await f.evaluate((el) => el.focus()); await page.keyboard.type("Brooklyn", { delay: 60 }); await page.keyboard.press("Enter"); }
          answered = true; await mark("answered"); log(`answered ${JSON.stringify(q)}`); return true;
        } catch (e) { log("answer failed " + String(e).slice(0, 100)); return false; }
      };
      const drag = async (dy, speed) => { // the reviewer's touch drag: raw touch events, content up by dy
        const y0 = vh * 0.8, steps = Math.max(2, Math.round((dy / speed) * 60));
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: vw / 2, y: y0, id: 1 }] });
        for (let i = 1; i <= steps; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: vw / 2, y: y0 - (dy * i) / steps, id: 1 }] }); await sleep(1000 / 60); }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      };
      for (let k = 0; k < 400 && (await page.evaluate(() => scrollY)) < D - 5; k++) {
        if (await answer()) await sleep(1500);
        await mark("go"); if (phone) { await drag(500, 3200); await sleep(600); } else { for (let i = 0; i < 20; i++) { page.mouse.wheel(0, 100).catch(() => {}); await sleep(16); } await sleep(400); }
      }
      await mark("at-end"); for (let k = 0; k < 50; k++) { await answer(); await sleep(1000); }
      break;
    }
    case "asking": { // the v7 reviewer's: to Proof with the model-alone answer held; wait; release it (nothing may change until the reader moves); up, still, down
      await wheelRun(100, 120, D + 300); await mark("at-end"); await sleep(6000); await mark("release"); releaseLLM();
      await page.waitForFunction(() => window.__app && window.__app.baseline !== "running", null, { timeout: 120000 }).catch(() => errors.push("baseline wait timeout"));
      await mark("baseline"); await sleep(4000); await mark("up"); await wheelRun(-10, 50, 1500); await mark("stop"); await sleep(2500); await mark("go"); await wheelRun(10, 50, 1800); break; }
    case "touch-slow": await touchRun(200, D); break;
    case "touch-normal": await touchRun(800, D); break;
    case "touch-fast": await touchRun(3000, D); await sleep(2000); await mark("back"); for (let k = 0; k < 40 && (await page.evaluate(() => scrollY)) > 0; k++) await cdp.send("Input.synthesizeScrollGesture", { x: vw / 2, y: vh * 0.3, yDistance: vh * 0.8, speed: 3000, gestureSourceType: "touch" }); break;
    default: throw new Error("unknown seq " + seq);
  }
  await sleep(1800); await settle(15000); await Promise.all(snaps); await page.screenshot({ path: path.join(out, `${name}-end.png`) }).catch(() => {}); await mark("end");
  meta.seqMs = Date.now() - t0;
  const dump = await page.evaluate(() => ({ log: window.__plog, firstInput: window.__firstInput, inputs: window.__inputs, marks: window.__marks || [], debug: typeof window.__sceneDebug === "function" ? window.__sceneDebug() : null, demo: window.__demo || window.__app || null, inner: [innerWidth, innerHeight, devicePixelRatio] }));
  meta.frames = dump.log.length; meta.errors = errors; meta.demo = dump.demo; meta.inner = dump.inner;
  meta.sampleBadge = await page.evaluate(() => /sample qloo/i.test(document.body.innerText));
  if (live) { meta.routed = meta.routed(); log(`live data: ${meta.routed} requests answered from ${live}; sample badge ${meta.sampleBadge ? "PRESENT" : "absent"}`); }
  if (shots.length) fs.writeFileSync(path.join(out, `${name}.stops.json`), JSON.stringify(shots));
  fs.writeFileSync(path.join(out, `${name}.probe.json`), JSON.stringify({ meta, firstInput: dump.firstInput, inputs: dump.inputs, marks: dump.marks, debug: dump.debug, log: dump.log }));
  const video = page.video(); await ctx.close();
  if (video) { const vp = await video.path(); fs.renameSync(vp, path.join(out, `${name}.webm`)); }
  fs.writeFileSync(path.join(out, `${name}.meta.json`), JSON.stringify(meta, null, 1));
  log(`done: ${dump.log.length} frames, ${errors.length} errors, video ${name}.webm`);
} finally { await browser.close(); }
