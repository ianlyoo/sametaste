/**
 * Pure derivation: flow state -> the lines printed on both receipts, the pen
 * targets (what the handwriting says under which line) and the totals. No
 * three.js, no DOM; unit-testable and reused for the text alternative.
 *
 * The paper is append-only while the agent works: the statement prints first,
 * the "READ AS TASTE" block is appended when merchants are resolved (four lines
 * reserved under each taste merchant: the row, the pen line, the evidence line,
 * the bridge line), the next-month block when the plan is in. Lines already
 * printed never move.
 */
import type { BaselineSuggestion, ProofSide, Swap, TasteFingerprint } from "../../lib/contract";
import type { Line } from "./receipt";
import { keptKind, proofRows } from "../../lib/agent/proof-rows";
import { shortAddress, twinMonthly } from "./model";
import type { SceneData } from "./types";

export const RED = "#c8321f";
export const GREY = "#8a847a";
export const STATEMENT_ROWS = 22; // B prints 22 lines before "N MORE LINES"
export const TASTE_ROWS = 24;
export const THESIS = "YOUR CARD STATEMENT IS YOUR MOST HONEST TASTE PROFILE.";

export const money = (v: number, currency = "USD"): string =>
  (v < 0 ? "−" : "") + (currency === "USD" ? "$" : currency + " ") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export type PenStatus = "waiting" | "proposed" | "accepted" | "rejected" | "replanning" | "kept";

export interface PenTarget {
  /** Index of the blank pen line and of the row above it. */
  li: number;
  rowLi: number;
  /** The printed evidence line under the handwriting (machine = Qloo's numbers). */
  evLi: number;
  evidence: string;
  /** The plan's hero bridge, hand-written after every twin is in (one per plan). */
  bridge?: { li: number; text: string; seq: string };
  /** For the other twins: the short printed bridge under the evidence ("ALSO LOVE: X"), and its line. */
  also: string;
  alsoLi: number | null;
  /** The twin the reader took out: scribbled on its own line before the replacement is written under it. */
  prior?: { li: number; text: string; save: string; seq: string };
  key: string;
  name: string;
  swapId?: string;
  swap?: Swap;
  status: PenStatus;
  /** Handwriting, saving (right-aligned) and the row amount to strike. Empty while waiting. */
  text: string;
  save: string;
  strike: boolean;
  color: string;
  /** Identity of this piece of handwriting; progress is kept per seq. */
  seq: string;
  /** Hover text, one sentence. */
  tip: string;
  /** Photo for this twin's polaroid, only when a photo honestly matches; else none. */
  photo: string | null;
  /** The twin's street, for the polaroid's corner. */
  where: string;
  /** The original's own polaroid (the reader's place, by what it is) and street; none without an honest photo. */
  fromPhoto: string | null;
  fromWhere: string;
}

export interface Totals { before: number; after: number; saving: number; currency: string; kept: number; all: number }

export interface SceneLayout {
  ours: Line[];
  /** End of the statement part (exclusive line index). */
  statementEnd: number;
  /** The statement's TOTAL line: it and every line below stay out from under the app's top strip (PM, scene-9). */
  totalLi: number;
  tasteStart: number | null;
  tasteEnd: number;
  nextStart: number | null;
  /** The SAVED line of the next-month block. */
  savedLi: number | null;
  /** Our receipt's closing note ("SAME TASTE. LESS ON THE CARD."): the last row the camera keeps above the bottom overlay (PM, scene-9). */
  endLi: number | null;
  /** The other receipt's last printed row (its "A MONTH" or last verdict), for the same framing. */
  theirsEndLi: number | null;
  pens: PenTarget[];
  theirs: Line[];
  theirsReady: boolean;
  /** The model-alone receipt is being asked for: `theirs` is its blank paper (theirsAsking), the header and the rows' places, nothing printed on them. */
  theirsAsking: boolean;
  /** The "A MONTH" total line on the other receipt. */
  theirsTotalLi: number | null;
  totals: Totals;
  labels: SceneLabels;
  /** Statement total: every spend line on the card. */
  statementTotal: number;
}

export interface SceneLabels { who: string; month: string; nextMonth: string; lines: number; place: string }

const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

