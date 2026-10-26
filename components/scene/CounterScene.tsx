"use client";

/**
 * CounterScene: the round-3 "B Counter" as a client component. Props in
 * `types.ts`. The three.js work lives in `runtime.ts`; this file owns the
 * canvas, scroll space, pointer events, the tooltip, the photo-credit toggle,
 * the app's overlay slots and a text alternative of the receipt.
 */
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { OTHER_CREDITS, PHOTO_CREDITS } from "./credits";
import { barRows, coveredRows, overlayRects } from "./cover";
import { deriveReceipt } from "./model";
import { money } from "./lines";
import type { Runtime, SceneProbe } from "./runtime";
import { SCENE_SECTIONS, sectionAtVh, sectionTopVh, trackVh, type CounterSceneHandle, type CounterSceneProps, type SceneSection } from "./types";

const BG = "#e8e2d6";

declare global {
  interface Window { __ready?: boolean; __sceneDebug?: () => Record<string, unknown> | undefined; __penLog?: () => unknown; __sceneProbe?: () => unknown; __scene?: CounterSceneHandle }
}

export default function CounterScene(props: CounterSceneProps) {
  const { data, onReject, onUndo, onAnswer: _onAnswer, section, onSectionChange, variant = "page", instant, reducedMotion, assetBase = "/scene", poster, onReady, onProofVisible, onTheirsPrinted, className, slots, ref } = props;
  void _onAnswer; // questions have no scene UI yet; see types.ts
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rtRef = useRef<Runtime | null>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const botRef = useRef<HTMLDivElement>(null);
  // latest props for the runtime's callbacks, updated after render
  const latest = useRef({ data, section, onReject, onUndo, onSectionChange, onReady, onProofVisible, onTheirsPrinted });
  useEffect(() => { latest.current = { data, section, onReject, onUndo, onSectionChange, onReady, onProofVisible, onTheirsPrinted }; });
  const tipRef = useRef<HTMLDivElement>(null);
  const slipRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const askRef = useRef<HTMLDivElement>(null);
  // the frame's bands: the top strip (a phone: all of it; a wide screen: the bar) and the phone's bottom stack. Nav draft A:
  // the canvas runs under them, uncut (a cut showed as a solid block of stone); the strip's veil and the bottom frost fade the paper there.
  // Measured still, for the ask mark's place and the probe (M8, pose, landing)
  const bandsRef = useRef({ top: 0, bottom: 0 });
  const putBand = (k: "top" | "bottom", v: number) => { v = Math.max(0, Math.round(v)); if (bandsRef.current[k] === v) return; bandsRef.current = { ...bandsRef.current, [k]: v }; rtRef.current?.setAskEl(askRef.current, bandsRef.current); if (k === "top") rtRef.current?.setVeilLine(v); };
  const [credits, setCredits] = useState(false);
  const [ready, setReady] = useState(false);
  const [sec, setSec] = useState(0);
  const [portrait, setPortrait] = useState(false);

  const controlled = section !== undefined || variant === "embed";
  const page = variant === "page";
  const instantOn = useMemo(() => instant ?? (typeof location !== "undefined" && new URLSearchParams(location.search).has("instant")), [instant]);
  // `#poster`: the bare scene, for the poster frame shown under the canvas while it loads
  const bare = useMemo(() => typeof location !== "undefined" && location.hash.includes("poster"), []);
  const gotoSection = (i: number, smooth: boolean) => {
    const root = rootRef.current; if (!root) return;
    const base = root.getBoundingClientRect().top + scrollY;
    scrollTo({ top: base + sectionTopVh(Math.max(0, Math.min(SCENE_SECTIONS.length - 1, i)), isPortrait()) * innerHeight, behavior: smooth ? "smooth" : "auto" });
  };

  // the imperative API: × and the nav
  const handle = useMemo<CounterSceneHandle>(() => ({
    reset: () => { gotoSection(0, false); rtRef.current?.reset(); },
    seek: (s) => gotoSection(typeof s === "number" ? s : SCENE_SECTIONS.indexOf(s), !instantOn),
  }), [instantOn]);
  useImperativeHandle(ref, () => handle, [handle]);
  useEffect(() => { window.__scene = handle; return () => { if (window.__scene === handle) delete window.__scene; }; }, [handle]);

  // one runtime per mount
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const rm = reducedMotion ?? (typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches);
    let rt: Runtime | null = null;
    let alive = true;
    (async () => {
      const { createRuntime } = await import("./runtime");
      if (!alive) return;
      rt = createRuntime({
        canvas, assetBase, instant: instantOn, reducedMotion: rm, controlled,
        onReady: () => { if (!alive) return; setReady(true); window.__ready = true; latest.current.onReady?.(); },
        onSection: (i) => { if (alive) setSec(i); latest.current.onSectionChange?.(SCENE_SECTIONS[i] ?? "statement"); },
        onReject: (id) => latest.current.onReject(id),
        onUndo: (id) => latest.current.onUndo?.(id),
        onProofVisible: () => latest.current.onProofVisible?.(),
        onTheirsPrinted: (p) => latest.current.onTheirsPrinted?.(p),
        // nav draft A (v13): the strip's veil (TopBar's CSS) shows while a receipt is under the bar or nearing it
        onPaperUnder: (u) => topRef.current?.toggleAttribute("data-paper-under", u),
      });
      rtRef.current = rt;
      window.__sceneDebug = () => rt?.debug(); window.__penLog = () => rt?.penLog();
      rt.setTipEl(tipRef.current); rt.setSlipEl(slipRef.current); rt.setAskEl(askRef.current, bandsRef.current); if (page) rt.setVeilLine(bandsRef.current.top);
      // the motion harness (eval/motion) reads the pen, the ink, the paper and the camera every frame, and M8: what covers a receipt row
      if (new URLSearchParams(location.search).has("probe")) window.__sceneProbe = () => { const p = rt?.probe(); return p && withCover(p, overlayRef.current, bandsRef.current); };
      rt.setData(latest.current.data);
      if (controlled) rt.setSection(SCENE_SECTIONS.indexOf(latest.current.section ?? "statement"));
      else rt.setScroll(scrollSections(rootRef.current), scrollPx(rootRef.current));
    })();
    return () => { alive = false; window.__ready = false; delete window.__sceneProbe; rt?.dispose(); rtRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetBase, instantOn, controlled]);

  useEffect(() => { rtRef.current?.setData(data); }, [data]);
  useEffect(() => { if (section !== undefined) rtRef.current?.setSection(SCENE_SECTIONS.indexOf(section)); }, [section]);

  // scroll space (page variant, uncontrolled): the track's stages (types.ts STAGE_VH), the writing stage longer than one viewport
  useEffect(() => {
    if (controlled) return;
    const onScroll = () => rtRef.current?.setScroll(scrollSections(rootRef.current), scrollPx(rootRef.current));
    addEventListener("scroll", onScroll, { passive: true });
    // deep link: #2 or #swaps
    const h = location.hash.replace("#", "");
    const idx = h ? (isNaN(+h) ? SCENE_SECTIONS.indexOf(h as SceneSection) : +h) : 0;
    if (idx > 0 && rootRef.current) { const top = rootRef.current.getBoundingClientRect().top + scrollY; scrollTo(0, top + sectionTopVh(idx, isPortrait()) * innerHeight); }
    onScroll();
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /input|textarea|select/i.test(e.target.tagName)) return;
      rtRef.current?.input("wheel"); const root = rootRef.current; if (!root) return;
      const base = root.getBoundingClientRect().top + scrollY, sec = Math.round(sectionAtVh((scrollY - base) / innerHeight, isPortrait()));
      const go = (i: number) => gotoSection(i, !instantOn);
      if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " " || e.key === "PageDown") { e.preventDefault(); go(sec + 1); }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); go(sec - 1); }
    };
    addEventListener("keydown", onKey);
    // past the page's end the scroll can't move: a wheel or a drag there is still the reader's input (the model-alone receipt that came late prints with it)
    const atEnd = () => scrollY >= document.documentElement.scrollHeight - innerHeight - 1;
    const onWheel = (e: WheelEvent) => { rtRef.current?.input("wheel"); if (e.deltaY > 0 && atEnd()) rtRef.current?.nudge(e.deltaY); };
    let ty: number | null = null;
    const onTouch = (e: TouchEvent) => { rtRef.current?.input("touch"); const y = e.touches[0]?.clientY; if (y == null) return; if (e.type === "touchmove" && ty != null && ty - y > 0 && atEnd()) rtRef.current?.nudge(ty - y); ty = y; };
    addEventListener("wheel", onWheel, { passive: true }); addEventListener("touchstart", onTouch, { passive: true }); addEventListener("touchmove", onTouch, { passive: true });
    return () => { removeEventListener("scroll", onScroll); removeEventListener("keydown", onKey); removeEventListener("wheel", onWheel); removeEventListener("touchstart", onTouch); removeEventListener("touchmove", onTouch); };
  }, [controlled, instantOn]);

  // the app's top strip: its height goes to the runtime, which keeps each section's first paper line clear of it
  useEffect(() => {
    const el = topRef.current;
    // and how far it reaches over the right half (the bar, and a slip at the right), where the wide proof puts the model-alone header
    const push = () => {
      if (!el) { putBand("top", 0); return rtRef.current?.setTopInset(0); }
      const h = el.getBoundingClientRect().height, bar = el.querySelector("header")?.getBoundingClientRect().bottom ?? h;
      const right = overlayRects(el, true).filter((o) => o.r.x1 > innerWidth / 2).reduce((m, o) => Math.max(m, o.r.y1), bar);
      rtRef.current?.setTopInset(h, Math.round(Math.min(h, right)));
      if (page) putBand("top", isPortrait() ? h : bar);
    };
    push();
    const ro = el && typeof ResizeObserver !== "undefined" ? new ResizeObserver(push) : null;
    if (ro && el) ro.observe(el);
    return () => ro?.disconnect();
  }, [ready, slots?.top, portrait, variant]); // eslint-disable-line react-hooks/exhaustive-deps

  // the overlay at the bottom (the phone's caption stack): its height goes to the runtime too, which frames each section's last needed row above
  // it (PM, scene-9: nothing over the receipts). On a wide screen it is the caption column at the upper left: the runtime keeps our paper right
  // of its ink, and hides it on the frames its camera, on the way to a new stop, still has the paper under it (v5, M8). A layout effect,
  // so a new caption is measured (and hidden if it must be) before the frame it first shows in is painted
  const botAnchored = portrait;
  useLayoutEffect(() => {
    const el = botRef.current;
    rtRef.current?.setCaptionEl(portrait ? null : el);
    const push = () => {
      const band = el && botAnchored ? Math.max(0, innerHeight - el.getBoundingClientRect().top) : 0;
      // a phone's frame ends above the credits' row's frost at least (v11, F2: with no caption stack, `/`'s last rows were under it)
      rtRef.current?.setBottomInset(page && portrait ? Math.max(band, EDGE_BAND) : band);
      // a phone's bottom band: the caption stack, or at least the photo credits' row; at the door (v10) only the credits' row, the door's
      // column (fixed over the canvas) going down to it
      const door = portrait && !!el?.querySelector("[data-paper-slot]");
      if (page) putBand("bottom", portrait ? (door ? EDGE_BAND : Math.max(band, EDGE_BAND)) : 0);
      const ink = el && !portrait ? overlayRects(el, true) : [];
      rtRef.current?.setCaptionBox(ink.length ? { x1: Math.max(...ink.map((o) => o.r.x1)), y1: Math.max(...ink.map((o) => o.r.y1)) } : null);
    };
    push();
    const ro = el && typeof ResizeObserver !== "undefined" ? new ResizeObserver(push) : null;
    if (ro && el) ro.observe(el);
    return () => ro?.disconnect();
  }, [ready, slots?.left, slots?.bottom, botAnchored, portrait]); // eslint-disable-line react-hooks/exhaustive-deps

  // the phone's front door (v10): the page keeps a slot for our paper's printed head between its persona cards and its drop card; the
  // scene frames the head in it and the slot takes the head's height on screen, so the cards, the paper and the drop card never overlap
  useLayoutEffect(() => {
    const el = portrait ? botRef.current?.querySelector<HTMLElement>("[data-paper-slot]") : null;
    if (!el) { rtRef.current?.setDoorSlot(null); return; }
    const size = (px: number) => { if (Math.abs(el.getBoundingClientRect().height - px) > 1) el.style.height = `${px}px`; };
    const push = () => { const r = el.getBoundingClientRect(); rtRef.current?.setDoorSlot({ top: Math.round(r.top), bottom: Math.round(r.bottom) }, size); };
    push();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(push) : null;
    ro?.observe(el); addEventListener("resize", push);
    return () => { ro?.disconnect(); removeEventListener("resize", push); rtRef.current?.setDoorSlot(null); };
  }, [ready, slots?.left, portrait]);

  // the question slip (landscape): the runtime lays it on the counter beside the receipt and keeps the polaroids out of its place
  const onCounter = !!slots?.counter && !portrait;
  useEffect(() => { rtRef.current?.setSlipEl(onCounter ? slipRef.current : null); }, [ready, onCounter, slots?.counter]);

  useEffect(() => {
    const onResize = () => { rtRef.current?.resize(); setPortrait(innerWidth / innerHeight < 0.8); };
    onResize();
    addEventListener("resize", onResize);
    const ro = typeof ResizeObserver !== "undefined" && canvasRef.current ? new ResizeObserver(onResize) : null;
    if (ro && canvasRef.current) ro.observe(canvasRef.current);
    return () => { removeEventListener("resize", onResize); ro?.disconnect(); };
  }, []);

  // the mouse parallax: the pointer over the whole window, the door's cards and every overlay included, not only the bare
  // canvas (hovering Maya, Dev or Sam dropped it and the view swung back); the runtime eases toward it, and back to the middle when it leaves
  useEffect(() => {
    const move = (e: PointerEvent) => { if (e.pointerType === "mouse") rtRef.current?.setLook((e.clientX / innerWidth) * 2 - 1); };
    const leave = () => rtRef.current?.setLook(0);
    addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("mouseleave", leave);
    return () => { removeEventListener("pointermove", move); document.documentElement.removeEventListener("mouseleave", leave); };
  }, []);

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    // a finger or a stylus moves the pointer for a tap's line, but brings no hover tag
    rtRef.current?.setPointer(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1, e.clientX - r.left, e.clientY - r.top, e.pointerType === "mouse");
  };

  const receipt = useMemo(() => deriveReceipt(data), [data]);
  const photos = useMemo(() => Object.values(PHOTO_CREDITS), []);

  // the photo credits: a bottom corner, on a phone too (v5, M8: in a row of their own under the top strip they sat on TOTAL at the
  // Understood stop); on a phone they open upward from the right corner, and leave at Proof, where no photo shows and the receipts'
  // barcodes reach the corner (PM, 1cedd1b)
  const creditsBtn = <button type="button" onClick={() => setCredits((v) => !v)} aria-expanded={credits} style={{ background: "none", border: 0, padding: 0, font: "inherit", color: "inherit", cursor: "pointer", textDecoration: credits ? "underline" : "none" }}>photos</button>;
  const creditsBox = (right: boolean) => credits && (
    <div style={{ position: "absolute", left: right ? "auto" : 0, right: right ? 0 : "auto", bottom: "1.6rem", width: 320, maxWidth: "calc(100vw - 2rem)", background: "rgba(243,239,230,.96)", color: "#3a352e", padding: ".8rem 1rem", fontSize: 12, lineHeight: 1.45, boxShadow: "0 8px 30px rgba(40,30,20,.12)", zIndex: 1 }}>
      {OTHER_CREDITS.map((l) => <div key={l}>{l}</div>)}
      <div style={{ marginTop: ".5rem", color: "#7a7368" }}>{photos.join(". ")}.</div>
    </div>
  );
  return (
    <div ref={rootRef} className={className} data-scene="counter" data-ready={ready ? "1" : "0"} style={{ position: "relative", background: BG, color: "#1d1a16", minHeight: page ? "100vh" : 480 }}>
      {/* the scroll track: one viewport per stage, the writing stage several (STAGE_VH); on a phone the proof has two stops (ours, then the model's) */}
      {page && <div aria-hidden style={{ height: `${trackVh(portrait) * 100}vh`, pointerEvents: "none" }} />}
      {/* the poster (v7, LOW): the wide screen's first frame of /demo, rendered from it (overlays aside), under the canvas until the scene draws its own
          (v6, M3: never on a phone, where no one still matches the first frame) */}
      {page && poster && !ready && (
        <picture>
          {/* a phone (the scene's portrait, aspect under 0.8) gets an empty pixel, from the first paint on (the media query, not the hydrated state) */}
          <source media="(max-aspect-ratio: 4/5)" srcSet="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" />
          <img src={`${assetBase}/poster.jpg`} alt="" aria-hidden style={{ position: "fixed", inset: 0, width: "100%", height: "100%", objectFit: "cover", pointerEvents: "none" }} />
        </picture>
      )}
      <canvas
        ref={canvasRef}
        aria-label="Your statement as a receipt on a counter"
        onPointerMove={onPointerMove}
        onPointerLeave={() => rtRef.current?.setPointer(0, 0, 0, 0, false)}
        onClick={() => rtRef.current?.click()}
        style={{ position: page ? "fixed" : "absolute", inset: 0, width: "100%", height: "100%", display: "block", touchAction: "pan-y", opacity: ready || !page ? 1 : 0 }}
      />
      {/* overlay: the app's surfaces in the zones the scene keeps clear */}
      <div ref={overlayRef} style={{ position: page ? "fixed" : "absolute", inset: 0, pointerEvents: "none", fontFamily: '"Instrument Sans", system-ui, sans-serif' }}>
        {/* a phone's bottom edge, the photo credits' row, where the scene frames nothing it needs: the paper fades out under a thin frost (draft A), under every overlay's text */}
        {portrait && <div aria-hidden data-overlay="edge" data-frost style={EDGE_FROST} />}
        {/* the question slip, laid on the counter by the runtime (a homography onto its place, under every other overlay); v5: never over the receipt */}
        {!bare && onCounter && <div ref={slipRef} data-overlay="slip" style={{ position: "absolute", left: 0, top: 0, width: SLIP_PX, transformOrigin: "0 0", visibility: "hidden", pointerEvents: "auto" }}>{slots?.counter}</div>}
        {/* the strip: the camera aim keeps each section's first line clear of it (setTopInset); its veil (TopBar's CSS, draft A) comes up while a receipt is under the bar or nearing it (data-paper-under, onPaperUnder) */}
        {!bare && slots?.top && <div ref={topRef} data-overlay="strip" style={{ position: "absolute", top: 0, left: 0, right: 0, pointerEvents: "auto" }}>{slots.top}</div>}
        {!bare && (slots?.left || slots?.bottom) && (
          <div ref={botRef} data-overlay={portrait ? "edge" : "caption"} style={portrait
            // the phone's caption stack: a fixed height so the frame never moves with its text (v6, H4)
            ? { position: "absolute", left: 0, right: 0, bottom: 0, height: PHONE_CAPTION, boxSizing: "border-box", padding: ".7rem 1rem 2.2rem", display: "flex", flexDirection: "column", gap: ".5rem", pointerEvents: "auto", overflow: "hidden", isolation: "isolate" }
            // upper-left beside the paper, in every section: in the proof too (v5, M8: at the bottom it sat over our paper's last rows); the
            // runtime keeps our paper right of its ink (setCaptionBox)
            : { position: "absolute", left: "3vw", top: "7rem", maxWidth: "30vw", display: "flex", flexDirection: "column", gap: "1.4rem", pointerEvents: "auto" }}>
            {/* the paper may run under it: a frosted fade rises behind its text, no edge (draft A) */}
            {portrait && <div aria-hidden style={CAPTION_FROST} />}
            {slots?.left && <div>{slots.left}</div>}
            {slots?.bottom && <div>{slots.bottom}</div>}
          </div>
        )}
        {!bare && slots?.right && !portrait && <div style={{ position: "absolute", right: "3vw", bottom: "7rem", width: "24vw", minWidth: 300, pointerEvents: "auto" }}>{slots.right}</div>}
        {/* the hover tag: the runtime writes it and places it beside the paper, level with its row (never over row text) */}
        {/* the model-alone receipt being asked for: a quiet mark where it will lie (the runtime places it; v6, M4) */}
        <div ref={askRef} data-overlay="ask" aria-hidden style={{ position: "absolute", left: 0, top: 0, display: "none", whiteSpace: "nowrap", fontFamily: '"IBM Plex Mono", ui-monospace, monospace', fontSize: 12, letterSpacing: ".06em", color: "#6f6960" }}>asking a model alone…</div>
        <div ref={tipRef} data-overlay="tip" role="tooltip" style={TIP_STYLE} />
        {!bare && !portrait && <div style={{ position: "absolute", left: sec >= 4 ? "auto" : "clamp(1rem, 3vw, 3rem)", right: sec >= 4 ? "clamp(1rem, 3vw, 3rem)" : "auto", bottom: "1.2rem", pointerEvents: "auto", fontSize: 12, color: "#6f6960" }}>{creditsBtn}{creditsBox(sec >= 4)}</div>}
        {!bare && page && portrait && sec < 4 && <div data-overlay="edge" style={{ position: "absolute", right: "1rem", bottom: ".9rem", pointerEvents: "auto", fontSize: 12, color: "#6f6960", textShadow: "0 0 2px rgba(243,239,230,.9), 0 0 10px rgba(243,239,230,.8)" }}>{creditsBtn}{creditsBox(true)}</div>}
      </div>
      {/* text alternative */}
      <ol style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>
        {receipt.rows.map((r) => (
          <li key={r.id}>{r.date} {r.name} {money(r.amount, receipt.currency)}{r.twin ? `, instead: ${r.twin.name}${r.twin.price != null ? ` ${money(r.twin.price, receipt.currency)}` : ""} (${r.twin.status})` : ""}</li>
        ))}
        <li>Total {money(receipt.total, receipt.currency)}; after swaps {money(receipt.totalAfter, receipt.currency)}; saving {money(receipt.saving, receipt.currency)}</li>
      </ol>
    </div>
  );
}

