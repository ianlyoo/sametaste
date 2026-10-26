// hostrun.mjs OUT "Pick:WxH:seq ..." [--win|--soft] [--live=ORIGIN --pace=N:S]: builds this checkout, serves it, records each run with record.mjs on
// this host's browser and prints ptime.mjs's seconds per run. Plain node, so it runs on a Windows host too. From the repo root, e.g.
//   company run --kind motion --needs windows --snapshot --artifacts .scratch/w1 -- node eval/motion/hostrun.mjs .scratch/w1 "Dev:1920x1080:normal-hold" --win
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const [out, runs, mode = "--soft", ...more] = process.argv.slice(2);
const opt = (k) => more.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
// --live: the data from that origin (its /api/agent allows 6 runs per IP per 10 min): N picks per S seconds, the first batch from the next 10-min boundary + 15 s (--align=0: the caller already waited; a host left idle that long can drop off)
const live = opt("live"), [paceN, paceS] = (opt("pace") ?? "2:600").split(":").map(Number);
fs.mkdirSync(out, { recursive: true });
const sh = (cmd, log) => { const r = spawnSync(cmd, { shell: true, encoding: "utf8", maxBuffer: 1 << 28 }); fs.appendFileSync(path.join(out, log), `$ ${cmd}\n${r.stdout}\n${r.stderr}\n`); if (r.status !== 0) { console.log(`FAILED: ${cmd}\n${(r.stdout + r.stderr).slice(-3000)}`); process.exit(1); } };
sh("npm ci", "setup.log");
sh("npm i --no-save playwright-core", "setup.log");
if (mode === "--soft") sh("npx playwright-core install chromium-headless-shell", "setup.log");
sh("npm run build", "build.log");
const PORT = 3019, srv = spawn("npx next start -p " + PORT + " -H 127.0.0.1", { shell: true, stdio: ["ignore", fs.openSync(path.join(out, "start.log"), "a"), fs.openSync(path.join(out, "start.log"), "a")] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false; for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/`)).ok; } catch {} if (!up) await sleep(1000); }
if (!up) { console.log("server did not start"); process.exit(1); }
let batchAt = 0;
if (live && opt("align") !== "0") { const w = 600000 - (Date.now() % 600000) + 15000; console.log(`waiting ${(w / 1000).toFixed(0)} s for the rate window`); await sleep(w); batchAt = Date.now(); }
for (const [i, r] of runs.split(/\s+/).filter(Boolean).entries()) {
  if (live && i > 0 && i % paceN === 0) { await sleep(Math.max(0, batchAt + paceS * 1000 - Date.now())); batchAt = Date.now(); }
  // Pick "demo" records /demo (Maya's recording); a fourth field "nowait" starts the sequence as soon as the scene is ready, the run still going
  const [pick, size, seq, w] = r.split(":"), name = `${pick}-${size.split("x")[0]}-${seq}`, demo = pick === "demo";
  const p = spawnSync(process.execPath, ["eval/motion/record.mjs", mode, "--out", out, "--url", `http://127.0.0.1:${PORT}/${demo ? "demo" : ""}`, "--name", name, "--size", size, "--seq", seq, ...(demo ? [] : ["--pick", pick]), ...(w === "nowait" ? [] : ["--wait-run"]), "--probe-every", opt("probe-every") ?? "1", ...(live ? ["--live", live] : []), ...(opt("snap-at") ? ["--snap-at", opt("snap-at")] : []), ...(opt("video") === "1" ? [] : ["--no-video"])], { encoding: "utf8", maxBuffer: 1 << 28 });
  fs.appendFileSync(path.join(out, "record.log"), p.stderr + p.stdout);
  if (p.status !== 0) console.log(`RECORD FAILED ${name} (exit ${p.status}): ${p.stderr.split("\n").filter((l) => /\] |Error/.test(l)).slice(-4).join(" | ")}`);
}
if (process.platform === "win32") spawnSync(`taskkill /pid ${srv.pid} /T /F`, { shell: true }); else srv.kill();
for (const f of fs.readdirSync(out).filter((f) => f.endsWith(".probe.json"))) {
  const p = spawnSync(process.execPath, ["eval/motion/ptime.mjs", path.join(out, f)], { encoding: "utf8" }); process.stdout.write(p.stdout + p.stderr);
}
