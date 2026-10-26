// pose.mjs NAME.stops.json [...]: the v9 pose check on record.mjs --shots. At each stop (1 s in), the pen's barrel may cross only the band
// of the row its tip is on. The barrel: its screen box by twentieths of its length (the probe's pen.segs: the pen model's own vertices), in the
// frame; each other printed row of either receipt counts only the boxes over its own width (on the part of the frame the canvas shows).
// The tip's row: the row of our receipt whose band holds the tip's height (where it writes, or the ink head it rests at), or the nearest one
// within 6 px; with none (the pen in the margin, or off the paper) every row counts. PM ruling on aaabbe6: a stop passes when the barrel reaches at most PAD px into another
// row's band (its padding) and covers none of that row's glyphs (the probe's rowGlyphs: its painted ink's boxes); else it fails.
// v15: on a phone, a pen off a line's head (the probe's pen.head 0: parked, or held) is wholly in the frame or wholly out: a barrel the
// frame's edge cuts fails ("cut"). On a head it keeps the writing pose, its barrel out past the paper's right edge (v9).
// Prints one line per stop; exit 1 on a fail.
import fs from "node:fs";
const SLACK = 1, PAD = 3; // px: boxes touching at an edge do not overlap; the most a barrel may reach into another row's band
let bad = 0;
for (const f of process.argv.slice(2)) {
  const stops = JSON.parse(fs.readFileSync(f, "utf8")); let fails = 0; const lines = [];
  for (const s of stops) {
    const p = s.probe; if (!p || !p.pen || !p.rowBoxes) { lines.push(`stop ${s.n}: no probe`); continue; }
    if (!p.pen.vis || !p.pen.box) { lines.push(`stop ${s.n}: pen hidden`); continue; }
    const [bx0, by0, bx1, by1] = p.pen.box, [tx, ty] = p.pen.pts[0], [c0, c1] = p.m8?.clip ?? [0, 0], vh = s.vh ?? 844, vw = s.vw ?? 390;
    const shown = (r) => ({ x0: r[0], x1: r[2], y0: Math.max(r[1], c0), y1: Math.min(r[3], vh - c1) }); // the part of the row the canvas shows
    const rows = p.rowBoxes.map((r, i) => ({ r, b: shown(r), g: p.rowGlyphs?.[i] ?? null })).filter(({ b }) => b.y1 > b.y0);
    const ours = rows.filter(({ r }) => r[4] === 0);
    let cur = ours.find(({ r }) => ty >= r[1] && ty <= r[3]);
    if (!cur) { let best = 6; for (const o of ours) { const d = Math.min(Math.abs(ty - o.r[1]), Math.abs(ty - o.r[3])); if (d < best) { best = d; cur = o; } } }
    // the barrel by twentieths of its length (the probe's pen.segs; else its whole box), each cut to the frame: a row counts only the part of
    // the barrel over its own width, so the cap's end past the paper's edge or off the screen doesn't count against a row it isn't over
    const segs = (p.pen.segs ?? [p.pen.box]).filter((b) => b.every((v) => Number.isFinite(v))).map(([x0, y0, x1, y1]) => [Math.max(x0, 0), y0, Math.min(x1, vw), y1]).filter(([x0, , x1]) => x1 > x0);
    const depth = (b) => { let d = 0; for (const [sx0, sy0, sx1, sy1] of segs) if (b.x0 < sx1 - SLACK && b.x1 > sx0 + SLACK && b.y0 < sy1 - SLACK && b.y1 > sy0 + SLACK) d = Math.max(d, Math.min(sy1 - b.y0, b.y1 - sy0)); return d; };
    const glyphsHit = (o) => { if (!o.g) return 0; let n = 0; for (let k = 0; k + 3 < o.g.length; k += 4) { const b = { x0: o.g[k], y0: Math.max(o.g[k + 1], o.b.y0), x1: o.g[k + 2], y1: Math.min(o.g[k + 3], o.b.y1) }; if (b.y1 > b.y0 && depth(b) > 0) n++; } return n; };
    const hit = [], touch = [];
    for (const o of rows) { if (o === cur) continue; const d = depth(o.b); if (!(d > 0)) continue; const n = glyphsHit(o), tag = `${o.r[4] ? "theirs" : "ours"}:${o.r[5]} by ${d.toFixed(1)}px${n ? `, ${n} glyph box${n > 1 ? "es" : ""}` : ""}`; (d > PAD || n ? hit : touch).push(tag); }
    if (!p.rowGlyphs) touch.push("(no glyph boxes in this log)");
    // cut by the frame's edge (the whole barrel's box against the frame; a phone only)
    const cut = vw < vh && p.pen.head === 0 && bx0 < vw && bx1 > 0 && by0 < vh && by1 > 0 && (bx0 < 0 || bx1 > vw || by0 < 0 || by1 > vh);
    if (cut) hit.push(`cut by the frame's edge off a head (x ${bx0.toFixed(0)}-${bx1.toFixed(0)})`);
    if (hit.length) fails++;
    lines.push(`stop ${String(s.n).padStart(2)}: ${hit.length ? "FAIL" : "ok  "} tip ${tx.toFixed(0)},${ty.toFixed(0)} row ${cur ? cur.r[5] : "-"} barrel y ${by0.toFixed(0)}-${by1.toFixed(0)} x ${bx0.toFixed(0)}-${bx1.toFixed(0)}${hit.length ? "  crosses " + hit.join("; ") : ""}${touch.length ? "  pads " + touch.join("; ") : ""}`);
  }
  bad += fails; console.log(`${f}: ${stops.length} stops, ${fails} fail`); console.log(lines.join("\n"));
}
process.exitCode = bad ? 1 : 0;