/** The slip's own width in CSS px before the runtime lays it on the counter (0.56 m there: about this wide at 1920 near the writing's rows). */
const SLIP_PX = 400;
/** A phone's caption stack (the bottom band, its text over the credits' row), and the band's least height with no caption: the credits' row
 *  under the edge's frost (EDGE_FROST, 3.6rem: v13, the paper fades there, so the camera frames nothing it needs under it). */
const PHONE_CAPTION = "9.6rem", EDGE_BAND = 58;
/** The credits' row at the edge frost's foot in px (2.1rem: the link sits 0.9rem up, the frost all but solid to 1.7rem), where the paper
 *  fades out: M8 judges the rows above it, the rest of the bottom band's included (v14). */
const EDGE_FOOT = 34;
/** Nav draft A's frosts: the phone's bottom edge, and behind its caption stack. */
const EDGE_FROST: React.CSSProperties = {
  position: "absolute", left: 0, right: 0, bottom: 0, height: "3.6rem", pointerEvents: "none",
  background: "color-mix(in srgb, var(--bg) 50%, transparent)", WebkitBackdropFilter: "blur(10px)", backdropFilter: "blur(10px)",
  WebkitMaskImage: "linear-gradient(to top, #000 1.7rem, transparent)", maskImage: "linear-gradient(to top, #000 1.7rem, transparent)",
};
const CAPTION_FROST: React.CSSProperties = {
  position: "absolute", inset: 0, zIndex: -1, pointerEvents: "none",
  background: "linear-gradient(color-mix(in srgb, var(--bg) 14%, transparent), color-mix(in srgb, var(--bg) 52%, transparent))",
  WebkitBackdropFilter: "blur(12px) saturate(1.08)", backdropFilter: "blur(12px) saturate(1.08)",
  WebkitMaskImage: "linear-gradient(transparent, #000 4rem)", maskImage: "linear-gradient(transparent, #000 4rem)",
};

