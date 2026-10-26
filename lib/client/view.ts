/**
 * Small, pure readings of the flow state for the surfaces around the scene.
 * Money is never computed here: totals come from the scene's `deriveReceipt`
 * (one shared total).
 */
import type { BaselineSuggestion, CrossDomainType, Swap } from "../contract";
import { qlooCalls, type FlowState, type RunState } from "./flow";
import { PERSONA_PRESETS } from "./personas";
import type { ParsedStatement } from "./statement";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "October", or "Sep 14 – Oct 12" when the statement spans two months. */
export function statementPeriod(st?: ParsedStatement): string | undefined {
  if (!st) return undefined;
  const [fy, fm, fd] = st.range.from.split("-").map(Number);
  const [ty, tm, td] = st.range.to.split("-").map(Number);
  if (fy === ty && fm === tm) return MONTHS[fm - 1];
  const short = (m: number, d: number) => `${MONTHS[m - 1].slice(0, 3)} ${d}`;
  return `${short(fm, fd)} – ${short(tm, td)}`;
}

/** The month after the statement, for the plan ("November"). */
export function nextMonth(st?: ParsedStatement): string {
  if (!st) return "Next month";
  const m = Number(st.range.to.split("-")[1]);
  return MONTHS[m % 12];
}

/** "Maya, Williamsburg" for a sample persona; the place for an upload. */
export function whoLabel(s: Pick<FlowState, "personaId" | "location" | "statement">): string | undefined {
  const p = PERSONA_PRESETS.find((x) => x.id === s.personaId);
  if (p) return `${p.name}, ${p.place}`;
  if (s.location) return s.location.label.split(",")[0].trim();
  return s.statement ? "Your statement" : undefined;
}

export function personaName(personaId?: string): string | undefined {
  return PERSONA_PRESETS.find((x) => x.id === personaId)?.name;
}

/** One printer line for a running agent: its status, else the last tool step. */
export function printerLine(run: RunState): { text: string; qloo: number } {
  const step = [...run.steps].reverse().find((x) => x.summary);
  const text = run.statusMessage ?? step?.summary ?? (run.status === "running" ? "Reading" : "");
  return { text, qloo: qlooCalls(run) };
}

/** Swaps the user can still see written in (not rejected), in receipt order. */
export function liveSwaps(swaps: Swap[]): Swap[] {
  return swaps.filter((x) => x.status !== "rejected");
}

/** Resolved merchants count as taste signals. */
export function resolvedCount(s: Pick<FlowState, "resolutions">): number {
  return Object.values(s.resolutions).filter((r) => r.status === "resolved" && r.entity).length;
}

export const DOMAIN_LABEL: Record<CrossDomainType, string> = {
  artist: "Music",
  movie: "Film",
  tv_show: "TV",
  book: "Books",
  podcast: "Podcasts",
  brand: "Brands",
};

/** Affinities grouped by domain, top `per` names each, in first-seen order. */
export function affinityRows(s: Pick<FlowState, "fingerprint">, per = 2): { domain: string; names: string[] }[] {
  const out = new Map<CrossDomainType, string[]>();
  for (const a of s.fingerprint?.affinities ?? []) {
    const list = out.get(a.domain) ?? [];
    if (list.length < per && !list.includes(a.entity.name)) list.push(a.entity.name);
    out.set(a.domain, list);
  }
  return [...out].map(([d, names]) => ({ domain: DOMAIN_LABEL[d], names }));
}

/** How the model-alone picks fared: invented/closed, or not cheaper. Unchecked ("pending_key") picks don't count. */
export function baselineScore(all: BaselineSuggestion[]): { total: number; missing: number; notCheaper: number; wrong: number } {
  const list = all.filter((x) => x.verification !== "pending_key");
  const missing = list.filter((x) => !x.existsInQloo).length;
  const notCheaper = list.filter((x) => x.existsInQloo && x.cheaper === false).length;
  return { total: list.length, missing, notCheaper, wrong: missing + notCheaper };
}

const tier = (n?: number) => (n ? "$".repeat(n) : undefined);

/** Qloo's case for a twin, in one printed line: "Qloo 0.82, italian, 0.5 km, $$$ to $". */
export function evidenceLine(sw: Swap): string {
  const e = sw.to.evidence;
  const shared = new Set(e.sharedTagIds ?? []);
  const tags = e.tags.filter((t) => shared.has(t.id)).slice(0, 2).map((t) => t.name);
  const parts = [
    e.affinity != null ? `Qloo ${e.affinity.toFixed(2).replace(/^0/, "")}` : "Qloo",
    ...tags,
    e.distanceKm != null ? `${e.distanceKm < 1 ? e.distanceKm.toFixed(1) : Math.round(e.distanceKm)} km` : undefined,
    tier(e.fromPriceLevel) && tier(e.priceLevel) ? `${tier(e.fromPriceLevel)} to ${tier(e.priceLevel)}` : undefined,
  ];
  return parts.filter(Boolean).join(", ");
}

/**
 * The state as the paper prints it: statement lines the agent announced as one
 * place (contract 1.3 `run_started.merges`) are one merchant from the first
 * event, its visits and spend summed, so no row changes mid-run. The request
 * payloads keep the browser's own merchants.
 */
export function foldMerges(s: FlowState): FlowState {
  const merges = s.run.merges;
  if (!merges?.length) return s;
  const into = new Map<string, string>();
  const keys = new Set(s.merchants.map((m) => m.key));
  for (const m of merges) if (keys.has(m.merchantKey)) for (const k of m.mergedKeys) if (k !== m.merchantKey) into.set(k, m.merchantKey);
  if (!s.merchants.some((m) => into.has(m.key))) return s;
  const merchants = s.merchants
    .filter((m) => !into.has(m.key))
    .map((m) => {
      const parts = s.merchants.filter((x) => into.get(x.key) === m.key);
      if (!parts.length) return m;
      return {
        ...m,
        count: m.count + parts.reduce((a, x) => a + x.count, 0),
        totalSpend: Math.round((m.totalSpend + parts.reduce((a, x) => a + x.totalSpend, 0)) * 100) / 100,
      };
    });
  return { ...s, merchants };
}

/**
 * An address as people write it: no "(synthetic)" or other parentheticals,
 * street and neighbourhood only. "220 W 4th St (synthetic), West Village,
 * New York, NY" -> "220 W 4th St, West Village".
 */
export function cleanAddress(address?: string): string | undefined {
  if (!address) return undefined;
  const parts = address
    .replace(/\s*\([^)]*\)/g, "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.slice(0, 2).join(", ") || undefined;
}

/**
 * The twin's own monthly price: its ticket at your visits a month. The paper
 * prints this beside the twin, and the text alternative prints the same.
 */
export function twinMonthly(sw: Swap): number {
  return Math.round(sw.savings.visitsPerMonth * sw.savings.ticketAfter * 100) / 100;
}

/** The swap's bridge (contract 1.2 `crossDomainNote`), else "Lilia fans also love X" from its strongest cross-domain affinity. */
export function bridgeLine(sw: Swap): string | undefined {
  const note = sw.crossDomainNote?.trim();
  if (note) return note;
  // same fallback as the paper: the strongest cross-domain affinity
  const x = [...(sw.to.evidence.crossDomain ?? [])].sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0))[0];
  return x ? `${sw.from.name} fans also love ${x.entity.name}` : undefined;
}
