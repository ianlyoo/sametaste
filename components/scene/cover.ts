/**
 * M8 (PM, v5): what covers a receipt row on screen. The runtime's probe gives every printed row's screen bbox and the 3D object over it;
 * this adds the page's DOM overlays (the slip, the hover tag, the strip with the nav and the figure, the captions), measured where they
 * put ink: each text line box, and each element that paints a box (a background, a border, an image or a field), fades and bands
 * included (v6, H4), but not the phone's edge frost (`data-frost`: it is no ink, it fades the paper out at the frame's foot). A row counts
 * only where the frame shows it: above the frost's foot, the credits' row (v14: the caption zone too, where a caption over rows is one); the top strip
 * is judged by its veil (barRows, v13). Only for the motion harness (`?probe`).
 */

/**
 * Which overlay a rect belongs to: the nearest `data-overlay` ancestor. "slip" (the question on the counter), "tip" (the hover tag), "caption"
 * (a text column over the frame), and the two edge bands the camera frames each stop clear of: "strip" (the top bar, the figure and the
 * printer under it) and "edge" (the phone's bottom stack).
 */
export type OverlayKind = string;
export interface Rect { x0: number; y0: number; x1: number; y1: number }
export interface Covered { which: number; li: number; fromTotal: number; kind: OverlayKind; ox: number; oy: number }

/** Overlap in px of two rects along x and y (0 when apart). */
export function overlap(a: Rect, b: Rect): { ox: number; oy: number } {
  return { ox: Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), oy: Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)) };
}

/** A row is covered when an overlay's ink overlaps it by more than `tol` px both ways (anti-aliasing and a glyph's side bearing aside). */
export function coveredRows(rows: number[][], overlays: { kind: OverlayKind; r: Rect }[], view: { w: number; h: number; top?: number; bottom?: number }, tol = 3): Covered[] {
  const out: Covered[] = [];
  for (const row of rows) {
    const r = { x0: Math.max(0, row[0]), y0: Math.max(view.top ?? 0, row[1]), x1: Math.min(view.w, row[2]), y1: Math.min(view.h - (view.bottom ?? 0), row[3]) };
    if (r.x1 - r.x0 < 1 || r.y1 - r.y0 < 1) continue;
    let best: Covered | null = null;
    for (const o of overlays) {
      const { ox, oy } = overlap(r, o.r);
      if (ox > tol && oy > tol && (!best || ox * oy > best.ox * best.oy)) best = { which: row[4], li: row[5], fromTotal: row[6], kind: o.kind, ox: Math.round(ox), oy: Math.round(oy) };
    }
    if (best) out.push(best);
  }
  return out;
}

/**
 * M8 under the bar (v13, nav draft A): the canvas runs under the top strip, and the strip's veil (a frosted fade, `veil.a` its opacity,
 * down to `veil.y1`) comes up once the paper scrolls under it. With the veil up (half opacity or more) a row under it is faded and passes,
 * under the strip's text too; with it down, a row in the bar's band (`view.top` px) is one ("bar"). A row under the strip's ink where no
 * veil fades it is one either way ("strip"): never under the nav's text.
 */
export function barRows(rows: number[][], strip: Rect[], view: { w: number; h: number; top: number; bottom?: number }, veil: { a: number; y1: number }, tol = 3): Covered[] {
  const up = veil.a >= 0.5;
  const out = coveredRows(rows, strip.filter((r) => !(up && r.y1 <= veil.y1 + 1)).map((r) => ({ kind: "strip", r })), { ...view, top: 0 }, tol);
  if (up) return out;
  const seen = new Set(out.map((c) => `${c.which}/${c.li}`));
  for (const row of rows) {
    if (seen.has(`${row[4]}/${row[5]}`)) continue;
    const ox = Math.min(view.w, row[2]) - Math.max(0, row[0]), oy = Math.min(view.top, row[3], view.h - (view.bottom ?? 0)) - Math.max(0, row[1]);
    if (ox > tol && oy > tol) out.push({ which: row[4], li: row[5], fromTotal: row[6], kind: "bar", ox: Math.round(ox), oy: Math.round(oy) });
  }
  return out;
}

const styleCache = new WeakMap<Element, boolean>();
/** The element paints a box of its own (not just its text). Cached per element: the overlays' styles don't change while a run is recorded. */
function paintsBox(el: Element): boolean {
  const hit = styleCache.get(el); if (hit != null) return hit;
  const cs = getComputedStyle(el);
  const alpha = (c: string) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return c === "transparent" ? 0 : 1; const p = m[1].split(/[\s,/]+/).filter(Boolean); return p.length > 3 ? parseFloat(p[3]) : 1; };
  const border = ["Top", "Right", "Bottom", "Left"].some((s) => parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)) > 0 && alpha(cs.getPropertyValue(`border-${s.toLowerCase()}-color`)) > 0.05);
  const v = alpha(cs.backgroundColor) > 0.05 || cs.backgroundImage !== "none" || border || /^(IMG|SVG|INPUT|TEXTAREA|SELECT|CANVAS)$/i.test(el.tagName);
  styleCache.set(el, v); return v;
}

/**
 * The overlays' ink on screen: text line boxes and painted boxes under `root`, each with its kind; hidden ones left out.
 * `faded` keeps what is only transparent or hidden for now (fading in, or hidden by the runtime): where the ink will be, for the camera's framing.
 */
export function overlayRects(root: HTMLElement | null, faded = false): { kind: OverlayKind; r: Rect }[] {
  const out: { kind: OverlayKind; r: Rect }[] = []; if (!root) return out;
  const seen = (el: Element) => (typeof el.checkVisibility === "function" ? el.checkVisibility({ opacityProperty: !faded, visibilityProperty: !faded }) : true);
  const kindOf = (el: Element) => (el.closest("[data-overlay]") as HTMLElement | null)?.dataset.overlay ?? "caption";
  const range = document.createRange();
  const walk = (el: Element) => {
    const kind = kindOf(el); if (!seen(el) || el.hasAttribute("data-frost")) return;
    if (el !== root && paintsBox(el)) { const b = el.getBoundingClientRect(); if (b.width > 0 && b.height > 0) out.push({ kind, r: { x0: b.left, y0: b.top, x1: b.right, y1: b.bottom } }); }
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        if (!n.textContent?.trim()) continue;
        range.selectNodeContents(n);
        for (const b of range.getClientRects()) if (b.width > 0 && b.height > 0) out.push({ kind, r: { x0: b.left, y0: b.top, x1: b.right, y1: b.bottom } });
      } else if (n.nodeType === Node.ELEMENT_NODE) walk(n as Element);
    }
  };
  walk(root);
  return out;
}
