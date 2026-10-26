/**
 * A thermal-paper receipt as a three.js object (TypeScript port of the round-3
 * `receipt.js`, this project's own code, MIT).
 *
 * - Canvas texture: lines painted like a thermal printer (grey ink, faint banding).
 * - Geometry: a long plane whose free end curls; the printed length grows, so it
 *   "prints out". Mode `lie`: the paper lies in XZ, header at z=0, prints toward +z.
 */
import * as THREE from "three";

export const FONT = '"IBM Plex Mono", "SF Mono", Menlo, monospace';
export const HAND = "Caveat, cursive";
export const SANS = '"Instrument Sans", system-ui, sans-serif';

export type LineType =
  | "head" | "sub" | "rule" | "dots" | "row" | "swap" | "kv" | "total" | "big" | "note" | "barcode" | "blank" | "pen" | "ev" | "bridge";

export interface Line {
  t: LineType;
  text?: string;
  date?: string;
  name?: string;
  where?: string;
  amt?: string;
  save?: string;
  dim?: boolean;
  color?: string;
  k?: string;
  v?: string;
  small?: boolean;
  align?: "left" | "center" | "right";
  seed?: number;
  strike?: boolean;
  /** Merchant key for rows and pen lines (hover / click). */
  key?: string;
}

export interface ReceiptOptions {
  width?: number;
  px?: number;
  lineHeight?: number;
  fontSize?: number;
  pad?: number;
  ink?: string;
  paper?: string;
  accent?: string;
  dim?: string;
  maxLength?: number;
  mode?: "hang" | "lie";
  curlRadius?: number;
  curlLength?: number;
  speed?: number;
  segments?: number;
  sway?: number;
  glow?: number;
  /** Width in canvas px of a stroke laid over every glyph (0 = none): a hair more weight for a paper whose ink is a lighter grey. */
  bold?: number;
}

export class Receipt {
  W: number; px: number; lh: number; fs: number; pad: number;
  ink: string; paper: string; accent: string; dim: string;
  Lmax: number; mode: "hang" | "lie"; curlR: number; curlLen: number;
  printed = 0; printTarget = 0; speed: number;
  lines: Line[] = []; L = 1;
  canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture;
  geo: THREE.PlaneGeometry; orig: Float32Array; mat: THREE.MeshStandardMaterial; mesh: THREE.Mesh; group: THREE.Group;
  time = 0; sway: number; printedLines = Infinity; bold: number;
  /** Geometry settled at its printed length: the per-frame vertex pass is skipped until it prints again. */
  settled = false;

  constructor(o: ReceiptOptions = {}) {
    this.W = o.width ?? 1; this.px = o.px ?? 1024; this.lh = o.lineHeight ?? 46; this.fs = o.fontSize ?? 30; this.pad = o.pad ?? 48;
    this.ink = o.ink ?? "#2a2622"; this.paper = o.paper ?? "#f8f4ea"; this.accent = o.accent ?? "#c8321f"; this.dim = o.dim ?? "#8a847a";
    this.Lmax = o.maxLength ?? 3.2; this.mode = o.mode ?? "hang";
    this.curlR = o.curlRadius ?? 0.22; this.curlLen = o.curlLength ?? 0.34; this.speed = o.speed ?? 0.9;
    this.canvas = document.createElement("canvas"); this.canvas.width = this.px; this.canvas.height = 1024;
    this.ctx = this.canvas.getContext("2d")!;
    this.tex = new THREE.CanvasTexture(this.canvas); this.tex.colorSpace = THREE.SRGBColorSpace; this.tex.anisotropy = 8;
    this.tex.wrapS = this.tex.wrapT = THREE.ClampToEdgeWrapping; this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    const segX = 16, segY = o.segments ?? 320;
    this.geo = new THREE.PlaneGeometry(this.W, this.Lmax, segX, segY);
    this.geo.translate(0, -this.Lmax / 2, 0);
    this.orig = (this.geo.attributes.position.array as Float32Array).slice();
    this.mat = new THREE.MeshStandardMaterial({ map: this.tex, side: THREE.DoubleSide, roughness: 0.92, metalness: 0, transparent: true, opacity: 1, emissive: new THREE.Color(o.glow ?? 0x171410), emissiveIntensity: 0.3, alphaTest: 0.5 });
    this.mesh = new THREE.Mesh(this.geo, this.mat); this.mesh.castShadow = true; this.mesh.receiveShadow = true;
    this.group = new THREE.Group(); this.group.add(this.mesh);
    if (this.mode === "lie") this.mesh.rotation.x = -Math.PI / 2;
    this.sway = o.sway ?? 1; this.bold = o.bold ?? 0;
  }

