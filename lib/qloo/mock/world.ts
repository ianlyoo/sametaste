/**
 * Synthetic NYC "taste world" for QLOO_MOCK=1.
 *
 * Nothing here comes from Qloo. Anchor merchants are real, public NYC
 * business names so the personas and the eval set resolve, but every id,
 * coordinate, price level, rating, tag and affinity is invented. Swap
 * candidates are fictional places generated from word lists. Mock entities
 * carry `disambiguation: "synthetic mock entity"`.
 */
import type { Category, QlooEntityType } from "../../contract";

export interface Hood {
  name: string;
  lat: number;
  lon: number;
}

/** Approximate neighbourhood centres. */
export const HOODS: Hood[] = [
  { name: "Williamsburg", lat: 40.7081, lon: -73.9571 },
  { name: "Greenpoint", lat: 40.7304, lon: -73.9515 },
  { name: "Bushwick", lat: 40.6944, lon: -73.9213 },
  { name: "Park Slope", lat: 40.671, lon: -73.9814 },
  { name: "Crown Heights", lat: 40.6694, lon: -73.9422 },
  { name: "East Village", lat: 40.7265, lon: -73.9815 },
  { name: "West Village", lat: 40.7358, lon: -74.0036 },
  { name: "Lower East Side", lat: 40.715, lon: -73.9843 },
  { name: "SoHo", lat: 40.7233, lon: -74.003 },
  { name: "Chelsea", lat: 40.7465, lon: -74.0014 },
  { name: "Flatiron", lat: 40.7411, lon: -73.9897 },
  { name: "Midtown", lat: 40.7549, lon: -73.984 },
  { name: "Financial District", lat: 40.7075, lon: -74.0113 },
  { name: "Upper West Side", lat: 40.787, lon: -73.9754 },
  { name: "Upper East Side", lat: 40.7736, lon: -73.9566 },
  { name: "Harlem", lat: 40.8116, lon: -73.9465 },
  { name: "Astoria", lat: 40.7644, lon: -73.9235 },
  { name: "Long Island City", lat: 40.7447, lon: -73.9485 },
];

export function hood(name: string): Hood {
  const h = HOODS.find((x) => x.name === name);
  if (!h) throw new Error(`unknown hood ${name}`);
  return h;
}

/** Synthetic tag catalogue, shaped like Qloo tag URNs. */
export const CATEGORY_TAG: Record<Category, string> = {
  coffee: "urn:tag:category:place:coffee_shop",
  restaurant: "urn:tag:category:place:restaurant",
  fast_food: "urn:tag:category:place:fast_casual",
  bar: "urn:tag:category:place:bar",
  grocery: "urn:tag:category:place:grocery_store",
  fitness: "urn:tag:category:place:gym",
  beauty: "urn:tag:category:place:salon",
  shopping: "urn:tag:category:place:store",
  entertainment: "urn:tag:category:place:entertainment_venue",
  streaming: "urn:tag:category:brand:streaming",
  transport: "urn:tag:category:place:transport",
  other: "urn:tag:category:place:other",
};

/** Style tags per category; alternatives draw from the same pool. */
export const STYLE_TAGS: Partial<Record<Category, string[]>> = {
  coffee: ["specialty_coffee", "pour_over", "espresso_bar", "cozy", "laptop_friendly", "pastries", "minimalist"],
  restaurant: [
    "italian",
    "french_bistro",
    "new_american",
    "pizza",
    "mexican",
    "chinese",
    "jewish_deli",
    "korean",
    "thai",
    "peruvian",
    "steakhouse",
    "seafood",
    "date_night",
    "brunch",
    "lively",
  ],
  fast_food: ["burgers", "salads", "mediterranean_bowls", "tacos", "noodles", "quick_bite"],
  bar: ["cocktail_bar", "speakeasy", "dive_bar", "natural_wine", "craft_beer", "late_night"],
  fitness: ["boutique_fitness", "indoor_cycling", "hiit", "strength", "full_gym", "pool", "budget_gym"],
  grocery: ["organic", "prepared_foods", "budget_grocery", "specialty_foods"],
  beauty: ["blowout", "hair_salon", "nails"],
};

