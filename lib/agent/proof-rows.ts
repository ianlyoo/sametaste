/**
 * The measured proof as rows (contract 1.6), in the order the paper prints
 * them: cheaper, taste link, near you, a month, found on Qloo, where it said,
 * kept. Each side is read over its own picks, and a line we kept on purpose
 * is its own count, not a miss. With several model-alone runs its side
 * prints the range (min to max). Pure (contract types only), so the scene and
 * the recorder print the same rows. A row that favours the model says so.
 */
import type { ProofSide } from "../contract";

/** Why a taste line has no swap (Plan.unswapped[].reason), as written by finalizePlan. */
export const KEPT_REASON = {
  waiting: "Waiting for your answer",
  ambiguous: "Several matches in Qloo",
  notFound: "Not found in Qloo",
  unchecked: "Not analysed in this run",
  cheapest: "Already the cheapest price tier",
  noPrice: "Qloo has no price level for it",
  noTwin: "Nothing one price level down shares its taste nearby",
} as const;

/** "kept": settled without a pick (no honest cheaper twin); "waiting": a question is open; "unchecked": a gap. */
export function keptKind(reason: string): "kept" | "waiting" | "unchecked" {
  if (reason === KEPT_REASON.waiting || reason === KEPT_REASON.ambiguous) return "waiting";
  if (reason === KEPT_REASON.unchecked) return "unchecked";
  return "kept";
}

export function keptCounts(unswapped: { reason: string }[]): { kept: number; waiting: number } {
  const kinds = unswapped.map((u) => keptKind(u.reason));
  return { kept: kinds.filter((k) => k === "kept").length, waiting: kinds.filter((k) => k === "waiting").length };
}

/** Taste links this close are a tie (Qloo affinity, 0..1). */
export const TASTE_TIE = 0.05;

/** A pick this close to the user (km) is near; the walk our own twins are searched within, and then some. */
export const NEAR_KM = 1.5;

/** A month's ratio below this is not a multiple worth printing. */
export const MONTH_RATIO_MIN = 1.5;

export interface ProofRow {
  key: "cheaper" | "taste" | "near" | "month" | "exists" | "where" | "kept";
  label: string;
  ours: string;
  theirs: string;
  /** Which side the row argues for; undefined when it can't be compared (or the model's runs disagree). */
  favours?: "ours" | "theirs" | "tie";
  /** e.g. "2.1x", "a tie". */
  note?: string;
}

const money = (n: number) => `${n < 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`;
const dollars = (n: number) => `${n < 0 ? "+" : "−"}$${Math.abs(Math.round(n))}`;
const picksOf = (picks: number) => `pick${picks === 1 ? "" : "s"}`;
const compare = (a: number | undefined, b: number | undefined, tie = 0): ProofRow["favours"] =>
  a === undefined || b === undefined ? undefined : Math.abs(a - b) <= tie ? "tie" : a > b ? "ours" : "theirs";
const rate = (n: number | undefined, d: number) => (n === undefined || !d ? undefined : n / d);
/** "4" or "2–4" over the runs. */
const span = (xs: number[], fmt: (n: number) => string = String) => {
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
};
const defined = <T>(xs: (T | undefined)[]) => (xs.some((x) => x === undefined) ? undefined : (xs as T[]));
/** The same verdict on every run, else no verdict. */
const agree = (fs: ProofRow["favours"][]) => (fs.every((f) => f === fs[0]) ? fs[0] : undefined);

/**
 * `theirsRuns`: every model-alone run (`baseline_ready.proofRuns`), whose
 * spread the model's side prints; `theirs` alone when absent.
 */
