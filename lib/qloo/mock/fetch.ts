/**
 * A `fetch` replacement that serves doc-shaped synthetic responses for
 * /search, /v2/insights and /v2/tags from the mock world. The real client
 * code path (URL building, headers, parsing) runs unchanged in mock mode.
 */
import { haversineM, parsePoint } from "../geo";
import { mockEntityById, mockWorld, allMockTags, HOODS, type MockEntity } from "./world";
import { rand01 } from "./world";

const NYC = { lat: 40.7308, lon: -73.9973 };

function list(v: string | null): string[] {
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/['’]s\b/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return norm(s)
    .split(" ")
    .filter((t) => t && !["the", "and", "nyc", "new", "york", "co", "inc"].includes(t));
}

/** Name-match score 0..1 used by mock /search. */
export function matchScore(query: string, e: MockEntity): number {
  const q = tokens(query);
  if (!q.length) return 0;
  let best = 0;
  for (const cand of [e.name, ...e.aliases]) {
    const c = tokens(cand);
    if (!c.length) continue;
    const nq = norm(query);
    const nc = norm(cand);
    if (nq === nc) return 1;
    const hit = q.filter((t) => c.some((x) => x === t || (t.length >= 4 && x.startsWith(t)) || (x.length >= 4 && t.startsWith(x)))).length;
    const s = hit / Math.max(q.length, c.length);
    best = Math.max(best, nc.includes(nq) || nq.includes(nc) ? Math.max(s, 0.75) : s);
  }
  return best;
}

function entityJson(e: MockEntity, extra?: { affinity?: number; distance?: number }) {
  return {
    name: e.name,
    entity_id: e.id,
    type: "urn:entity",
    subtype: `urn:entity:${e.type}`,
    disambiguation: "synthetic mock entity",
    popularity: e.popularity,
    ...(e.type === "place"
      ? {
          location: { lat: e.lat, lon: e.lon },
          properties: {
            address: e.address,
            ...(e.priceLevel ? { price_level: e.priceLevel } : {}),
            business_rating: e.businessRating,
            geocode: { name: "New York", admin1_region: "NY", admin2_region: e.hood, country_code: "US" },
          },
        }
      : { properties: {} }),
    tags: e.tags.map((t) => {
      const parts = t.split(":");
      return { id: t, name: parts[parts.length - 1].replace(/_/g, " "), type: parts.slice(0, -1).join(":") };
    }),
    ...(extra ? { query: { affinity: extra.affinity, ...(extra.distance !== undefined ? { distance: extra.distance } : {}) } } : {}),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function typeOf(urn: string): string {
  const t = urn.replace(/^urn:entity:/, "");
  return t === "videogame" ? "video_game" : t;
}

function locate(sp: URLSearchParams, key: string): { lat: number; lon: number } | null {
  const v = sp.get(key);
  if (!v) return null;
  return parsePoint(v);
}

function search(sp: URLSearchParams): Response {
  const query = sp.get("query") ?? "";
  const types = list(sp.get("types")).map(typeOf);
  const loc = locate(sp, "filter.location");
  const radiusM = Number(sp.get("filter.radius") ?? 10) * 1609.34;
  const take = Number(sp.get("take") ?? 20);
  const page = Number(sp.get("page") ?? 1);
  const scored = mockWorld()
    .filter((e) => !types.length || types.includes(e.type))
    .filter((e) => !e.standIn || norm(e.name) === norm(query))
    .map((e) => ({ e, s: matchScore(query, e), d: loc ? haversineM(loc.lat, loc.lon, e.lat, e.lon) : undefined }))
    .filter((x) => x.s >= 0.3 && (x.d === undefined || x.d <= radiusM));
  const sortBy = sp.get("sort_by") ?? "match";
  scored.sort((a, b) =>
    sortBy === "distance" && a.d !== undefined && b.d !== undefined
      ? a.d - b.d
      : sortBy === "popularity"
        ? b.e.popularity - a.e.popularity
        : b.s - a.s || (a.d ?? 0) - (b.d ?? 0),
  );
  const results = scored.slice((page - 1) * take, page * take).map((x) => entityJson(x.e));
  return json({ success: true, duration: 0.01, results });
}

function hoodPoint(q: string | null): { lat: number; lon: number } | null {
  if (!q) return null;
  const h = HOODS.find((x) => norm(x.name) === norm(q));
  if (h) return h;
  if (/new york|nyc|manhattan|brooklyn|queens/i.test(q)) return NYC;
  return null;
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter || 1);
}

function insights(sp: URLSearchParams): Response {
  const typeUrn = sp.get("filter.type");
  if (!typeUrn) {
    return json({ success: false, error: { message: "filter.type is required" } }, 400);
  }
  const type = typeOf(typeUrn);
  const signals = list(sp.get("signal.interests.entities")).map(mockEntityById).filter((e): e is MockEntity => !!e);
  const loc = locate(sp, "filter.location") ?? hoodPoint(sp.get("filter.location.query"));
  const hasLocFilter = sp.has("filter.location") || sp.has("filter.location.query");
  const radius = Number(sp.get("filter.location.radius") ?? 15_000);
  const pmin = Number(sp.get("filter.price_level.min") ?? 1);
  const pmax = Number(sp.get("filter.price_level.max") ?? 4);
  const rmin = Number(sp.get("filter.properties.business_rating.min") ?? 0);
  const exclude = new Set(list(sp.get("filter.exclude.entities")));
  const only = new Set(list(sp.get("filter.results.entities")));
  const tags = list(sp.get("filter.tags"));
  const tagsAll = sp.get("operator.filter.tags") === "intersection";
  const take = Number(sp.get("take") ?? 20);
  const page = Number(sp.get("page") ?? 1);
  const offset = Number(sp.get("offset") ?? (page - 1) * take);
  const signalIds = new Set(signals.map((s) => s.id));
  const signalNames = new Set(signals.map((s) => s.name));

  const rows = mockWorld()
    .filter((e) => e.type === type && !exclude.has(e.id) && !signalIds.has(e.id) && !signalNames.has(e.name))
    .filter((e) => (only.size ? only.has(e.id) : !e.standIn))
    .filter((e) => (e.priceLevel ? e.priceLevel >= pmin && e.priceLevel <= pmax : !sp.has("filter.price_level.max")))
    .filter((e) => e.businessRating >= rmin)
    .filter((e) => !tags.length || (tagsAll ? tags.every((t) => e.tags.includes(t)) : tags.some((t) => e.tags.includes(t))))
    .map((e) => {
      const d = loc && e.type === "place" ? haversineM(loc.lat, loc.lon, e.lat, e.lon) : undefined;
      let affinity: number;
      if (signals.length) {
        const styleOnly = (t: string[]) => t.filter((x) => x.startsWith("urn:tag:style:"));
        const sim =
          e.type === "place"
            ? Math.max(...signals.map((s) => jaccard(s.tags, e.tags) + (s.category === e.category ? 0.25 : 0)))
            : Math.max(...signals.map((s) => jaccard(styleOnly(s.tags), styleOnly(e.tags)) * 1.4));
        affinity = Math.min(0.99, 0.35 + sim * 0.6 + rand01(`aff:${e.id}:${[...signalIds].join()}`) * 0.08);
      } else {
        affinity = e.popularity;
      }
      return { e, d, affinity: +affinity.toFixed(3) };
    })
    .filter((x) => x.d === undefined || x.d <= radius);
  rows.sort((a, b) => b.affinity - a.affinity);
  const entities = rows
    .slice(offset, offset + take)
    .map((x) => entityJson(x.e, { affinity: x.affinity, distance: hasLocFilter && x.d !== undefined ? Math.round(x.d) : undefined }));
  return json({ success: true, results: { entities, duration: 0.02 } });
}

function tagsRoute(sp: URLSearchParams): Response {
  const q = norm(sp.get("filter.query") ?? "");
  const take = Number(sp.get("take") ?? 20);
  const tags = allMockTags().filter((t) => !q || norm(t.name).includes(q) || t.id.includes(q.replace(/ /g, "_")));
  return json({ success: true, results: { tags: tags.slice(0, take) } });
}

/** Mock fetch. Latency is simulated only if `delayMs` > 0. */
export function createMockFetch(opts: { delayMs?: number } = {}): typeof fetch {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const path = url.pathname.replace(/\/+$/, "");
    if (path === "/search") return search(url.searchParams);
    if (path === "/v2/insights") return insights(url.searchParams);
    if (path === "/v2/tags") return tagsRoute(url.searchParams);
    return json({ success: false, error: { message: "not found" } }, 404);
  };
}