  /* ---------- painting ---------- */
  setLines(lines: Line[], upto = Infinity): number {
    this.lines = lines; this.printedLines = upto;
    const H = this.measure();
    if (this.canvas.height !== H) { this.canvas.height = H; this.tex.dispose(); } // a new size needs a new GPU texture
    this.L = (this.W * H) / this.px;
    this.tex.repeat.set(1, this.Lmax / this.L); this.tex.offset.set(0, 1 - this.Lmax / this.L);
    this.paint(); return this.L;
  }
  measure(): number { let y = this.pad; for (const l of this.lines) y += this.lineH(l); return Math.ceil(y + this.pad * 1.6); }
  lineH(l: Line | undefined): number {
    const lh = this.lh; if (!l) return lh;
    switch (l.t) { case "head": return lh * 1.6; case "sub": return lh * 0.95; case "rule": case "dots": return lh * 0.6; case "total": return lh * 1.5; case "big": return lh * 2.4; case "blank": return lh * 0.5; case "note": return lh * 0.95; case "ev": return lh * 0.75; case "bridge": return lh * 0.95; default: return lh; }
  }
  /** `upload` false: the caller sends the canvas to the GPU itself (the counter's paper, a strip at a time); `fromY`: only the canvas
   *  below that y is painted (the next month's block coming in: the whole paper's paint was a 25 ms frame). */
  paint(progressLine = this.printedLines, upload = true, fromY = 0): void {
    const c = this.ctx, W = this.px, H = this.canvas.height;
    if (this.bold > 0) { const bold = this.bold, fill = CanvasRenderingContext2D.prototype.fillText; c.fillText = function (this: CanvasRenderingContext2D, s: string, x: number, y: number, mw?: number) { fill.call(this, s, x, y, mw); this.save(); this.strokeStyle = this.fillStyle; this.lineWidth = bold; this.lineJoin = "round"; this.strokeText(s, x, y, mw); this.restore(); }; }
    c.setTransform(1, 0, 0, 1, 0, 0);
    if (fromY > 0) { c.save(); c.beginPath(); c.rect(0, fromY, W, H - fromY); c.clip(); }
    c.clearRect(0, 0, W, H);
    const g = c.createLinearGradient(0, 0, W, 0); g.addColorStop(0, this.paper); g.addColorStop(0.5, "#fbf9f3"); g.addColorStop(1, this.paper);
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    c.globalAlpha = 0.045; c.fillStyle = "#000";
    for (let y = Math.max(0, Math.floor(fromY / 6) - 1) * 6; y < H; y += 6) if ((y / 6) % 7 < 2) c.fillRect(0, y, W, 2);
    c.globalAlpha = 1;
    c.font = `${this.fs}px ${FONT}`; c.textBaseline = "alphabetic";
    let y = this.pad, i = 0;
    // a fractional progress fades its last line in (the model-alone rows that come in on their clock: nothing pops)
    for (const l of this.lines) { const h = this.lineH(l); if (i < progressLine && y + h >= fromY) { const a = Math.min(1, progressLine - i); if (a < 1) c.globalAlpha = a; this.drawLine(l, y, h); c.globalAlpha = 1; } y += h; i++; }
    // torn top edge: a serrated cut, alpha only (the material has alphaTest)
    if (fromY > 0) c.restore();
    if (fromY < 24) {
      c.save(); c.globalCompositeOperation = "destination-out"; c.beginPath(); c.moveTo(0, 0);
      for (let x = 0, k = 0; x <= W; x += 26, k++) c.lineTo(x, 2 + ((k * 7919) % 11)); c.lineTo(W, 0); c.closePath(); c.fill();
      c.beginPath(); c.moveTo(0, 0); for (let x = 0, k = 0; x <= W; x += 26, k++) { c.lineTo(x + 13, 14 + ((k * 104729) % 7)); c.lineTo(x + 26, 3 + ((k * 7919) % 11)); } c.lineTo(W, 0); c.closePath(); c.fill();
      c.restore();
    }
    if (this.bold > 0) delete (c as { fillText?: unknown }).fillText;
    if (upload) this.tex.needsUpdate = true;
  }
  drawLine(l: Line, y: number, h: number): void {
    const c = this.ctx, W = this.px, p = this.pad, right = W - p, base = y + h * 0.72;
    const ink = l.color ?? this.ink;
    c.fillStyle = ink; c.textAlign = "left";
    switch (l.t) {
      case "pen": case "ev": case "bridge": return; // written later, by the pen or beside it
      case "head": c.font = `600 ${this.fs * 1.55}px ${FONT}`; c.textAlign = "center"; c.fillText(l.text ?? "", W / 2, y + h * 0.78); c.font = `${this.fs}px ${FONT}`; break;
      case "sub": c.fillStyle = l.color ?? this.dim; c.textAlign = "center"; c.fillText(l.text ?? "", W / 2, base); break;
      case "rule": c.fillStyle = l.color ?? this.dim; c.globalAlpha = 0.7; c.fillRect(p, y + h / 2, W - 2 * p, 2); c.globalAlpha = 1; break;
      case "dots": c.fillStyle = l.color ?? this.dim; for (let x = p; x < right; x += 14) c.fillRect(x, y + h / 2, 7, 2); break;
      case "row": {
        c.fillStyle = l.dim ? this.dim : ink; c.fillText(l.date ?? "", p, base);
        c.fillText(l.name ?? "", p + 150, base);
        if (l.where) { c.font = `${this.fs * 0.78}px ${FONT}`; c.fillStyle = this.dim; c.fillText(l.where, p + 150 + c.measureText(l.name ?? "").width * 1.28 + 24, base); c.font = `${this.fs}px ${FONT}`; }
        c.textAlign = "right"; c.fillStyle = l.dim ? this.dim : ink; c.fillText(l.amt ?? "", right, base);
        break; }
      case "swap": {
        c.fillStyle = l.color ?? (l.dim ? this.dim : this.accent); c.fillText("→ " + (l.name ?? ""), p + 150, base);
        if (l.where) { c.font = `${this.fs * 0.78}px ${FONT}`; c.fillStyle = this.dim; c.fillText(l.where, p + 150 + c.measureText("→ " + (l.name ?? "")).width * 1.28 + 24, base); c.font = `${this.fs}px ${FONT}`; }
        c.textAlign = "right"; c.fillStyle = l.color ?? (l.dim ? this.dim : this.accent); c.fillText(l.amt ?? "", right, base);
        if (l.save) { c.font = `${this.fs * 0.78}px ${FONT}`; c.fillStyle = this.dim; c.fillText(l.save, right - c.measureText(l.amt ?? "").width * 1.28 - 26, base); c.font = `${this.fs}px ${FONT}`; }
        break; }
      case "kv": {
        c.fillStyle = l.dim ? this.dim : ink; c.fillText(l.k ?? "", p, base); c.textAlign = "right"; c.fillStyle = l.color ?? (l.dim ? this.dim : ink); if (l.small) c.font = `${this.fs * 0.8}px ${FONT}`; c.fillText(l.v ?? "", right, base);
        if (l.strike) { const w = c.measureText(l.v ?? "").width; c.fillRect(right - w - 4, base - this.fs * 0.3, w + 8, 2); } // printed strike (machine), the pen's strikes are drawn by the pen
        c.font = `${this.fs}px ${FONT}`; break; }
      case "total": c.font = `600 ${this.fs * 1.15}px ${FONT}`; c.fillText(l.k ?? "", p, base); c.textAlign = "right"; c.font = `600 ${this.fs * 1.5}px ${FONT}`; c.fillStyle = l.color ?? ink; c.fillText(l.v ?? "", right, base + 4); c.font = `${this.fs}px ${FONT}`; break;
      case "big": c.font = `700 ${this.fs * 2.2}px ${FONT}`; c.textAlign = l.align ?? "center"; c.fillStyle = l.color ?? ink; c.fillText(l.text ?? "", l.align === "left" ? p : l.align === "right" ? right : W / 2, y + h * 0.75); c.font = `${this.fs}px ${FONT}`; break;
      case "note": c.font = `${this.fs * 0.82}px ${FONT}`; c.fillStyle = l.color ?? this.dim; c.textAlign = l.align ?? "left"; c.fillText(l.text ?? "", l.align === "center" ? W / 2 : l.align === "right" ? right : p, base); c.font = `${this.fs}px ${FONT}`; break;
      case "barcode": { c.fillStyle = ink; let x = p + 60; let s = l.seed ?? 7; while (x < right - 60) { s = (s * 9301 + 49297) % 233280; const w = 2 + (s % 5); c.fillRect(x, y + 6, w, h - 12); x += w + 3 + (s % 4); } break; }
      default: break;
    }
  }
  /** Canvas y of the top of line `li`. */
  lineTop(li: number): number { let y = this.pad; for (let i = 0; i < li && i < this.lines.length; i++) y += this.lineH(this.lines[i]); return y; }
  /** World distance from the top of the paper to the centre of line `index`. */
  lineWorldY(index: number): number { const y = this.lineTop(index) + this.lineH(this.lines[index] ?? { t: "row" }) / 2; return (y / this.px) * this.W; }
  /** Line index at a canvas y, or -1. */
  lineAtY(py: number): number { let y = this.pad; for (let i = 0; i < this.lines.length; i++) { const hh = this.lineH(this.lines[i]); if (py >= y && py < y + hh) return i; y += hh; } return -1; }

