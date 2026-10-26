import { describe, expect, it, vi } from "vitest";
import {
  buildPlaceParams,
  CallBudget,
  MemoryCache,
  QlooBudgetError,
  QlooClient,
  QlooHttpError,
  QlooParamError,
  qlooConfigFromEnv,
  toQueryString,
  validateInsightsParams,
  validateSearchParams,
  wktPoint,
} from "./index";
import { createMockFetch } from "./mock/fetch";
import { mockWorld } from "./mock/world";

const mockClient = (opts: ConstructorParameters<typeof QlooClient>[0] = {}) =>
  new QlooClient({ mock: true, cache: new MemoryCache(), ...opts });

describe("param whitelist", () => {
  it("accepts place price and location filters", () => {
    expect(() =>
      validateInsightsParams("place", {
        "filter.type": "urn:entity:place",
        "signal.interests.entities": ["A"],
        "filter.location": wktPoint(40.7, -73.9),
        "filter.location.radius": 2000,
        "filter.price_level.max": 2,
        take: 10,
      }),
    ).not.toThrow();
  });

  it("rejects params Qloo would silently ignore for the type", () => {
    expect(() =>
      validateInsightsParams("brand", { "filter.type": "urn:entity:brand", "filter.price_level.max": 2 }),
    ).toThrow(QlooParamError);
    expect(() =>
      validateInsightsParams("movie", { "filter.type": "urn:entity:movie", "filter.location": "40,-73" }),
    ).toThrow(/not supported for movie/);
  });

  it("checks ranges and cross-field rules", () => {
    const base = { "filter.type": "urn:entity:place" };
    expect(() => validateInsightsParams("place", { ...base, "filter.price_level.max": 5 })).toThrow(/<= 4/);
    expect(() => validateInsightsParams("place", { ...base, take: 51 })).toThrow(/take/);
    expect(() =>
      validateInsightsParams("place", { ...base, "filter.price_level.min": 3, "filter.price_level.max": 2 }),
    ).toThrow(/min must be <=/);
    expect(() => validateInsightsParams("place", { ...base, "filter.location.radius": 100 })).toThrow(
      /needs filter.location/,
    );
    expect(() => validateInsightsParams("destination", { "filter.type": "urn:entity:destination" })).toThrow(
      /required/,
    );
  });

  it("validates search params", () => {
    expect(() => validateSearchParams({ query: "x", "filter.radius": 101 })).toThrow();
    expect(() => validateSearchParams({ query: "x", "filter.location.radius": 1 })).toThrow(/not a \/search/);
    expect(() => validateSearchParams({ take: 5 })).toThrow(/required/);
  });

  it("encodes arrays as comma lists, sorted, skipping undefined", () => {
    expect(toQueryString({ b: [1, 2], a: "x y", c: undefined })).toBe("a=x+y&b=1%2C2");
  });

  it("writes WKT with longitude first", () => {
    expect(wktPoint(40.71, -74.0)).toBe("POINT(-74 40.71)");
  });

  it("builds place params from typed input", () => {
    const p = buildPlaceParams({ signalEntityIds: ["E1"], lat: 40.7, lon: -73.9, radiusM: 1500, priceLevelMax: 2 });
    expect(p["filter.location"]).toBe("POINT(-73.9 40.7)");
    expect(p["filter.location.radius"]).toBe(1500);
    expect(p["filter.location.query"]).toBeUndefined();
    expect(() => validateInsightsParams("place", { ...p, "filter.type": "urn:entity:place" })).not.toThrow();
  });
});

describe("config", () => {
  it("defaults to the hackathon base URL and mock without a key in dev", () => {
    const c = qlooConfigFromEnv({ NODE_ENV: "development" });
    expect(c.baseUrl).toBe("https://hackathon.api.qloo.com");
    expect(c.mock).toBe(true);
  });
  it("fails closed in production without a key", () => {
    expect(qlooConfigFromEnv({ NODE_ENV: "production" }).mock).toBe(false);
    expect(qlooConfigFromEnv({ NODE_ENV: "production", QLOO_MOCK: "1" }).mock).toBe(true);
  });
});