export function styleTag(style: string): string {
  return `urn:tag:style:place:${style}`;
}

export interface MockEntity {
  id: string;
  name: string;
  type: QlooEntityType;
  category: Category;
  hood: string;
  lat: number;
  lon: number;
  address: string;
  priceLevel?: 1 | 2 | 3 | 4;
  businessRating: number;
  popularity: number;
  tags: string[];
  aliases: string[];
  anchor: boolean;
  /** A mockStandIn: found only by its exact name, scored only when asked for by id; never a candidate. */
  standIn?: boolean;
}

interface AnchorSeed {
  name: string;
  category: Category;
  price: 1 | 2 | 3 | 4;
  hoods: string[];
  styles: string[];
  aliases?: string[];
  type?: QlooEntityType;
}

/**
 * Anchors: real NYC merchant names with invented attributes. Chains get one
 * entity per listed hood (Qloo models each location as its own place).
 */
export const ANCHORS: AnchorSeed[] = [
  // coffee
  { name: "Blue Bottle Coffee", category: "coffee", price: 2, hoods: ["Williamsburg", "Chelsea"], styles: ["specialty_coffee", "pour_over", "minimalist"], aliases: ["blue btl", "bluebottle"] },
  { name: "Joe Coffee Company", category: "coffee", price: 2, hoods: ["West Village", "Upper West Side"], styles: ["specialty_coffee", "espresso_bar"], aliases: ["joe coffee", "joe pro shop"] },
  { name: "La Colombe Coffee Roasters", category: "coffee", price: 2, hoods: ["SoHo"], styles: ["specialty_coffee", "espresso_bar", "laptop_friendly"], aliases: ["la colombe"] },
  { name: "Starbucks", category: "coffee", price: 2, hoods: ["Midtown", "Financial District", "Williamsburg"], styles: ["espresso_bar", "laptop_friendly"], aliases: ["starbucks store", "sbux"] },
  { name: "Ralph's Coffee", category: "coffee", price: 3, hoods: ["SoHo"], styles: ["espresso_bar", "pastries", "minimalist"] },
  { name: "Devoción", category: "coffee", price: 3, hoods: ["Williamsburg"], styles: ["specialty_coffee", "pour_over", "cozy"], aliases: ["devocion"] },
  { name: "Stumptown Coffee Roasters", category: "coffee", price: 2, hoods: ["Flatiron"], styles: ["specialty_coffee", "espresso_bar"], aliases: ["stumptown"] },
  { name: "Bluestone Lane", category: "coffee", price: 3, hoods: ["Financial District", "Upper East Side"], styles: ["espresso_bar", "pastries", "brunch"] },
  { name: "Partners Coffee", category: "coffee", price: 2, hoods: ["Williamsburg"], styles: ["specialty_coffee", "laptop_friendly", "pastries"], aliases: ["partners coffee roasters"] },
  // restaurants
  { name: "Carbone", category: "restaurant", price: 4, hoods: ["West Village"], styles: ["italian", "date_night", "lively"] },
  { name: "Balthazar", category: "restaurant", price: 3, hoods: ["SoHo"], styles: ["french_bistro", "brunch", "lively"] },
  { name: "Lilia", category: "restaurant", price: 3, hoods: ["Williamsburg"], styles: ["italian", "date_night"] },
  { name: "Via Carota", category: "restaurant", price: 3, hoods: ["West Village"], styles: ["italian", "date_night", "lively"] },
  { name: "Le Coucou", category: "restaurant", price: 4, hoods: ["SoHo"], styles: ["french_bistro", "date_night"] },
  { name: "Katz's Delicatessen", category: "restaurant", price: 2, hoods: ["Lower East Side"], styles: ["jewish_deli", "lively"], aliases: ["katzs deli", "katz s"] },
  { name: "Joe's Pizza", category: "restaurant", price: 1, hoods: ["West Village", "Williamsburg"], styles: ["pizza"] },
  { name: "Raoul's", category: "restaurant", price: 3, hoods: ["SoHo"], styles: ["french_bistro", "date_night"], aliases: ["raouls"] },
  { name: "Peter Luger Steak House", category: "restaurant", price: 4, hoods: ["Williamsburg"], styles: ["steakhouse"], aliases: ["peter luger"] },
  { name: "Momofuku Noodle Bar", category: "restaurant", price: 2, hoods: ["East Village"], styles: ["korean", "lively"], aliases: ["momofuku"] },
  { name: "Russ & Daughters Cafe", category: "restaurant", price: 2, hoods: ["Lower East Side"], styles: ["jewish_deli", "brunch"], aliases: ["russ and daughters"] },
  { name: "Le Bernardin", category: "restaurant", price: 4, hoods: ["Midtown"], styles: ["seafood", "french_bistro", "date_night"] },
  { name: "Llama Inn", category: "restaurant", price: 3, hoods: ["Williamsburg"], styles: ["peruvian", "lively"] },
  { name: "Cote Korean Steakhouse", category: "restaurant", price: 4, hoods: ["Flatiron"], styles: ["korean", "steakhouse", "date_night"], aliases: ["cote"] },
  { name: "Thai Diner", category: "restaurant", price: 2, hoods: ["SoHo"], styles: ["thai", "brunch", "lively"] },
  { name: "Dimes", category: "restaurant", price: 2, hoods: ["Lower East Side"], styles: ["new_american", "brunch"] },
  { name: "Atoboy", category: "restaurant", price: 3, hoods: ["Flatiron"], styles: ["korean", "date_night"] },
  { name: "Cafe Mogador", category: "restaurant", price: 2, hoods: ["East Village", "Williamsburg"], styles: ["brunch", "lively"] },
  // fast casual
  { name: "Sweetgreen", category: "fast_food", price: 2, hoods: ["Flatiron", "Williamsburg", "Midtown"], styles: ["salads", "quick_bite"], aliases: ["sweetgreen nyc"] },
  { name: "CAVA", category: "fast_food", price: 2, hoods: ["Midtown", "Chelsea"], styles: ["mediterranean_bowls", "quick_bite"] },
  { name: "Shake Shack", category: "fast_food", price: 2, hoods: ["Flatiron", "Midtown"], styles: ["burgers", "quick_bite"] },
  { name: "Los Tacos No. 1", category: "fast_food", price: 1, hoods: ["Chelsea"], styles: ["tacos", "quick_bite"], aliases: ["los tacos no 1", "los tacos"] },
  { name: "Xi'an Famous Foods", category: "fast_food", price: 1, hoods: ["East Village"], styles: ["noodles", "quick_bite"], aliases: ["xian famous foods"] },
  { name: "Dig", category: "fast_food", price: 2, hoods: ["Flatiron"], styles: ["salads", "quick_bite"], aliases: ["dig inn"] },
  // bars
  { name: "Death & Co", category: "bar", price: 3, hoods: ["East Village"], styles: ["cocktail_bar", "speakeasy", "late_night"], aliases: ["death and co"] },
  { name: "Employees Only", category: "bar", price: 3, hoods: ["West Village"], styles: ["cocktail_bar", "speakeasy", "late_night"] },
  { name: "Attaboy", category: "bar", price: 3, hoods: ["Lower East Side"], styles: ["cocktail_bar", "speakeasy"] },
  { name: "Please Don't Tell", category: "bar", price: 3, hoods: ["East Village"], styles: ["speakeasy", "cocktail_bar"], aliases: ["pdt"] },
  { name: "McSorley's Old Ale House", category: "bar", price: 1, hoods: ["East Village"], styles: ["dive_bar", "craft_beer"], aliases: ["mcsorleys"] },
  { name: "The Four Horsemen", category: "bar", price: 3, hoods: ["Williamsburg"], styles: ["natural_wine", "date_night"] },
  // fitness
  { name: "Equinox", category: "fitness", price: 4, hoods: ["Flatiron", "Williamsburg"], styles: ["full_gym", "pool", "strength"], aliases: ["equinox fitness", "eqx"] },
  { name: "SoulCycle", category: "fitness", price: 4, hoods: ["Chelsea"], styles: ["indoor_cycling", "boutique_fitness"], aliases: ["soul cycle"] },
  { name: "Barry's", category: "fitness", price: 4, hoods: ["Chelsea"], styles: ["hiit", "boutique_fitness"], aliases: ["barrys bootcamp", "barry s"] },
  { name: "Planet Fitness", category: "fitness", price: 1, hoods: ["Bushwick"], styles: ["full_gym", "budget_gym"] },
  { name: "Crunch Fitness", category: "fitness", price: 2, hoods: ["Chelsea"], styles: ["full_gym", "strength"], aliases: ["crunch"] },
  // grocery and beauty
  { name: "Whole Foods Market", category: "grocery", price: 3, hoods: ["Williamsburg", "Chelsea"], styles: ["organic", "prepared_foods"], aliases: ["whole foods", "wholefds", "wfm"] },
  { name: "Trader Joe's", category: "grocery", price: 1, hoods: ["Chelsea"], styles: ["budget_grocery", "specialty_foods"], aliases: ["trader joes"] },
  { name: "Drybar", category: "beauty", price: 3, hoods: ["Flatiron"], styles: ["blowout"] },
];