  /* ---------- printing ---------- */
  print(toLength = this.L, immediate = false): void { this.printTarget = Math.min(toLength, this.L); if (immediate) this.printed = this.printTarget; this.settled = false; }
  printAll(immediate = false): void { this.print(this.L, immediate); }
  retract(immediate = false): void { this.printTarget = 0; if (immediate) this.printed = 0; }
  get isPrinting(): boolean { return Math.abs(this.printed - this.printTarget) > 1e-4; }

  /* ---------- per-frame ---------- */
  update(dt: number, pointerX = 0): void {
    this.time += dt;
    if (this.mode === "lie" && this.settled && !this.isPrinting) return; // nothing moves: keep the vertices
    if (this.printed < this.printTarget) this.printed = Math.min(this.printTarget, this.printed + this.speed * dt);
    else if (this.printed > this.printTarget) this.printed = Math.max(this.printTarget, this.printed - this.speed * 2.5 * dt);
    const pos = this.geo.attributes.position.array as Float32Array, o = this.orig, e = Math.max(0.02, this.printed);
    const r = this.curlR, cl = Math.min(this.curlLen, e * 0.6), start = e - cl, t = this.time, lie = this.mode === "lie";
    for (let i = 0; i < pos.length; i += 3) {
      const x = o[i], d = Math.min(-o[i + 1], e);
      let px = x, py = -d, pz = 0;
      if (d > start) { const s = d - start, th = s / r; py = -start - r * Math.sin(th); pz = r * (1 - Math.cos(th)); }
      if (!lie) {
        const sw = this.sway * (0.012 * Math.sin(t * 1.1 + d * 2.2) + pointerX * 0.03) * (d / this.Lmax) * 2;
        px += sw; pz += 0.02 * (1 - Math.cos((x / this.W) * Math.PI * 2)) * 0.5 + this.sway * 0.01 * Math.sin(t * 0.8 + d * 3.0 + x * 2);
      } else {
        pz += this.sway * 0.007 * (1 + Math.sin(d * 7 + t * 0.6) * Math.cos(x * 5)) + 0.006 * (1 - Math.cos((x / this.W) * Math.PI * 2));
      }
      pos[i] = px; pos[i + 1] = py; pos[i + 2] = pz;
    }
    this.geo.attributes.position.needsUpdate = true; this.geo.computeVertexNormals();
    this.geo.boundingSphere = null; this.geo.boundingBox = null; // the ray test caches these: stale bounds from a blank paper miss every later line
    if (!this.isPrinting) this.settled = true;
  }
  /** The index of the line under a world-space ray, or -1 (the paper's line positions are its canvas rows mapped along its length). */
  hitLine(ray: THREE.Raycaster): number {
    const h = ray.intersectObject(this.mesh, false)[0]; if (!h || !h.uv) return -1;
    const v = 1 - ((1 - h.uv.y) * this.Lmax) / this.L; return this.lineAtY((1 - v) * this.canvas.height);
  }
  /** Height of the lying paper above its plane at `d` along it and `x` across (the sway and the end curl): where the pen's tip rides. */
  surfaceLift(x: number, d: number): number {
    const e = Math.max(0.02, this.printed), cl = Math.min(this.curlLen, e * 0.6), start = e - cl;
    let pz = 0;
    if (d > start) { const th = Math.min(d - start, cl) / this.curlR; pz = this.curlR * (1 - Math.cos(th)); }
    if (this.mode === "lie") pz += this.sway * 0.007 * (1 + Math.sin(d * 7 + this.time * 0.6) * Math.cos(x * 5)) + 0.006 * (1 - Math.cos((x / this.W) * Math.PI * 2));
    return pz;
  }
  /** The curled free end: from `start` along the paper to the printed end, rising to `top` above the plane. */
  curl(): { start: number; end: number; top: number } { return this.curlAt(Math.max(0.02, this.printed)); }
  /** The curl the paper would have printed to `e`. */
  curlAt(e: number): { start: number; end: number; top: number } {
    const cl = Math.min(this.curlLen, e * 0.6);
    return { start: e - cl, end: e, top: this.curlR * (1 - Math.cos(cl / this.curlR)) };
  }
  dispose(): void { this.geo.dispose(); this.mat.dispose(); this.tex.dispose(); }
}

