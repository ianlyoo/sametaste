# eval/motion: the scene's motion on a real GPU

Scene-12. The owner's complaint was about motion, not stills, and a 3 fps software render hides it. These scripts record
the counter scene in headless Chrome on the Mac (ANGLE Metal, Apple M5, 60 fps) under scripted input and judge every frame
against the motion model:

- **M1** inked length grows only on frames where the pen's tip touches the paper within 12 px of the ink head
- **M2** the tip is inside the viewport on every frame where ink grows
- **M3** the receipt's bbox covers ≥ 40% of the viewport during writing (≥ 35% where the scene frames the pair, v5: the model-alone receipt in the frame, or a landscape frame whose target is the proof stop, since on `/` that receipt is still being asked for as the camera arrives); the camera's per-frame move stays under a bound
- **M4** the first input moves the scene within 100 ms (on a phone, from the first scroll after the browser's touch slop); inked and printed length never drop while the scroll moves forward
- **M5** frame time p95 ≤ 20 ms
- **M6** ink grows only within 1.2 s of the last scroll move (v13: the catch-up window); **M7** no part of the pen (tip, middle, cap end) moves more than 3% of the width a frame
- **M8** no receipt row is covered by a DOM overlay or by a 3D object other than the pen (below); and the question slip, where it shows, lies under none of the strip's text (v11: `m8.slipStrip`, the strip's text boxes over the slip's box); v13: a row under the top bar only with its veil up (faded), never under the nav's text unveiled; v14: on a phone, no row under a caption in the bottom band either
- **M9** nothing moves more than 1.2 s after the scroll's last move (v13: the catch-up window): the pen, the camera, `t`, the papers, the ink, the polaroids

Files:
- `record.mjs` runs on the Mac (`/opt/homebrew/bin/node`, playwright-core from `@playwright/mcp`, `channel: 'chrome'`,
  `--headless=new --enable-gpu --use-angle=metal --ignore-gpu-blocklist`). It fails unless the WebGL renderer is Metal and
  the display loop runs at ≥ 55 fps. One sequence per call: `trackpad`, `wheel`, `slow`, `normal`, `fast`, `slowstops`, `tstops`, `tslow`, `tfast`,
  `touch-slow`, `touch-normal`, `touch-fast` (see the header). `tslow` (v8) is the reviewer's slow phone read, a fixed sequence: 380 px
  finger drags at 200 px/s with no fling and a 1.5 s stop after each, to the end; its stops fall at 380, 760, 1,140 … px, where the
  reviewer saw the late jumps. `tstops` (v7) is the reviewer's phone read: 300 px finger drags at 200 px/s
  with no fling and a 2.5 s stop after each, to the end, then back up in 600 px drags at 400 px/s. `tfast` (v15) is the fast phone read: 600 px flung drags at
  1,500 px/s with a 1.5 s stop after each, to the end and back up. `slowstops` is the v6 reviewer's read: ~200 px/s with a 2.5 s stop every
  700 px to the end, then back to the top at ~400 px/s stopping every 1,400 px (wheel steps on a PC, finger drags on a phone),
  with `stop`/`go` marks in the probe log. It writes the video (webm), a per-frame probe log and a meta file. With `--no-probe`
  the page is as a reader gets it (no `?probe`); the log then keeps only the pen's last logged pose per frame (`p.penOnly`: tip,
  dir, boxes, flight, t), for checking that the probe hides nothing.