const ALT_WORDS_A = [
  "Brass", "Little", "Copper", "Juniper", "Marlow", "Fig", "Harbor", "Lantern", "Oak", "Saffron",
  "Velvet", "Wren", "Atlas", "Clover", "Ember", "Hollow", "Ivy", "Kestrel", "Linden", "Moss",
];
const ALT_WORDS_B = [
  "Sparrow", "Ferry", "Anchor", "Fox", "Lark", "Kettle", "Pine", "Stone", "Bridge", "Garden",
  "Crane", "Otter", "Thistle", "Quarry", "Rook", "Tide", "Willow", "Badger", "Comet", "Heron",
];
const CATEGORY_NOUN: Partial<Record<Category, string>> = {
  coffee: "Coffee",
  restaurant: "Kitchen",
  fast_food: "Counter",
  bar: "Bar",
  fitness: "Fitness",
  grocery: "Market",
  beauty: "Studio",
};
const STYLE_NOUN: Record<string, string> = {
  italian: "Trattoria",
  french_bistro: "Bistro",
  pizza: "Pizza",
  mexican: "Taqueria",
  chinese: "Noodle House",
  jewish_deli: "Deli",
  korean: "Korean Kitchen",
  thai: "Thai",
  peruvian: "Cevicheria",
  steakhouse: "Chophouse",
  seafood: "Oyster Bar",
  new_american: "Tavern",
  burgers: "Burgers",
  salads: "Greens",
  mediterranean_bowls: "Grill",
  tacos: "Tacos",
  noodles: "Noodles",
  cocktail_bar: "Cocktail Room",
  speakeasy: "Parlor",
  dive_bar: "Tap Room",
  natural_wine: "Wine Bar",
  craft_beer: "Alehouse",
  indoor_cycling: "Cycle",
  hiit: "Bootcamp",
  boutique_fitness: "Studio",
  full_gym: "Gym",
  blowout: "Blowout Bar",
};

