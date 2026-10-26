/**
 * The phone's first view (v10): what a reader sees on landing, at rest. Runs on the Mac (like record.mjs):
 *
 *   /opt/homebrew/bin/node landing.mjs --out DIR --url URL --name NAME --sizes 360x780,390x844,414x896 [--live ORIGIN]
 *
 * For each size: the page (with ?probe) 4 s after the scene is ready, a screenshot NAME-W.png and NAME-W.json with the boxes, in CSS px,
 * of the parts of the view: the top bar, the door's parts ([data-door]: the line, the persona stubs, the drop card), the bottom band's
 * text, and the paper's printed part on screen (the probe's paper box, cut to the band the canvas shows); and the pen: "in" (wholly in
 * the shown canvas), "out" (none of it), or "cut" (by the frame's edge), from the pen model's own outline (pen.segs with __probeRows).
 * Checks: no two parts overlap (1 px slack), and the pen is not cut. The gaps between the parts, top to bottom, are listed.
 * One line per size: "NAME-W ok|FAIL ...". Exit 1 on a fail.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright-core");

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => { if (x.startsWith("--")) a.push([x.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "1"]); return a; }, []));
const out = args.out, url0 = args.url, name = args.name || "landing", sizes = (args.sizes || "360x780,390x844,414x896").split(",");
const live = args.live && args.live !== "1" ? args.live.replace(/\/$/, "") : null;
if (!out || !url0) { console.error("usage: --out DIR --url URL [--name N] [--sizes WxH,...] [--live ORIGIN]"); process.exit(1); }
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SLACK = 1;

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--headless=new", "--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"] });
let bad = 0;
try {
  for (const size of sizes) {
    const [vw, vh] = size.split("x").map(Number), tag = `${name}-${vw}`;
    const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    if (live) await page.route((u) => /\/api\/(recording|agent)(\/|\?|$)/.test(u.pathname + u.search), async (route) => {
      try { const u = new URL(route.request().url()); await route.fulfill({ response: await route.fetch({ url: live + u.pathname + u.search }) }); } catch { await route.continue(); }
    });
    const u = new URL(url0); u.searchParams.set("probe", "1");
    await page.goto(u.toString(), { waitUntil: "load" });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
    await sleep(4000);
    const v = await page.evaluate(() => {
      const box = (r) => [r.left, r.top, r.right, r.bottom].map((x) => +x.toFixed(1));
      const parts = [];
      const bar = document.querySelector("[data-overlay=strip] header, header"); if (bar) parts.push({ k: "bar", b: box(bar.getBoundingClientRect()) });
      for (const el of document.querySelectorAll("[data-door]")) parts.push({ k: el.getAttribute("data-door"), b: box(el.getBoundingClientRect()) });
      // the bottom band's text (the phone's captions, the credits), outside the door and the bar
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const band of document.querySelectorAll("[data-overlay=edge]")) {
        const w = document.createTreeWalker(band, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          if (!n.textContent.trim() || n.parentElement.closest("[data-door], [data-overlay=strip]")) continue;
          const rg = document.createRange(); rg.selectNodeContents(n);
          for (const r of rg.getClientRects()) if (r.width && r.height) { x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom); }
        }
      }
      if (x1 > x0) parts.push({ k: "band", b: [x0, y0, x1, y1].map((x) => +x.toFixed(1)) });
      window.__probeRows = true; const p = window.__sceneProbe(); window.__probeRows = false;
      const [ct, cb] = p.m8?.clip ?? [0, 0];
      return { parts, paper: p.paper, pen: p.pen, clip: [ct, cb], scrollable: document.documentElement.scrollHeight - innerHeight };
    });
    await page.screenshot({ path: path.join(out, `${tag}.png`) });
    await ctx.close();
    // the paper: the part the canvas shows
    const [ct, cb] = v.clip, shown = [ct, vh - cb];
    const pp = v.paper; if (pp && pp.y1 > shown[0] && pp.y0 < shown[1]) v.parts.push({ k: "paper", b: [pp.x0, Math.max(pp.y0, shown[0]), pp.x1, Math.min(pp.y1, shown[1])] });
    const over = [];
    for (let i = 0; i < v.parts.length; i++) for (let j = i + 1; j < v.parts.length; j++) {
      const a = v.parts[i].b, b = v.parts[j].b, dx = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), dy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
      if (dx > SLACK && dy > SLACK) over.push(`${v.parts[i].k}/${v.parts[j].k} ${dy.toFixed(0)}px`);
    }
    // the pen: in, out or cut by the shown canvas's edges
    let pen = "out";
    if (v.pen?.vis && v.pen.segs) {
      const segs = v.pen.segs.filter((s) => s.every((x) => Number.isFinite(x)));
      const inside = (s) => s[0] >= 0 && s[2] <= vw && s[1] >= shown[0] && s[3] <= shown[1], touches = (s) => s[2] > 0 && s[0] < vw && s[3] > shown[0] && s[1] < shown[1];
      pen = segs.every(inside) ? "in" : segs.some(touches) ? "cut" : "out";
    }
    const order = [...v.parts].sort((a, b) => a.b[1] - b.b[1]), gaps = [];
    for (let i = 1; i < order.length; i++) gaps.push(`${order[i - 1].k}>${order[i].k} ${(order[i].b[1] - order[i - 1].b[3]).toFixed(0)}`);
    gaps.push(`${order[order.length - 1].k}>bottom ${(vh - order[order.length - 1].b[3]).toFixed(0)}`);
    const fail = over.length || pen === "cut";
    if (fail) bad++;
    const res = { size: [vw, vh], ...v, overlaps: over, penState: pen, gaps };
    fs.writeFileSync(path.join(out, `${tag}.json`), JSON.stringify(res, null, 1));
    console.log(`${tag} ${fail ? "FAIL" : "ok  "} pen ${pen}${over.length ? "  overlaps " + over.join(", ") : ""}  gaps ${gaps.join(", ")}`);
  }
} finally { await browser.close(); }
process.exitCode = bad ? 1 : 0;