- `analyze.mjs` turns a probe log into the M1–M9 verdicts, plus a per-stage account (camera travel, ink grown, pen travel).
- `late.mjs VIDEO…` (here, ffmpeg; v8, H1) reads the video itself for a change that lands after the scene went still with no input:
  a still of 0.15–0.6 s, one short burst, then still again. It prints candidates to look at (a drag through a stop of the timeline can show
  one change, a section's caption, in a still stretch); exit 1 when there are any.
- `--shots` (tslow, tstops, tfast; v9): 1 s into each stop (tfast: 1.3 s, past the pen's catch-up), a screenshot `NAME-stop-NN.png` and the probe with every printed row's screen
  box and glyph boxes (`rowBoxes`, `rowGlyphs`: the row's painted ink in the receipt's canvas, projected), into `NAME.stops.json`.
  `pose.mjs NAME.stops.json…` checks the pen's pose there: the barrel (the pen model's own vertices on screen, by twentieths of its
  length: `pen.segs`, in the frame) may cross only the band of the row its tip is on (where it writes, or the ink head it rests at).
  Over another row's width it may reach at most 3 px into that row's band (its padding) and may cover none of its glyphs; else the stop
  fails. v15: on a phone a pen off a line's head (`pen.head` 0: parked or held) is wholly in the frame or wholly out; one the
  frame's edge cuts fails ("cut"). On a head it keeps the writing pose (v9). Exit 1 on a fail.
- `landing.sh OUTDIR URL NAME [args]` runs `landing.mjs` on the Mac (v10): the phone's first view, at rest, at 360x780, 390x844 and
  414x896 (`--sizes`). For each, 4 s after the scene is ready, a screenshot `NAME-W.png` and `NAME-W.json` with the boxes of the view's
  parts: the top bar, the door's parts (`[data-door]`: the line, the persona stubs, the drop card), the bottom band's text, and the
  paper's printed part as the canvas shows it; and the pen: `in` (wholly in the shown canvas), `out` (none of it) or `cut`. A size fails on
  any two parts overlapping (1 px slack) or a cut pen; the gaps between the parts, top to bottom, are listed. Exit 1 on a fail.
- `sheet.sh` makes 4 fps-style contact sheets (2 fps, 8×6) with ffmpeg.
- `run.sh OUTDIR URL "WxH:seq …" [args]` does all three over ssh; `TUNNEL="3017"` forwards a local server to the Mac.
- `step.mjs` (Mac) makes still frames at rest: it walks the page a wheel notch (a short drag on a phone) at a time and, at each whole
  stop of `t`, waits for the camera to settle and writes `NAME-NN.png` plus `NAME.steps.json` (t, the camera, the pen, the M8 record).
  For looking at each stage by eye; `--at 0,0.5,1` takes fractions of the page instead.

The probe: `window.__sceneProbe()` exists when the page is opened with `?probe`. It returns `t`, the pen tip's screen position
and whether it touches the paper, the ink head's screen position and the total inked length, the receipt's screen bbox and
printed length, and the camera pose.

Outputs for a round go to `qloo/feedback/r12/<sha>/` (outside the repo). Names say what they show: `1920-trackpad.webm`,
`390-touch-fast.webm`, with `.summary.json` and `-sheet-N.png` beside each.

## Notes

- Wheel events are fired on the clock and not awaited: Playwright's dispatch resolves only once the page's renderer has
  handled the event, so a page whose main thread is choked would otherwise slow the input itself down (the first run against
  production stalled for minutes). Unacknowledged input after the sequence is counted in `meta.errors`.
- The flick (`fast`) scrolls to the end, holds 2 s, then back to the top; `marks` in the probe log carry `back`, and the
  M4 drop checks stop there.
- M3's 40% area share is the delta's number; prototype B's own composition (the receipt filling the height, counter on both
  sides) gives about 20–37%, so the summary also carries the height share (`heightMinPct`).
- M4's latency is judged from the first input event for wheel sequences and from the first change of scrollY for touch
  sequences (Chrome scrolls a drag only after its touch slop, ~15 px, which at 200 px/s is most of the 100 ms); both numbers
  are in the summary.
- The probe's `pen.off`, `pen.jump`, `pen.reverted` and `pen.move` are the follower's state: the landing drift still fading, the
  distance the goal moved this frame (a flight starts above the scene's JUMP bound, except while writing: the tip steps along the
  line with the head, as far as the hand's cap allows), how many frames' ink the scene took back because the tip was not on it
  after the pen moved (0 in a healthy run), and the pen's own move this frame in screen px: the largest of its tip's, its middle's
  and its cap end's, before and after both through the frame's camera, so the camera's own motion is left out (v7: a pen turning
  in flight swung its cap end 100+ px a frame with the tip held). `pen.pts` are those three points on screen; `pen.rel` is their move
  since the previous probe sample, then and now both through that sample's camera. M7 judges `pen.move` and `pen.rel`, and
  reports the raw on-screen move of the three beside them.
- M8 (PM, v5): the probe carries every printed row with ink on screen (`rows`: its screen bbox from the paper's four corners,
  the receipt, the line, whether it is TOTAL or below, and which 3D object a ray from the camera meets first over it: cup, card,
  polaroid, the other receipt), and `m8`: the rows the page's overlays cover, measured where they put ink (text line boxes from
  `Range.getClientRects`, and elements that paint a box: a background, a border, an image, a field; `components/scene/cover.ts`).
  Each overlay carries its kind in `data-overlay`: `slip` (the question on the counter), `tip` (the hover tag), `caption`, `ask`
  (the quiet "asking…" mark), `strip` (the top bar and whatever hangs under it) and `edge` (the phone's bottom caption stack).
  v6 (H4): every overlay, bands and fades included, is judged on every frame, moving or not. v13 (nav draft A): the canvas is
  no longer cut; it runs under the top strip (on a phone the whole strip, on a wide screen the bar) and the phone's bottom band. The
  probe's `m8.clip` is those bands, in px. v14: the bottom band is judged like the rest of the frame (a caption over a row there is one),
  down to the credits' row at the edge frost's foot (34 px), where the paper fades out; the frost itself (`data-frost`) is no ink. The strip is
  judged by its veil (`m8.veil`, the opacity of the bar's, on a phone the strip's, frosted `::before`): with it up (≥ 0.5) a row under
  it is faded and passes, under the nav's text too; with it down a row in the bar's band is a cover (`bar`), and a row under the strip's
  ink is one either way, below the veil (`strip`): receipt rows under the bar are faded, never under nav text (`barRows` in cover.ts). The scene raises the veil (`data-paper-under` on the strip) as a receipt nears the bar's foot, led by its speed on screen and by where t is going (the paper's head at the camera's focus on t's way to its target: v14), so it is up before a row arrives; the phone's least bottom band is the edge's frost (58 px).