/* A photo card: a white-bordered print with a caption, as a plane. */
export interface PhotoCardOptions { w?: number; h?: number; paper?: string; ink?: string; sub?: string; scale?: number; /** after each draw: the texture to upload ahead of its first show */ onDraw?: (tex: THREE.Texture) => void }
export function photoCard(url: string | null, caption: string, o: PhotoCardOptions = {}): THREE.Mesh {
  const w = o.w ?? 512, h = o.h ?? 620, cv = document.createElement("canvas"); cv.width = w; cv.height = h; const c = cv.getContext("2d")!;
  c.fillStyle = o.paper ?? "#fbfaf6"; c.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const draw = (img: HTMLImageElement | null) => {
    const m = 24, iw = w - 2 * m, ih = iw; c.fillStyle = o.paper ?? "#fbfaf6"; c.fillRect(0, 0, w, h);
    c.save(); c.beginPath(); c.rect(m, m, iw, ih); c.clip();
    if (img) { const s = Math.max(iw / img.width, ih / img.height); c.drawImage(img, m + (iw - img.width * s) / 2, m + (ih - img.height * s) / 2, img.width * s, img.height * s); }
    else { c.fillStyle = "#ddd8cf"; c.fillRect(m, m, iw, ih); }
    c.restore();
    c.fillStyle = o.ink ?? "#2a2622"; c.font = `500 34px ${SANS}`; c.textAlign = "left";
    let cap = caption; while (cap.length > 3 && c.measureText(cap).width > (o.sub ? iw * 0.6 : iw)) cap = cap.slice(0, -2).trimEnd() + "…";
    c.fillText(cap, m, h - 42);
    if (o.sub) { c.fillStyle = "#8a847a"; c.font = `26px ${SANS}`; c.textAlign = "right"; let sub = o.sub; while (sub.length > 3 && c.measureText(sub).width > iw * 0.36) sub = sub.slice(0, -2).trimEnd() + "…"; c.fillText(sub, w - m, h - 42); }
    tex.needsUpdate = true; o.onDraw?.(tex);
  };
  draw(null);
  // decoded off the main thread before it is drawn
  if (url) { const img = new Image(); img.src = url; img.decode().then(() => draw(img), () => { if (img.complete && img.naturalWidth) draw(img); }); }
  const scale = o.scale ?? 0.5, geo = new THREE.PlaneGeometry(scale, (scale * h) / w);
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0, transparent: true, opacity: 1, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat); mesh.castShadow = true; mesh.receiveShadow = true; return mesh;
}

