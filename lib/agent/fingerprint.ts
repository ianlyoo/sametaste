/**
 * Cross-domain taste fingerprint: what the user's places predict in music,
 * film and brands. One /v2/insights call per domain, signals = the places.
 */
import type { CrossDomainAffinity, CrossDomainType, QlooTag, TasteFingerprint } from "../contract";
import type { QlooClient } from "../qloo/client";
import type { QlooEntity } from "../qloo/types";
import { toRef } from "./resolve";
import { isTasteTag, rankTasteTags } from "./taste-tags";

export const DEFAULT_DOMAINS: CrossDomainType[] = ["artist", "movie", "brand"];

export async function buildFingerprint(
  qloo: QlooClient,
  sources: QlooEntity[],
  opts: { domains?: CrossDomainType[]; take?: number } = {},
): Promise<TasteFingerprint> {
  const domains = opts.domains ?? DEFAULT_DOMAINS;
  const ids = sources.map((s) => s.id);
  const affinities: CrossDomainAffinity[] = [];
  for (const domain of domains) {
    const res = await qloo.insights(domain, { "signal.interests.entities": ids, take: opts.take ?? 4 });
    for (const e of res) affinities.push({ domain, entity: toRef(e), affinity: e.affinity });
  }
  // kept so the paper's PLACES line can be recomputed from the recording (eval/reproof.ts)
  const tasteSources = sources.map((s) => ({ entityId: s.id, name: s.name, tasteTags: s.tags.filter(isTasteTag).map((t) => ({ id: t.id, name: t.name, type: t.type })) }));
  const topTags = topStyleTags(tasteSources.map((s) => ({ tags: s.tasteTags })), 5);
  return {
    sourceEntityIds: ids,
    sourceNames: sources.map((s) => s.name),
    affinities,
    topTags,
    sources: tasteSources,
    headline: headline(topTags, affinities),
  };
}

/** The places' taste tags (lib/agent/taste-tags.ts): most shared first, within the best kind first (cuisine before vibe). */
export function topStyleTags(sources: { tags: QlooTag[] }[], n: number): QlooTag[] {
  const count = new Map<string, { tag: QlooTag; n: number }>();
  for (const s of sources) {
    for (const t of s.tags) {
      const cur = count.get(t.id) ?? { tag: { id: t.id, name: t.name, type: t.type }, n: 0 };
      cur.n++;
      count.set(t.id, cur);
    }
  }
  const byCount = [...count.values()].sort((a, b) => b.n - a.n).map((x) => x.tag);
  return rankTasteTags(byCount).slice(0, n);
}

export function headline(tags: QlooTag[], aff: CrossDomainAffinity[]): string {
  const parts = tags.slice(0, 3).map((t) => t.name.toLowerCase());
  const artist = aff.find((a) => a.domain === "artist");
  const movie = aff.find((a) => a.domain === "movie");
  // a phrase list: a name with its own comma ("Don't Worry, He Won't Get Far on Foot") would split mid-title
  const whole = (a: CrossDomainAffinity | undefined) => (a && !a.entity.name.includes(",") ? a : undefined);
  const art = whole(artist), mov = whole(movie);
  const extra = [art && `${art.entity.name} on repeat`, mov && `${mov.entity.name} on the watchlist`].filter(Boolean);
  return [parts.join(", "), ...extra].filter(Boolean).join(", ") || "Your taste, read from your statement";
}

/** Top cross-domain entities to add as extra signals for swap search. */
export function fingerprintSignals(fp: TasteFingerprint | undefined, n = 2): CrossDomainAffinity[] {
  if (!fp) return [];
  const best: CrossDomainAffinity[] = [];
  for (const d of ["artist", "movie", "brand", "tv_show", "book", "podcast"] as const) {
    const a = fp.affinities.find((x) => x.domain === d);
    if (a) best.push(a);
    if (best.length >= n) break;
  }
  return best;
}