- The question slip (v5) is a paper on the counter on a wide screen: the runtime lays its element left of the receipt, level with
  the row it asks about and below the cup, with a CSS `matrix3d` homography from its box to its four corners on screen, and keeps
  the left polaroid column out of its place. On a phone it is a small tab in the bottom stack that opens a sheet. The hover tag is
  placed by the runtime beside the paper, level with its row, never over row text; a touch never shows it.
- M7 (PM, v4, v6, v7): on every frame the pen is drawn (in view or not: flights in and out of view included), `pen.move` ≤ 3% of the
  viewport's width (`--cap`), for the whole pen; the summary counts the frames drawn and those with some part of the pen on screen. Wherever any part of the
  pen is on screen, its own move between two probe samples (`pen.rel`: both through the earlier sample's camera, so a frame the
  log missed still counts) over 8% of the width is a violation too (the PM's teleport count). The raw on-screen move (camera
  included) is reported beside it; on a flick the camera's own pan carries the paper and the pen alike and shows there only.
- v13 (the speed limit): the scroll sets a target and `t` plays toward it, eased in and out under a speed cap that grows with the
  distance to go (runtime.ts T_ACC, T_VCAP): a notch lands in 0.1 s, a section in ~0.6 s, the whole track in ~0.7 s. The runtime keeps
  M6 itself: ink grows while `t` plays and up to 0.35 s after it lands (PEN_TAIL_S; 0.9 s after a flick), never past 1.1 s after the
  reader's last move (CATCH_S); what the M7 cap left unwritten waits, the pen poised over the line, for the next move. The probe's
  `pen.open` is 1 while the ink may grow.
- M9 (PM, v6; v13): after the scroll's last move, any change counts past 1.2 s (`--m9-ms`; the catch-up window): the pen's tip
  on screen by ≥ 1 px or its own move, the camera, `t`, the printed lengths (ours and the model's), the ink, the polaroids (`cards`,
  a sum over their positions). The runtime holds everything once `t` lands (it brakes onto the target exactly) and the ink closes: the pen
  stays poised where it is and goes on from there. Each `stop` mark's settle time is reported (`stopSettleMaxMs`).
- M6's limit is 1.2 s for every sequence (v13; was 0.3 s outside the flick sequences), unless `--m6-ms`.
- The scroll track (components/scene/types.ts STAGE_VH): the writing stage is 5.5 viewports on a PC and 10 on a phone (sized from the pen's screen path, ~10,400 px at 1920 and ~4,700 px at 390, two thirds of it the returns between lines, against the M7 cap: a trackpad burst at ~1,900 px/s or a touch drag at 800 px/s must leave no backlog past 0.3 s), the other
  stages one each; the sequences scroll the whole track, so the slow runs are longer than before.
- Probe logs and summaries mention nothing but geometry and timings; the videos show the sample statement's own lines.
- "During writing" for M3 is every frame within `--write-pad` (12, ~200 ms) of a frame where ink grew; the camera's departure from
  the last line (on the phone, the pan down the counter to the model-alone receipt) is not writing.
- The probe's `camT` is the timeline point the camera frames: t itself (PM, v3: the camera follows the scroll, never the pen's
  backlog; v13: the ink's targets follow `t` too, so the pen writes along with the eased timeline).
- `--live ORIGIN` answers the page's `/api/recording/*` and `/api/agent` requests from that origin through Playwright's `page.route`
  (the public production endpoints; no key), so a local `next start` shows the live recordings; `meta.sampleBadge` says whether the
  page still showed "Sample Qloo", and the `data` check fails a live run that did.
- M6 (PM, v3; v13): on every frame where ink grows, the time since scrollY last changed is ≤ 1,200 ms (`--m6-ms`); the summary carries the
  maximum seen.
- `run` check: the page's run must have ended `done` (`/`'s agent; production answers 429 past 6 runs per 10 min per IP, and `/`
  makes 3 per load) and some ink must have grown, else the run fails instead of passing with nothing to check. `record.mjs` exits 3
  on a run that ended in error; `run.sh` takes `PACE="2:600"` to keep `/` within that quota (2 loads per 10-min wall-clock window).
- Phone recordings (v8): headless Chrome with mobile emulation (`isMobile`, `hasTouch`, and a page with `<meta name=viewport
  content="width=device-width">`) presents no frame for ~0.24–0.28 s after every touch scroll gesture ends, while rAF keeps running at
  60 fps; a static 10-line page shows it too, and without the viewport meta it does not happen. Anything the scene changes in that
  window reaches the video as one jump at about +0.28 s. scrollY does not move after the lift (no momentum, no sub-pixel drift), so
  on touch the scene moves only on frames the finger scrolled (`input("touch")`, see the runtime), and a still video frame after a
  stop is the check.