/** The probe plus M8's DOM half: the rows any overlay's ink covers (cover.ts), above the phone's bottom band; the strip by its veil (barRows); the rows themselves stay out of the log. */
/** The hover tag (v10): a slip of the page's paper (its colour, sheen and shadow) in the receipt's mono capitals, not a dark chip. The
 *  runtime sizes its place for ~7.4 px a character plus 26 px (placeTip). */
const TIP_STYLE: React.CSSProperties = {
  position: "absolute", display: "none", whiteSpace: "nowrap", pointerEvents: "none",
  background: "linear-gradient(180deg, rgba(255,255,255,.55), rgba(255,255,255,0) 60%), var(--paper, #f7f3ea)", color: "var(--ink, #1d1a16)",
  font: "500 11px/1.4 var(--mono, ui-monospace, monospace)", letterSpacing: ".06em", textTransform: "uppercase", padding: ".45rem .7rem", borderRadius: 1,
  boxShadow: "0 1px 1.5px rgba(48,38,24,.14), 0 6px 12px -5px rgba(48,38,24,.24)",
};

function withCover(p: SceneProbe, root: HTMLElement | null, bands: { top: number; bottom: number }) {
  const { rows, ...rest } = p;
  const ink = overlayRects(root), view = { w: innerWidth, h: innerHeight, top: bands.top, bottom: bands.bottom };
  const slipEl = root?.querySelector<HTMLElement>("[data-overlay=slip]"), stripEl = root?.querySelector<HTMLElement>("[data-overlay=strip]");
  // v13 (nav draft A): the strip's veil, the bar's (a phone: the strip's) frosted ::before, its opacity as it fades in or out
  const bar = stripEl?.querySelector("header");
  let veil = { a: 0, y1: 0 };
  for (const el of bar ? [bar, bar.parentElement] : []) {
    const cs = el && getComputedStyle(el, "::before");
    if (cs && cs.content !== "none" && +cs.opacity > veil.a) veil = { a: +cs.opacity, y1: el.getBoundingClientRect().bottom };
  }
  // v14 (HIGH): the phone's bottom band is no bar of its own since nav A: what lies over a row there (a caption) is judged, down to the credits' row
  const low = { ...view, bottom: Math.min(bands.bottom, EDGE_FOOT) };
  const dom = [...coveredRows(rows, ink.filter((o) => o.kind !== "strip"), low), ...barRows(rows, ink.filter((o) => o.kind === "strip").map((o) => o.r), view, veil)];
  const obj = rows.filter((r) => r[7]);
  // v11 (F1): the question slip, where it shows, under none of the strip's text (the nav, the section's figure)
  let slipStrip = 0;
  // v12 (LOW): its opacity (0 hidden) and whether it takes clicks, to judge it at rest
  const slipCs = slipEl ? getComputedStyle(slipEl) : null, slipA = slipCs && slipCs.visibility === "visible" ? +(+(slipCs.opacity || 1)).toFixed(3) : 0, slipPe = slipCs && slipA > 0 && slipCs.pointerEvents !== "none" ? 1 : 0;
  if (slipEl && stripEl && slipA > 0.05) {
    const b = slipEl.getBoundingClientRect();
    for (const { r } of overlayRects(stripEl)) if (r.x0 < b.right - 1 && r.x1 > b.left + 1 && r.y0 < b.bottom - 1 && r.y1 > b.top + 1) slipStrip++;
  }
  // the harness's stop shots (v9) ask for the rows' boxes too, to check the pen's barrel against them
  const full = (window as unknown as { __probeRows?: boolean }).__probeRows ? { rowBoxes: rows } : {};
  return { ...rest, ...full, m8: { clip: [bands.top, bands.bottom], rows: rows.length, domN: dom.length, dom: dom.slice(0, 40).map((c) => [c.which, c.li, c.fromTotal, c.kind, c.ox, c.oy]), objN: obj.length, obj: obj.slice(0, 20).map((r) => [r[4], r[5], r[6], r[7]]), slipStrip, slipA, slipPe, veil: +veil.a.toFixed(2) } };
}

/** A phone held upright: the track has the proof's second stop and a longer writing stage. */
const isPortrait = () => window.innerWidth / window.innerHeight < 0.8;
/** Scroll position of the scene's own space in px (the runtime reads the scroll's speed from it). */
const scrollPx = (root: HTMLDivElement | null): number => (root ? -root.getBoundingClientRect().top : 0);
/** Scroll position of the scene's own space, in sections (the track's stages mapped back to the timeline). */
function scrollSections(root: HTMLDivElement | null): number {
  if (!root) return 0;
  return sectionAtVh(-root.getBoundingClientRect().top / Math.max(1, window.innerHeight), isPortrait());
}