describe("client over HTTP", () => {
  it("sends X-Api-Key and the right URL, parses insights", async () => {
    const fetchSpy = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          success: true,
          results: {
            entities: [
              {
                name: "il Buco",
                entity_id: "E-1",
                type: "urn:entity",
                subtype: "urn:entity:place",
                properties: { price_level: 2, address: "47 Bond St" },
                query: { affinity: 0.97, distance: 1817.0 },
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const c = new QlooClient({ mock: false, apiKey: "test-key", baseUrl: "https://q.example", fetch: fetchSpy as typeof fetch, cache: false });
    const out = await c.placeInsights({ signalEntityIds: ["S"], lat: 40.7, lon: -74, radiusM: 2000, priceLevelMax: 2 });
    expect(out[0]).toMatchObject({ id: "E-1", name: "il Buco", priceLevel: 2, affinity: 0.97, distanceM: 1817, type: "place" });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toMatch(/^https:\/\/q\.example\/v2\/insights\?/);
    expect(String(url)).toContain("filter.type=urn%3Aentity%3Aplace");
    expect((init!.headers as Record<string, string>)["X-Api-Key"]).toBe("test-key");
  });

  it("does not leak the key in errors and retries 5xx once", async () => {
    const fetchSpy = vi.fn(async () => new Response("boom", { status: 503 }));
    const c = new QlooClient({ mock: false, apiKey: "super-secret", baseUrl: "https://q.example", fetch: fetchSpy as typeof fetch, cache: false, retries: 1 });
    const err = await c.search({ query: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(QlooHttpError);
    expect(String(err.message)).not.toContain("super-secret");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("refuses live calls without a key", async () => {
    const c = new QlooClient({ mock: false, apiKey: undefined, fetch: vi.fn() as unknown as typeof fetch, cache: false });
    // apiKey may come from env in a dev shell; force none
    (c as unknown as { apiKey?: string }).apiKey = undefined;
    await expect(c.search({ query: "x" })).rejects.toThrow(/not configured/);
  });
});

describe("cache and budget", () => {
  it("caches identical requests and does not charge the budget for hits", async () => {
    const budget = new CallBudget(2);
    const c = mockClient({ budget });
    await c.search({ query: "Blue Bottle Coffee", types: ["place"] });
    await c.search({ query: "Blue Bottle Coffee", types: ["place"] });
    expect(budget.used).toBe(1);
    await c.search({ query: "Carbone", types: ["place"] });
    await expect(c.search({ query: "Lilia", types: ["place"] })).rejects.toBeInstanceOf(QlooBudgetError);
  });

  it("evicts the oldest entry beyond maxEntries", async () => {
    const m = new MemoryCache({ maxEntries: 2 });
    await m.set("a", 1);
    await m.set("b", 2);
    await m.get("a");
    await m.set("c", 3);
    expect(await m.get("b")).toBeUndefined();
    expect(await m.get("a")).toBe(1);
  });
});

describe("mock mode", () => {
  it("resolves statement-style names via /search", async () => {
    const c = mockClient();
    const r = await c.search({ query: "blue btl", types: ["place"] });
    expect(r[0].name).toBe("Blue Bottle Coffee");
    expect(r[0].priceLevel).toBe(2);
  });

  it("returns taste-similar cheaper places near a point, sorted by affinity", async () => {
    const c = mockClient();
    const [carbone] = await c.search({ query: "Carbone", types: ["place"] });
    const out = await c.placeInsights({
      signalEntityIds: [carbone.id],
      lat: 40.7358,
      lon: -74.0036,
      radiusM: 3000,
      priceLevelMax: 3,
      take: 10,
    });
    expect(out.length).toBeGreaterThan(0);
    for (const e of out) {
      expect(e.priceLevel).toBeLessThanOrEqual(3);
      expect(e.distanceM).toBeLessThanOrEqual(3000);
      expect(e.id).not.toBe(carbone.id);
    }
    const affs = out.map((e) => e.affinity!);
    expect([...affs].sort((a, b) => b - a)).toEqual(affs);
    // the top result shares the italian tag
    expect(out[0].tags.map((t) => t.id)).toContain("urn:tag:style:place:italian");
  });

  it("serves tags", async () => {
    const tags = await mockClient().tags({ query: "coffee" });
    expect(tags.some((t) => t.id === "urn:tag:category:place:coffee_shop")).toBe(true);
  });

  it("is deterministic and marks entities synthetic", async () => {
    const f = createMockFetch();
    const a = await (await f("https://x/search?query=Lilia")).json();
    const b = await (await f("https://x/search?query=Lilia")).json();
    expect(a).toEqual(b);
    expect(a.results[0].disambiguation).toBe("synthetic mock entity");
    expect(mockWorld().length).toBeGreaterThan(300);
  });
});