/** FNV-1a 32-bit. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic pseudo-random in [0,1). */
export function rand01(seed: string): number {
  return hash32(seed) / 0x1_0000_0000;
}

/** Deterministic UUID-shaped id. */
export function mockId(seed: string): string {
  const hex = [0, 1, 2, 3]
    .map((i) => hash32(`${i}:${seed}`).toString(16).padStart(8, "0"))
    .join("")
    .toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-A${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function jitter(h: Hood, seed: string): { lat: number; lon: number } {
  // up to ~600 m from the hood centre
  return {
    lat: +(h.lat + (rand01(`lat:${seed}`) - 0.5) * 0.011).toFixed(6),
    lon: +(h.lon + (rand01(`lon:${seed}`) - 0.5) * 0.014).toFixed(6),
  };
}

function address(seed: string, hoodName: string): string {
  const n = 10 + Math.floor(rand01(`no:${seed}`) * 380);
  const streets = ["Bedford Ave", "Grand St", "Broadway", "Bleecker St", "Ave A", "Driggs Ave", "W 4th St", "Court St", "Steinway St", "Nostrand Ave"];
  const s = streets[hash32(`st:${seed}`) % streets.length];
  return `${n} ${s} (synthetic), ${hoodName}, New York, NY`;
}

function buildAnchors(): MockEntity[] {
  const out: MockEntity[] = [];
  for (const a of ANCHORS) {
    for (const hn of a.hoods) {
      const h = hood(hn);
      const seed = `${a.name}@${hn}`;
      const { lat, lon } = jitter(h, seed);
      out.push({
        id: mockId(seed),
        name: a.name,
        type: a.type ?? "place",
        category: a.category,
        hood: hn,
        lat,
        lon,
        address: address(seed, hn),
        priceLevel: a.price,
        businessRating: +(4 + rand01(`r:${seed}`) * 0.8).toFixed(1),
        popularity: +(0.9 + rand01(`p:${seed}`) * 0.099).toFixed(3),
        tags: [CATEGORY_TAG[a.category], ...a.styles.map(styleTag)],
        aliases: a.aliases ?? [],
        anchor: true,
      });
    }
  }
  return out;
}

/**
 * Fictional alternatives: for every category with style tags, every hood and
 * every style, places at price levels 1..3.
 */
function buildAlternatives(): MockEntity[] {
  const out: MockEntity[] = [];
  const used = new Set<string>();
  for (const [cat, styles] of Object.entries(STYLE_TAGS) as [Category, string[]][]) {
    // "flavour" styles define the kind of place; others are decoration
    for (const h of HOODS) {
      for (const style of styles) {
        for (const level of [1, 2, 3] as const) {
          const seed = `${cat}|${h.name}|${style}|${level}`;
          // thin out: keep ~45% to make coverage uneven like real data
          if (rand01(`keep:${seed}`) > 0.45) continue;
          let name = "";
          for (let i = 0; i < 5 && (!name || used.has(name)); i++) {
            const a = ALT_WORDS_A[hash32(`a${i}:${seed}`) % ALT_WORDS_A.length];
            const b = ALT_WORDS_B[hash32(`b${i}:${seed}`) % ALT_WORDS_B.length];
            const noun = STYLE_NOUN[style] ?? CATEGORY_NOUN[cat] ?? "Place";
            name = i < 2 ? `${a} ${b} ${noun}` : `${a} & ${b} ${noun} ${h.name}`;
          }
          used.add(name);
          const pool = styles.filter((s) => s !== style);
          const extra = pool[hash32(`x:${seed}`) % pool.length];
          const { lat, lon } = jitter(h, seed);
          out.push({
            id: mockId(seed),
            name,
            type: "place",
            category: cat,
            hood: h.name,
            lat,
            lon,
            address: address(seed, h.name),
            priceLevel: level,
            businessRating: +(3.7 + rand01(`r:${seed}`) * 1.2).toFixed(1),
            popularity: +(0.35 + rand01(`p:${seed}`) * 0.6).toFixed(3),
            tags: [CATEGORY_TAG[cat], styleTag(style), styleTag(extra)],
            aliases: [],
            anchor: false,
          });
        }
      }
    }
  }
  return out;
}

const CROSS_DOMAINS: { type: QlooEntityType; tag: string; pattern: (a: string, b: string) => string }[] = [
  { type: "artist", tag: "urn:tag:genre:music:indie", pattern: (a, b) => `The ${a} ${b}s` },
  { type: "movie", tag: "urn:tag:genre:media:drama", pattern: (a, b) => `${a} at the ${b}` },
  { type: "tv_show", tag: "urn:tag:genre:media:comedy", pattern: (a, b) => `${b} & ${a}` },
  { type: "brand", tag: "urn:tag:category:brand:lifestyle", pattern: (a, b) => `${a}${b.toLowerCase()} Goods` },
];

/**
 * Fictional cross-domain entities (artists, films, shows, brands). Each one
 * carries two place style tags, so place signals predict them in the mock.
 */
function buildCrossDomain(): MockEntity[] {
  const out: MockEntity[] = [];
  const styles = [...new Set(Object.values(STYLE_TAGS).flat())];
  const nyc = hood("Flatiron");
  for (const d of CROSS_DOMAINS) {
    styles.forEach((style, i) => {
      const seed = `${d.type}|${style}`;
      const a = ALT_WORDS_A[hash32(`ca:${seed}`) % ALT_WORDS_A.length];
      const b = ALT_WORDS_B[hash32(`cb:${seed}`) % ALT_WORDS_B.length];
      const other = styles[(i + 1 + (hash32(`co:${seed}`) % (styles.length - 1))) % styles.length];
      out.push({
        id: mockId(seed),
        name: d.pattern(a, b),
        type: d.type,
        category: "entertainment",
        hood: nyc.name,
        lat: nyc.lat,
        lon: nyc.lon,
        address: "",
        businessRating: 0,
        popularity: +(0.4 + rand01(`p:${seed}`) * 0.59).toFixed(3),
        tags: [d.tag, styleTag(style), styleTag(other)],
        aliases: [],
        anchor: false,
      });
    });
  }
  return out;
}

let world: MockEntity[] | null = null;

export function mockWorld(): MockEntity[] {
  if (!world) world = [...buildAnchors(), ...buildAlternatives(), ...buildCrossDomain()];
  return world;
}

/**
 * Mock stand-in for a place the mock world does not know (e.g. a real venue
 * the model alone named), so the mock Qloo can score it like any entity.
 * Invented like every mock attribute, and deliberately generous to the
 * model: it keeps the original's category and first taste tag (as if the
 * model got the kind of place right), adds one taste tag from the same pool,
 * and sits at or below the original's price level. Deterministic by name.
 */
export function mockStandIn(name: string, from: { category: Category; tags: string[]; priceLevel?: number }, hoodName?: string): MockEntity {
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const known = mockWorld().find((e) => e.type === "place" && e.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === key);
  if (known) return known;
  const seed = `standin|${key}`;
  const h = HOODS.find((x) => x.name.toLowerCase() === hoodName?.toLowerCase()) ?? hood("Williamsburg");
  const styles = STYLE_TAGS[from.category] ?? [];
  const first = from.tags.find((t) => t.startsWith("urn:tag:style:"));
  const pool = styles.map(styleTag).filter((t) => t !== first);
  const extra = pool.length ? pool[hash32(`x:${seed}`) % pool.length] : undefined;
  const top = Math.max(1, Math.min(4, from.priceLevel ?? 2));
  const { lat, lon } = jitter(h, seed);
  const e: MockEntity = {
    id: mockId(seed),
    name,
    type: "place",
    category: from.category,
    hood: h.name,
    lat,
    lon,
    address: address(seed, h.name),
    priceLevel: (1 + (hash32(`lvl:${seed}`) % top)) as 1 | 2 | 3 | 4,
    businessRating: +(3.7 + rand01(`r:${seed}`) * 1.2).toFixed(1),
    popularity: +(0.35 + rand01(`p:${seed}`) * 0.6).toFixed(3),
    tags: [CATEGORY_TAG[from.category], ...(first ? [first] : []), ...(extra ? [extra] : [])],
    aliases: [],
    anchor: false,
    standIn: true,
  };
  mockWorld().push(e);
  return e;
}

export function mockEntityById(id: string): MockEntity | undefined {
  return mockWorld().find((e) => e.id === id);
}

export function allMockTags(): { id: string; name: string; type: string }[] {
  const seen = new Map<string, { id: string; name: string; type: string }>();
  for (const e of mockWorld()) {
    for (const t of e.tags) {
      if (!seen.has(t)) {
        const parts = t.split(":");
        seen.set(t, {
          id: t,
          name: parts[parts.length - 1].replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
          type: parts.slice(0, -1).join(":"),
        });
      }
    }
  }
  return [...seen.values()];
}
