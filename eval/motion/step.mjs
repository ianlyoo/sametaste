/**
 * Still frames of the scene at rest, for looking at each stop by eye (the motion runs judge the moving frames).
 *
 * Runs on the Mac:  /opt/homebrew/bin/node step.mjs --out DIR --url URL --size 1920x1080 [--pick Maya] [--wait-run] [--live ORIGIN] [--at 0,0.1,…|--stops]
 *
 * The page loads as in record.mjs (same browser, same --live routing, `?probe`). Then for each position it scrolls there with wheel notches
 * (a finger's drags on a phone size), waits until the scene is still, and writes NAME-NN.png and one line of NAME.steps.json: scrollY, t,
 * the camera and the probe's M8 record (what covers a receipt row). --at takes fractions of the scrollable distance; --stops (the
 * default) walks the page a notch at a time and keeps the positions where t sits on a whole stop.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright-core");
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => { if (x.startsWith("--")) a.push([x.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "1"]); return a; }, []));
const out = args.out, url0 = args.url, name = args.name || "step";
const [vw, vh] = (args.size || "1920x1080").split("x").map(Number);
const phone = vw < vh, dpr = phone ? 2 : 1;
const live = args.live && args.live !== "1" ? args.live.replace(/\/$/, "") : null;
if (!out || !url0) { console.error("usage: --out DIR --url URL [--size WxH] [--pick Maya] [--wait-run] [--live ORIGIN] [--at f,f,…]"); process.exit(1); }
fs.mkdirSync(out, { recursive: true });
const log = (m) => console.error(`[${name}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--headless=new", "--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"] });
try {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr, hasTouch: phone, isMobile: phone });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  const agent = []; page.on("request", (r) => { if (/\/api\/agent(\?|$)/.test(new URL(r.url()).pathname)) agent.push(new Date().toISOString()); }); // production allows 6 a 10-min window
  if (live) await page.route((u) => /\/api\/(recording|agent)(\/|\?|$)/.test(u.pathname + u.search), async (route) => {
    try { const u = new URL(route.request().url()); await route.fulfill({ response: await route.fetch({ url: live + u.pathname + u.search }) }); }
    catch (e) { errors.push("live route: " + String(e).slice(0, 160)); await route.continue(); }
  });
  const u = new URL(url0); u.searchParams.set("probe", "1");
  await page.goto(u.toString(), { waitUntil: "load" });
  if (args.pick) { const stub = page.locator(`[aria-label^="${args.pick}"]`).first(); await stub.waitFor({ timeout: 60000 }); await stub.click(); }
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
  if (args["wait-run"]) {
    await page.waitForFunction(() => { const q = window.__demo || window.__app; return q && (q.run === "done" || q.run === "error"); }, null, { timeout: 480000 });
    const st = await page.evaluate(() => (window.__demo || window.__app).run);
    if (st !== "done") { log(`run ${st} (agent calls ${agent.length}): no stills`); process.exit(3); }
  }
  await sleep(1500);
  const D = await page.evaluate(() => Math.max(0, document.documentElement.scrollHeight - innerHeight));
  await page.mouse.move(vw / 2, vh / 2);
  const cdp = phone ? await ctx.newCDPSession(page) : null;
  const probe = () => page.evaluate(() => { const p = window.__sceneProbe?.(); return p && { sy: scrollY, t: p.t, target: p.target, cam: p.cam, theirs: p.theirs, pen: p.pen, m8: p.m8 }; });
  // scroll by d px as a reader would: wheel notches, or a slow drag on a phone
  const by = async (d) => {
    if (!d) return;
    if (cdp) await cdp.send("Input.synthesizeScrollGesture", { x: vw / 2, y: d > 0 ? vh * 0.75 : vh * 0.25, yDistance: -d, speed: 800, gestureSourceType: "touch", preventFling: true });
    else for (let k = 0, n = Math.ceil(Math.abs(d) / 100); k < n; k++) { await page.mouse.wheel(0, d / n); await sleep(40); }
  };
  const still = async () => { let a = await probe(); for (let k = 0; k < 40; k++) { await sleep(150); const b = await probe(); if (b && a && Math.abs(b.t - b.target) < 1e-3 && JSON.stringify(b.cam) === JSON.stringify(a.cam)) return b; a = b; } return a; };
  const steps = []; let n = 0;
  const shoot = async (tag) => { const p = await still(); const f = `${name}-${String(n++).padStart(2, "0")}.png`; await page.screenshot({ path: path.join(out, f) }); steps.push({ f, tag, ...p }); log(`${f} ${tag} sy ${p?.sy} t ${p?.t?.toFixed(3)} m8 dom ${p?.m8?.domN} obj ${p?.m8?.objN}`); };
  if (args.at) {
    for (const fr of args.at.split(",").map(Number)) { const sy = await page.evaluate(() => scrollY); await by(Math.round(fr * D) - sy); await shoot(`at ${fr}`); }
  } else {
    // the stops: walk down a notch at a time; a whole t that holds after the page stops is a stop
    await by(-(await page.evaluate(() => scrollY))); // the front door lands on Understood once a statement is picked: back to the top first
    await shoot("top"); let lastStop = 0;
    for (let k = 0; k < 400; k++) {
      const sy = await page.evaluate(() => scrollY); if (sy >= D - 1) break;
      await by(Math.min(phone ? 50 : 100, D - sy)); await sleep(phone ? 200 : 160);
      const p = await probe(); const s = Math.round(p?.target ?? 0);
      if (p && Math.abs(p.target - s) < 0.02 && s > lastStop) { lastStop = s; await shoot(`stop ${s}`); }
    }
    await shoot("end");
  }
  fs.writeFileSync(path.join(out, `${name}.steps.json`), JSON.stringify({ size: [vw, vh, dpr], url: url0, D, errors, agent, steps }, null, 1));
  log(`done: ${steps.length} stills, ${errors.length} errors, ${agent.length} agent calls`);
} finally { await browser.close(); }