/* critically damped springs, stepped in the frame loop */
export class V3Spring {
  v: THREE.Vector3; t: THREE.Vector3; vel = new THREE.Vector3(); k: number; c: number;
  constructor(v: THREE.Vector3, response = 0.6, damping = 1) { this.v = v.clone(); this.t = v.clone(); const w = (2 * Math.PI) / response; this.k = w * w; this.c = 2 * damping * w; }
  set(t: THREE.Vector3, immediate = false): this { this.t.copy(t); if (immediate) { this.v.copy(t); this.vel.set(0, 0, 0); } return this; }
  step(dt: number): THREE.Vector3 {
    const n = Math.ceil(dt / 0.008), h = dt / n;
    for (let i = 0; i < n; i++) {
      const ax = -this.k * (this.v.x - this.t.x) - this.c * this.vel.x, ay = -this.k * (this.v.y - this.t.y) - this.c * this.vel.y, az = -this.k * (this.v.z - this.t.z) - this.c * this.vel.z;
      this.vel.x += ax * h; this.vel.y += ay * h; this.vel.z += az * h; this.v.x += this.vel.x * h; this.v.y += this.vel.y * h; this.v.z += this.vel.z * h;
    }
    return this.v;
  }
}
export class NSpring {
  v: number; t: number; vel = 0; k: number; c: number;
  constructor(v: number, response = 0.6, damping = 1) { this.v = v; this.t = v; const w = (2 * Math.PI) / response; this.k = w * w; this.c = 2 * damping * w; }
  set(t: number, immediate = false): this { this.t = t; if (immediate) { this.v = t; this.vel = 0; } return this; }
  step(dt: number): number { const n = Math.ceil(dt / 0.008), h = dt / n; for (let i = 0; i < n; i++) { const a = -this.k * (this.v - this.t) - this.c * this.vel; this.vel += a * h; this.v += this.vel * h; } return this.v; }
}