export function sceneLabels(data: SceneData): SceneLabels {
  const who = (data.personaId?.split("-")[0] || "").toUpperCase() || "YOUR CARD";
  const place = (data.location?.label.split(",")[0] ?? "").trim().toUpperCase();
  const to = data.statement?.range.to;
  const d = to ? new Date(to + "T00:00:00Z") : null;
  const m = d && !isNaN(+d) ? d.getUTCMonth() : null;
  const y = d && !isNaN(+d) ? d.getUTCFullYear() : null;
  return {
    who,
    place,
    month: m == null ? "THIS MONTH" : `${MONTHS[m]} ${y}`,
    nextMonth: m == null ? "NEXT MONTH" : MONTHS[(m + 1) % 12],
    lines: data.statement?.transactions.filter((t) => t.amount > 0).length ?? 0,
  };
}

const mmdd = (iso: string) => (iso.length >= 10 ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}` : iso);
const up = (s: string) => s.toUpperCase();
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** Swaps that count, the same rule as `savingsTotals` in lib/client/flow.ts. */
export function countingSwaps(swaps: Swap[]): Swap[] {
  const accepted = swaps.filter((x) => x.status === "accepted");
  return accepted.length ? accepted : swaps.filter((x) => x.status === "proposed");
}

export function totals(data: SceneData): Totals {
  const list = countingSwaps(data.swaps);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  // WAS is the whole taste spend as the plan counts it, kept lines included (B's WAS is the whole statement);
  // a rejected swap only takes its own saving back
  const before = r2(data.plan?.totals.monthlyBefore ?? list.reduce((a, x) => a + x.from.monthlySpend, 0));
  const saving = r2(list.reduce((a, x) => a + x.savings.monthlySavings, 0));
  const keys = new Set(data.swaps.map((x) => x.merchantKey));
  const kept = new Set(list.map((x) => x.merchantKey));
  return { before, after: r2(before - saving), saving, currency: data.plan?.currency ?? list[0]?.savings.currency ?? "USD", kept: kept.size, all: keys.size };
}

function fingerprintLines(fp: TasteFingerprint | undefined): Line[] {
  if (!fp) return [];
  const groups: [string, string][] = [["artist", "MUSIC"], ["movie", "FILM"], ["tv_show", "TV"], ["book", "BOOKS"], ["podcast", "PODCASTS"], ["brand", "BRANDS"]];
  const out: Line[] = [];
  for (const [domain, label] of groups) {
    const names = fp.affinities.filter((a) => a.domain === domain).sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0)).map((a) => a.entity.name);
    if (names.length) out.push({ t: "kv", k: label, v: fitNames([...new Set(names)].map(up), 44), small: true });
  }
  if (fp.topTags.length) out.push({ t: "kv", k: "PLACES", v: fitNames(fp.topTags.map((t) => up(t.name)), 44, 3), small: true });
  // the headline opens with the same tags, so it would print them twice: each kv line once, nothing else
  return out;
}

function swapFor(swaps: Swap[], key: string): Swap | undefined {
  return swaps.find((s) => s.merchantKey === key && s.status !== "rejected") ?? [...swaps].reverse().find((s) => s.merchantKey === key);
}

const dollars = (n: number | undefined) => (n == null || n <= 0 ? "" : "$".repeat(Math.min(4, Math.round(n))));

/** The printed evidence line: Qloo's own numbers for the twin, nothing invented. Empty when the data has none. */
export function evidenceLine(sw: Swap): string {
  const ev = sw.to.evidence; if (!ev) return "";
  const parts: string[] = [];
  if (ev.affinity != null) parts.push(`QLOO ${ev.affinity.toFixed(2)}`);
  const shared = new Set(ev.sharedTagIds ?? []);
  // a shared tag that fits the column whole beats one cut mid-word ("WHEELCHAIR ACCESSI")
  const fits = (t: { name: string }) => t.name.length <= 18;
  const tag = ev.tags.find((t) => shared.has(t.id) && fits(t)) ?? ev.tags.find(fits) ?? ev.tags.find((t) => shared.has(t.id)) ?? ev.tags[0];
  if (tag) parts.push(up(tag.name).slice(0, 18));
  if (ev.distanceKm != null) parts.push(`${ev.distanceKm < 10 ? ev.distanceKm.toFixed(1) : Math.round(ev.distanceKm)} KM`);
  const from = dollars(ev.fromPriceLevel), to = dollars(ev.priceLevel);
  if (from && to && from !== to) parts.push(`${from}→${to}`); else if (to) parts.push(to);
  return parts.join("   ");
}

/** The strongest cross-domain entity in the swap's evidence, by name. */
function topCross(sw: Swap): string {
  const cd = sw.to.evidence?.crossDomain; if (!cd?.length) return "";
  const top = [...cd].sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0))[0];
  return top?.entity?.name ?? "";
}
/** What both crowds love, out of a note like "Fans of A and B both love C", "also love C" or just "C". */
export function bridgeName(note: string): string {
  const m = note.match(/(?:both|also)\s+love:?\s+(.+?)\.?$/i);
  return (m ? m[1] : note).trim();
}
/** The short printed bridge for a twin: "ALSO LOVE: X", at most 40 characters, no names repeated. Empty without data. */
export function alsoLine(sw: Swap): string {
  const note = sw.crossDomainNote?.trim();
  const x = note ? bridgeName(note) : topCross(sw);
  return x ? clip(`ALSO LOVE: ${up(x)}`, 40) : "";
}
/** The hero bridge the pen writes: the full note when it names both places, else "<name> fans also love X". */
export function heroText(sw: Swap, name: string): string {
  const note = sw.crossDomainNote?.trim();
  if (note && /both love/i.test(note)) return clip(note, 84);
  const x = note ? bridgeName(note) : topCross(sw);
  return x ? clip(`${name} fans also love ${x}`, 84) : "";
}
export const bridgeText = heroText;

export const twinText = (sw: Swap, cur: string): string => `→ ${sw.to.entity.name}   ${money(twinMonthly(sw), cur)}`;
export const twinSave = (sw: Swap, cur: string): string => "−" + money(sw.savings.monthlySavings, cur);

/**
 * Which swap's bridge the pen writes: the plan's `heroBridge` (contract 1.3), else the first counting swap that
 * has a bridge, so the paper's layout holds from the first twin on. None without any bridge.
 */
export function heroBridge(data: SceneData): { key: string; text?: string } | null {
  const hb = (data.plan as { heroBridge?: unknown } | null)?.heroBridge;
  const swaps = countingSwaps(data.swaps);
  const byRef = (ref: string) => swaps.find((x) => x.merchantKey === ref || x.id === ref);
  if (typeof hb === "string" && hb) { const sw = byRef(hb); if (sw) return { key: sw.merchantKey }; }
  if (hb && typeof hb === "object") {
    const o = hb as { merchantKey?: string; swapId?: string; text?: string; note?: string };
    const sw = (o.swapId && byRef(o.swapId)) || (o.merchantKey && byRef(o.merchantKey));
    if (sw) return { key: sw.merchantKey, text: (o.text ?? o.note)?.trim() || undefined };
  }
  const first = swaps.find((x) => alsoLine(x));
  return first ? { key: first.merchantKey } : null;
}

/** Whole names only, at most `max` of them, within `width` characters: no mid-word cuts on paper. */
function fitNames(names: string[], width: number, max = 2): string {
  const out: string[] = [];
  for (const n of names) { const next = [...out, n].join(", "); if (out.length >= max || next.length > width) break; out.push(n); }
  return out.length ? out.join(", ") : clip(names[0] ?? "", width);
}

/** A twin the reader took out, remembered by the scene after the flow drops it for its replacement. */
export interface Prior { swapId: string; text: string; save: string; seq: string }
/**
 * Remember every rejected twin by merchant key (the flow replaces it in `swaps` once the re-plan answers), and forget
 * one the reader undid. The scene keeps this map across data updates so the scribble stays on the paper.
 */
export function collectPriors(data: SceneData, priors: Record<string, Prior>): void {
  const cur = data.plan?.currency ?? data.merchants[0]?.currency ?? "USD";
  for (const sw of data.swaps) {
    if (sw.status === "rejected") priors[sw.merchantKey] = { swapId: sw.id, text: twinText(sw, cur), save: twinSave(sw, cur), seq: `${sw.merchantKey}:${sw.id}:x` };
    else if (priors[sw.merchantKey]?.swapId === sw.id) delete priors[sw.merchantKey]; // undone: the twin is back
  }
}

export function buildLayout(data: SceneData, priors: Record<string, Prior> = {}): SceneLayout {
  const labels = sceneLabels(data);
  const cur = data.plan?.currency ?? data.merchants[0]?.currency ?? "USD";
  const txns = (data.statement?.transactions ?? []).filter((t) => t.amount > 0);
  const statementTotal = Math.round(txns.reduce((a, t) => a + t.amount, 0) * 100) / 100;

  /* ---- statement ---- */
  const L: Line[] = [
    { t: "head", text: "SAMETASTE" },
    { t: "sub", text: "TASTE READ WITH QLOO" },
    { t: "sub", text: `${labels.place ? `${labels.who}, ${labels.place}` : labels.who}. ${labels.month}, ${labels.lines} LINES` },
    { t: "dots" },
    { t: "note", text: THESIS, align: "center" },
    { t: "dots" },
  ];
  const shown = txns.slice(0, STATEMENT_ROWS);
  for (const t of shown) L.push({ t: "row", date: mmdd(t.date), name: clip(up(t.rawMerchant), 30), amt: money(t.amount, cur) });
  const rest = txns.slice(STATEMENT_ROWS);
  if (rest.length) L.push({ t: "row", date: "", name: `${rest.length} MORE LINES`, amt: money(rest.reduce((a, t) => a + t.amount, 0), cur), dim: true });
  L.push({ t: "dots" });
  const totalLi = L.length;
  L.push({ t: "total", k: "TOTAL", v: money(statementTotal, cur) }, { t: "dots" });
  const statementEnd = L.length;

  /* ---- read as taste ---- */
  const pens: PenTarget[] = [];
  const unswapped = new Map((data.plan?.unswapped ?? []).map((u) => [u.merchantKey, u]));
  // contract 1.2: the same place under two descriptors is one line (the swap carries `mergedKeys`);
  // contract 1.3 announces the merges up front in run_started, so a kept line merges too
  const mergedInto = new Map<string, string>();
  for (const m of data.run.merges ?? []) for (const mk of m.mergedKeys) mergedInto.set(mk, m.merchantKey);
  for (const s of data.swaps) for (const mk of s.mergedKeys ?? []) mergedInto.set(mk, s.merchantKey);
  const tasteKeys = data.merchants
    .map((m) => m.key)
    .filter((k) => {
      if (mergedInto.has(k)) return false;
      const r = data.resolutions[k];
      if (r) return r.status !== "skipped";
      return data.swaps.some((s) => s.merchantKey === k) || unswapped.has(k);
    });
  // the agent leaves bills and transfers out of `merchants_resolved` (or marks them skipped)
  const resolvedAny = Object.keys(data.resolutions).length > 0;
  const skipped = data.merchants.filter((m) => { if (mergedInto.has(m.key)) return false; const r = data.resolutions[m.key]; return r ? r.status === "skipped" : resolvedAny && !tasteKeys.includes(m.key); });
  let tasteStart: number | null = null;
  const usedPhotos = new Set<string>();
  const hero = heroBridge(data);
  // the reader's own places claim their photos first (B's polaroids), each photo once across both kinds
  const fromPhotos = new Map<string, string | null>();
  // the statement's own category is often "other"; the agent's swap knows what the place is
  for (const k of tasteKeys.slice(0, TASTE_ROWS)) { const m = data.merchants.find((x) => x.key === k)!; fromPhotos.set(k, photoForPlace(swapFor(data.swaps, k)?.category ?? m.category ?? "", [], data.resolutions[k]?.normalizedName ?? m.name, usedPhotos)); }
  if (tasteKeys.length) {
    tasteStart = L.length;
    L.push({ t: "note", text: "READ AS TASTE", color: RED });
    const running = data.run.status === "running";
    for (const k of tasteKeys.slice(0, TASTE_ROWS)) {
      const m = data.merchants.find((x) => x.key === k)!;
      const r = data.resolutions[k];
      const name = r?.normalizedName ?? m.name;
      const sw = swapFor(data.swaps, k);
      const replanning = data.replanning.includes(k);
      const kept = unswapped.get(k);
      let status: PenStatus = "waiting";
      if (sw && replanning && sw.status === "rejected") status = "replanning";
      else if (sw) status = sw.status;
      else if (kept) status = "kept";
      else if (!running && data.run.status !== "idle") status = "kept";
      const live = !!sw && (status === "proposed" || status === "accepted");
      const rowLi = L.length;
      const merged = data.merchants.filter((x) => mergedInto.get(x.key) === k);
      const count = m.count + merged.reduce((a, x) => a + x.count, 0), spend = m.totalSpend + merged.reduce((a, x) => a + x.totalSpend, 0);
      L.push({ t: "row", date: `${count}×`, name: clip(up(name), 30), amt: money(spend, cur), key: k });
      // a twin the reader took out keeps its line: the pen scribbles it before writing the replacement under it
      const old = live && priors[k] && priors[k].swapId !== sw.id ? priors[k] : undefined;
      let prior: PenTarget["prior"];
      if (old) { prior = { li: L.length, text: old.text, save: old.save, seq: old.seq }; L.push({ t: "pen", key: k }); }
      const li = L.length;
      L.push({ t: "pen", key: k });
      const evLi = L.length;
      const evidence = live ? evidenceLine(sw) : "";
      L.push({ t: "ev", key: k, text: evidence });
      // one hero bridge is hand-written (a taller line); every other twin gets a short printed one under its evidence
      const heroStr = live && hero?.key === k ? (hero.text ? clip(hero.text, 84) : heroText(sw, name)) : "";
      // only the hero bridge goes on the paper; the other notes ride the twin's tip, so the paper keeps B's two or three lines a merchant
      let bridgeLi: number | null = null; const alsoLi: number | null = null, also = heroStr || !live ? "" : alsoLine(sw);
      if (heroStr) { bridgeLi = L.length; L.push({ t: "bridge", key: k, text: heroStr }); }
      let text = "", save = "", color = RED, tip = "", seq = `${k}:${status}`;
      if (sw && (status === "proposed" || status === "accepted" || status === "replanning" || status === "rejected")) {
        text = twinText(sw, cur);
        save = twinSave(sw, cur);
        seq = `${k}:${sw.id}`;
        const ev = sw.to.evidence;
        const where = shortAddress(sw.to.entity.address);
        const facts = [ev?.affinity != null ? `${ev.affinity.toFixed(2)} affinity` : "", ev?.distanceKm != null ? `${ev.distanceKm.toFixed(1)} km` : ""].filter(Boolean).join(", ");
        if (status === "replanning") { color = GREY; seq = `${k}:${sw.id}:x`; tip = `${sw.to.entity.name} is out. Looking for another twin.`; }
        else if (status === "rejected") { color = GREY; text = "keep it"; save = ""; seq = `${k}:${sw.id}:keep`; tip = `${name} stays. Click to try the swap again.`; }
        else tip = clip(`${sw.to.entity.name}${where ? `, ${where}` : ""}${facts ? `: ${facts}` : ""}.${also ? ` ${also.charAt(0) + also.slice(1).toLowerCase()}.` : ""} Click to say no.`, 120);
      } else if (status === "kept") {
        // kept on purpose (no honest cheaper twin) reads "kept, <why>"; an open question reads as waiting
        const waiting = kept && keptKind(kept.reason) === "waiting";
        color = "#7a7368"; text = kept ? clip(waiting ? kept.reason.toLowerCase() : `kept, ${kept.reason.toLowerCase()}`, 44) : "kept"; tip = kept?.reason ?? `${name} stays.`; seq = `${k}:kept`;
      }
      else tip = running ? `Looking at ${name}.` : "";
      // polaroids as in B: the reader's own place and, once written, its twin; the twin may take the original's kind of photo (same taste, one tier down)
      const fromPhoto = fromPhotos.get(k) ?? null;
      const photo = live ? photoFor(sw, usedPhotos) ?? photoForPlace(m.category ?? "", [], name, usedPhotos) : null; // same taste one tier down: the original's kind when its own tags say nothing
      const fromWhere = shortAddress(r?.entity?.address) ?? "", where = live ? shortAddress(sw.to.entity.address) ?? "" : "";
      pens.push({
        li, rowLi, evLi, evidence, also, alsoLi, prior, key: k, name, swapId: sw?.id, swap: sw, status, text, save, strike: live, color, seq, tip, photo, where, fromPhoto, fromWhere,
        bridge: heroStr && bridgeLi != null ? { li: bridgeLi, text: heroStr, seq: `${seq}:b` } : undefined,
      });
    }
    if (tasteKeys.length > TASTE_ROWS) L.push({ t: "row", date: "", name: `${tasteKeys.length - TASTE_ROWS} MORE PLACES`, dim: true });
    if (skipped.length) L.push({ t: "kv", k: "SET ASIDE", v: clip(up(skipped.map((m) => data.resolutions[m.key]?.normalizedName ?? m.name).join(", ")), 42), small: true, dim: true });
    const fp = fingerprintLines(data.fingerprint ?? data.plan?.fingerprint);
    if (fp.length) L.push({ t: "dots" }, ...fp);
  }
  const tasteEnd = L.length;

  /* ---- next month: one total, no twin list (the twins are already written above) ---- */
  const tot = totals(data);
  let nextStart: number | null = null, savedLi: number | null = null, endLi: number | null = null;
  const list = countingSwaps(data.swaps);
  if (data.plan && list.length) {
    nextStart = L.length;
    L.push({ t: "dots" }, { t: "head", text: labels.nextMonth }, { t: "sub", text: `${tot.kept} SWAPS, SAME TASTE` }, { t: "dots" });
    L.push({ t: "kv", k: "SWAPS KEPT", v: `${tot.kept} OF ${tot.all}` }, { t: "kv", k: "WAS", v: money(tot.before, cur), dim: true, strike: true }, { t: "kv", k: labels.nextMonth, v: money(tot.after, cur) });
    // the measured proof in paper order (contract 1.6); the camera and the other receipt line up on its "a month" line
    const proof = proofLines("ours", data.plan.proof, data.baseline.proof, cur, data.baseline.proofRuns);
    if (proof.length) { savedLi = L.length + Math.max(0, proof.findIndex((l) => l.t === "total")); L.push(...proof); }
    else { savedLi = L.length; L.push({ t: "total", k: "SAVED", v: "−" + money(tot.saving, cur), color: RED }); }
    endLi = L.length;
    L.push({ t: "note", text: "SAME TASTE. LESS ON THE CARD.", align: "center" }, { t: "blank" }, { t: "barcode", seed: 41 }, { t: "blank" }, { t: "blank" }, { t: "blank" });
  }

  const asking = data.baseline.status === "running" && !data.baseline.suggestions.length;
  const theirs = asking ? theirsAsking(pens.length, data.plan?.proof, cur) : theirsLines(data.baseline.suggestions, data.baseline.proof, data.plan?.proof, cur, data.baseline.proofRuns);
  const theirsTotalLi = theirs.findIndex((l) => l.t === "total");
  let theirsEndLi: number | null = null; for (let i = theirs.length - 1; i >= 0; i--) if (!/^(blank|barcode)$/.test(theirs[i].t)) { theirsEndLi = i; break; }
  return { ours: L, statementEnd, totalLi, tasteStart, tasteEnd, nextStart, savedLi, endLi, theirsEndLi, pens, theirs, theirsReady: data.baseline.suggestions.length > 0, theirsAsking: asking, theirsTotalLi: theirsTotalLi < 0 ? null : theirsTotalLi, totals: tot, labels, statementTotal };
}

/** A kv row's label and value share one line of the paper (1024 px, 48 px pads, IBM Plex Mono 30 px ≈ 18 px a glyph); longer values print at the small size. */
const ROW_CHARS = 50;

/**
 * The measured proof (contract 1.6) as the paper prints it, straight from proofRows() so the scene and the
 * recorder agree, in proofRows' own order (cheaper, taste link, near you, a month, found on Qloo, where it said, kept).
 * Each side over its own picks; the model's side over every one of its runs (`theirsRuns`), so its values
 * are ranges ("2–4 of 9 picks", "−$213 to −$472"). With both sides in, the side a row argues against is
 * red and the row's note (a multiple, a tie) rides the value, only when proofRows() gives one. Each row is
 * one line, label and value on one baseline. Nothing without data.
 */
export function proofLines(side: "ours" | "theirs", ours: ProofSide | undefined, theirs: ProofSide | undefined, cur = "USD", theirsRuns?: ProofSide[]): Line[] {
  const mine = side === "ours" ? ours : theirs;
  if (!mine) return [];
  const both = !!(ours && theirs), other = side === "ours" ? "theirs" : "ours";
  const out: Line[] = [{ t: "dots" }];
  for (const r of proofRows(ours ?? mine, theirs ?? mine, theirsRuns)) {
    // the month's multiple is our claim, so it prints on our side only; a tie is both sides' note
    const note = both && r.note && (r.key !== "month" || side === "ours") ? `, ${up(r.note)}` : "";
    const color = both && r.favours === other ? RED : undefined;
    if (r.key === "month") out.push({ t: "total", k: up(r.label), v: (side === "ours" ? proofMonth(mine, cur) : up(r.theirs)) + note, color: side === "ours" ? RED : color });
    else if (r[side] === "-") continue; // nothing measured on this side (a model alone keeps no line on purpose): no row rather than a dash
    else { const k = up(r.label), v = up(r[side]) + note; out.push({ t: "kv", k, v, color, small: k.length + v.length + 2 > ROW_CHARS || undefined }); }
  }
  return out;
}
/** A monthly figure on the proof scale: a saving with a minus, a cost with a plus (one run; the model's range comes from proofRows). */
function proofMonth(p: ProofSide, cur: string): string {
  if (p.monthlySavings > 0) return "−" + money(p.monthlySavings, cur);
  if (p.monthlySavings < 0) return "+" + money(-p.monthlySavings, cur);
  return money(0, cur);
}

/** The second receipt: what a model alone suggested, checked against Qloo /search, measured the same way as ours when the proof is in. */
export function theirsLines(sug: BaselineSuggestion[], proof?: ProofSide, ours?: ProofSide, cur = "USD", runs?: ProofSide[]): Line[] {
  const n = sug.length;
  const L: Line[] = [{ t: "head", text: "A MODEL ALONE" }, { t: "sub", text: n ? `THE SAME ${n} MERCHANTS, NO QLOO` : "NOT RUN YET" }, { t: "dots" }];
  let exists = 0, cheaper = 0, pending = 0;
  for (const s of sug) {
    // contract 1.2: "pending_key" means nothing was checked (Qloo mocked), which is not a miss
    const wait = s.verification === "pending_key";
    const dead = !wait && !s.existsInQloo;
    if (wait) pending++;
    if (s.existsInQloo) exists++;
    if (s.cheaper) cheaper++;
    // the model-alone receipt prints its waiting rows and its suggestions in its own (darker) grey, `dim` on that Receipt, not the paper-wide GREY
    L.push({ t: "row", name: clip(up(s.fromName), 24), amt: wait ? "…" : dead ? "✕" : "?", color: dead ? RED : undefined, dim: wait || undefined });
    L.push({ t: "swap", name: clip(up(s.suggestedName), 26), amt: "", color: dead ? RED : undefined, dim: !dead || undefined });
    const verdict = wait
      ? "NOT CHECKED YET. NO QLOO KEY."
      : dead
        ? up(s.note ?? "not found. /search: 0 results.")
        : `EXISTS. ${s.cheaper === true ? "CHEAPER. " : s.cheaper === false ? "NOT CHEAPER. " : ""}${up(shortAddress(s.entity?.address) ?? "")}`;
    L.push({ t: "note", text: clip(verdict.trim(), 48), color: dead ? RED : undefined });
  }
  const checked = n - pending;
  if (n && proof) L.push(...proofLines("theirs", ours, proof, cur, runs));
  else if (n) L.push({ t: "dots" },
    { t: "kv", k: "EXISTS", v: checked ? `${exists} OF ${checked}` : "NOT CHECKED", color: checked ? undefined : RED },
    { t: "kv", k: "CHEAPER", v: checked ? `${cheaper} OF ${checked}` : "NOT CHECKED", color: !checked || cheaper < checked / 2 ? RED : undefined },
    { t: "total", k: "A MONTH", v: "NO PRICE" });
  if (n) L.push({ t: "blank" }, { t: "barcode", seed: 9 }, { t: "blank" }, { t: "blank" }, { t: "blank" });
  return L;
}

/**
 * The model-alone receipt while it is being asked for (v7, M2): its paper already lies in its place, the header printed and the rest
 * blank, laid out as the answer will most likely be (one row, swap and verdict per merchant of ours, the proof's rows as ours), so the
 * paper keeps its length and place when the answer comes and its rows print on it with the scroll.
 */
export function theirsAsking(n: number, ours?: ProofSide, cur = "USD"): Line[] {
  const L: Line[] = [{ t: "head", text: "A MODEL ALONE" }, { t: "sub", text: n ? `THE SAME ${n} MERCHANTS, NO QLOO` : "THE SAME MERCHANTS, NO QLOO" }, { t: "dots" }];
  for (let i = 0; i < n; i++) L.push({ t: "row" }, { t: "swap" }, { t: "note" });
  if (n && ours) L.push(...proofLines("theirs", ours, ours, cur).map((l): Line => ({ t: l.t }))); // the proof's rows as ours, their places only
  else if (n) L.push({ t: "dots" }, { t: "kv" }, { t: "kv" }, { t: "total" });
  if (n) L.push({ t: "blank" }, { t: "barcode", seed: 9 }, { t: "blank" }, { t: "blank" }, { t: "blank" });
  return L;
}

/**
 * Photo for a twin, only when a generic photo honestly matches what the twin is
 * (by category and Qloo tags), each photo at most once. Otherwise none: that
 * twin stays handwriting-only. The photos are generic, see CREDITS.md.
 */
const PHOTO_RULES: { test: (cat: string, tags: string, name: string) => boolean; photos: string[] }[] = [
  { test: (c, t, n) => c === "coffee" || /coffee|cafe|café|espresso/.test(t + " " + n), photos: ["latte", "coffee2"] },
  { test: (c, t) => c === "grocery" || /grocery|supermarket/.test(t), photos: ["grocery"] },
  { test: (c, t, n) => /steak/.test(t + " " + n), photos: ["steak", "steak2"] },
  { test: (c, t, n) => /italian|pasta|trattoria|gnocchi|osteria|\blilia\b|\bmisi\b/.test(t + " " + n), photos: ["pasta", "pasta2"] },
  { test: (c, t, n) => /salad|greens|health food|quinoa|sweetgreen/.test(t + " " + n), photos: ["salad", "quinoa"] },
  { test: (c, t, n) => /peruvian|ceviche|llama inn/.test(t + " " + n), photos: ["ceviche"] },
  { test: (c, t, n) => c === "bar" || /wine bar|natural wine|cocktail bar|cocktails/.test(t + " " + n), photos: ["wine", "cocktail"] },
  { test: (c, t) => /cinema|movie theater|film/.test(t), photos: ["nitehawk"] },
  { test: (c, t) => /music venue|live music|concert|nightclub|club/.test(t), photos: ["elsewhere", "turnstile"] },
];
/** A photo for a place by its category, tags and name (the name rules name what the reader's own places serve: pasta at Lilia, ceviche at Llama Inn, salad at Sweetgreen). */
export function photoForPlace(category: string, tagNames: string[], name: string, used: Set<string>): string | null {
  const tags = tagNames.map((t) => t.toLowerCase()).join(" "), n = name.toLowerCase();
  for (const rule of PHOTO_RULES) {
    if (!rule.test(category, tags, n)) continue;
    const free = rule.photos.find((p) => !used.has(p));
    if (free) { used.add(free); return free; }
    return null;
  }
  return null;
}
export function photoFor(sw: Swap, used: Set<string>): string | null {
  return photoForPlace(sw.category, (sw.to.evidence?.tags ?? []).map((t) => t.name), sw.to.entity.name, used);
}

/**
 * The proof's one sentence, the same on `/demo` and `/` (PM, scene-9: the receipts carry the numbers, the sentence is one short line; v5: `/`
 * had kept the old three-line one). The lead is distance, which holds across the model's runs (PM, scene-10): the near-you row; found on Qloo,
 * then cheaper, only when it is missing (the mock recording). The counts lose " picks" and the median km.
 */
export function proofSentence(ours: ProofSide, theirs: ProofSide, runs?: ProofSide[]): { ours: string; what: string; theirs: string } {
  const r = Object.fromEntries(proofRows(ours, theirs, runs).map((x) => [x.key, x]));
  const counted = (x: (typeof r)[string] | undefined) => !!x && /^\d/.test(x.ours) && /^\d/.test(x.theirs);
  const [row, what] = counted(r.near) ? [r.near, "near you"] : counted(r.exists) ? [r.exists, "found on Qloo"] : [r.cheaper, "cheaper, same taste"];
  const nb = (t: string | undefined) => (t ?? "").replace(/ picks?(,|$)/, "$1").replace(/, median .*$/, "");
  return { ours: nb(row?.ours), what, theirs: nb(row?.theirs) };
}