export function proofRows(ours: ProofSide, theirs: ProofSide, theirsRuns?: ProofSide[]): ProofRow[] {
  const runs = theirsRuns && theirsRuns.length > 1 ? theirsRuns : [theirs];
  /** "n of m picks" for one side, a range over the model's runs. */
  const count = (sides: ProofSide[], n: (p: ProofSide) => number | undefined, missing: string) => {
    const ns = defined(sides.map(n));
    return ns ? `${span(ns)} of ${span(sides.map((p) => p.picks))} ${picksOf(Math.max(...sides.map((p) => p.picks)))}` : missing;
  };
  const near = (sides: ProofSide[]) => {
    const head = count(sides, (p) => p.near, "not measured");
    const med = defined(sides.map((p) => p.medianDistanceKm));
    return med ? `${head}, median ${span(med, (k) => k.toFixed(1))} km` : head;
  };
  const where = (sides: ProofSide[]) => {
    const head = count(sides, (p) => p.whereSaid, "not checked");
    const unchecked = sides.map((p) => (p.whereChecked === undefined ? 0 : p.picks - p.whereChecked));
    return head !== "not checked" && Math.max(...unchecked) > 0 ? `${head}, ${span(unchecked)} not checked` : head;
  };
  const cheaper = (sides: ProofSide[]) => {
    const priced = sides.map((p) => (p.priced !== undefined && p.priced < p.picks ? p.priced : undefined));
    const short = priced.filter((x): x is number => x !== undefined);
    return count(sides, (p) => p.cheaper, "") + (short.length ? `, ${span(short)} priced` : "");
  };
  const month = (sides: ProofSide[]) => {
    const xs = sides.map((p) => p.monthlySavings);
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    return lo === hi ? money(lo) : `${dollars(lo)} to ${dollars(hi)}`;
  };
  const taste = (sides: ProofSide[]) => {
    const ls = defined(sides.map((p) => p.tasteLink));
    return ls ? `${span(ls, (x) => x.toFixed(2))} (n=${span(sides.map((p) => p.tasteScored))})` : "not scored";
  };
  const kept = (p: ProofSide) =>
    p.kept === undefined
      ? "-"
      : [p.kept ? `${p.kept} line${p.kept === 1 ? "" : "s"}, no cheaper twin` : "", p.waiting ? `${p.waiting} waiting for you` : ""].filter(Boolean).join("; ") || "none";
  // the month's multiple, only when every run shows one of at least MONTH_RATIO_MIN the same way
  const ratios = runs.map((t) => (ours.monthlySavings > 0 && t.monthlySavings > 0 ? Math.max(ours.monthlySavings, t.monthlySavings) / Math.min(ours.monthlySavings, t.monthlySavings) : 0));
  const monthFavours = agree(runs.map((t) => compare(ours.monthlySavings, t.monthlySavings)));
  const monthNote = monthFavours && monthFavours !== "tie" && Math.min(...ratios) >= MONTH_RATIO_MIN ? `${Math.min(...ratios).toFixed(1)}x${runs.length > 1 ? " or more" : ""}` : undefined;
  const tasteFavours = agree(runs.map((t) => compare(ours.tasteLink, t.tasteLink, TASTE_TIE)));
  const byRate = (n: (p: ProofSide) => number | undefined) => agree(runs.map((t) => compare(rate(n(ours), ours.picks), rate(n(t), t.picks))));
  return [
    { key: "cheaper", label: "cheaper", ours: cheaper([ours]), theirs: cheaper(runs), favours: byRate((p) => p.cheaper) },
    { key: "taste", label: "taste link", ours: taste([ours]), theirs: taste(runs), favours: tasteFavours, note: tasteFavours === "tie" ? "a tie" : undefined },
    { key: "near", label: "near you", ours: near([ours]), theirs: near(runs), favours: byRate((p) => p.near) },
    { key: "month", label: "a month", ours: month([ours]), theirs: month(runs), favours: monthFavours, note: monthNote },
    { key: "exists", label: "found on Qloo", ours: count([ours], (p) => p.exists, "not checked"), theirs: count(runs, (p) => p.exists, "not checked"), favours: byRate((p) => p.exists) },
    // ours are Qloo places found around the user; only the model names a neighbourhood
    { key: "where", label: "where it said", ours: "checked on Qloo", theirs: where(runs) },
    { key: "kept", label: "kept", ours: kept(ours), theirs: kept(theirs) },
  ];
}
