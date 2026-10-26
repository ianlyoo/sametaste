/**
 * Transactions -> merchant aggregates and a local category summary.
 *
 * Only `MerchantAggregate`s (cleaned descriptor, category, visit count, total)
 * are sent to the server. Descriptors are scrubbed of card, reference and phone
 * numbers first.
 */
import type { Category, MerchantAggregate } from "../contract";
import type { ParsedStatement } from "./statement";

/** Card processors and POS prefixes that precede the merchant name. */
const PREFIXES = [
  /^(SQ|TST|SP|PY|PP|IC|CKO|BT|DD|SQU|SQSP|FS|PAR|LS|WPY|EB|OLO)\s?\*\s*/,
  /^PAYPAL\s?\*\s*/,
  /^(POS|DBT|DEBIT CARD|CHECKCARD|CHECK CARD|VISA)( DEBIT| PURCHASE)?\s+(\d{4}\s+)?/,
  /^PURCHASE AUTHORIZED ON \d{1,2}\/\d{1,2}\s+/,
  /^RECURRING PAYMENT AUTHORIZED ON \d{1,2}\/\d{1,2}\s+/,
];

/** Merchants whose descriptors are known to be mangled. */
const ALIASES: [RegExp, string][] = [
  [/^(AMZN|AMAZON)(\s?MKTP|\.COM|\s?MARKETPLACE)?\b.*/, "AMAZON"],
  [/^UBER\s?\*?\s?EATS\b.*/, "UBER EATS"],
  [/^UBER\b.*/, "UBER"],
  [/^LYFT\b.*/, "LYFT"],
  [/^DOORDASH\b.*/, "DOORDASH"],
  [/^STARBUCKS\b.*/, "STARBUCKS"],
  [/^NETFLIX\b.*/, "NETFLIX"],
  [/^SPOTIFY\b.*/, "SPOTIFY"],
  [/^APPLE\.COM\/BILL\b.*/, "APPLE SERVICES"],
  [/^WHOLEFDS\b.*|^WHOLE FOODS\b.*/, "WHOLE FOODS"],
  [/^TRADER JOE'?\s?S\b.*/, "TRADER JOE'S"],
  [/^MTA\b.*|^NYCT\b.*|^OMNY\b.*/, "MTA"],
  // Truncated descriptors ("BLUE BTL", "BLUE BOTTLE COFFE") keep their own keys:
  // the agent merges them into one line (contract 1.2 `mergedKeys`), and the
  // recorded demo events are keyed that way.
  [/^KATZ'?S\b.*/, "KATZ'S DELICATESSEN"],
  [/^MCSORLEY'?S\b.*/, "MCSORLEY'S OLD ALE HOUSE"],
  [/^RUSS & DAUGHTERS\b.*/, "RUSS & DAUGHTERS"],
  [/^XI'?AN FAMOUS\b.*/, "XI'AN FAMOUS FOODS"],
  // chains: one taste signal, whichever branch
  [/^SWEETGREEN\b.*/, "SWEETGREEN"],
  [/^CAVA\b.*/, "CAVA"],
  [/^SOULCYCLE\b.*/, "SOULCYCLE"],
  [/^EQUINOX\b.*/, "EQUINOX"],
  [/^SHAKE SHACK\b.*/, "SHAKE SHACK"],
  [/^JOE COFFEE\b.*/, "JOE COFFEE"],
  [/^STUMPTOWN\b.*/, "STUMPTOWN COFFEE ROASTERS"],
];

const US_STATES =
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");
const CITIES = [
  "NEW YORK", "NEW YORK CITY", "NYC", "BROOKLYN", "QUEENS", "BRONX", "STATEN ISLAND", "MANHATTAN", "ASTORIA",
  "LONG ISLAND CITY", "LONG IS CITY", "WILLIAMSBURG", "JERSEY CITY", "HOBOKEN", "SAN FRANCISCO", "LOS ANGELES",
  "CHICAGO", "BOSTON", "SEATTLE", "AUSTIN", "MIAMI", "WASHINGTON", "PHILADELPHIA",
];

/** Remove card numbers, references, phone numbers, emails and URLs. */
export function scrubDescriptor(raw: string): string {
  return raw
    .replace(/\S+@\S+/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\+?1?[\s.-]?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g, " ")
    .replace(/[#*]?\b[A-Z]*\d[A-Z0-9]{3,}\b/gi, " ")
    .replace(/\b\d{4,}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * A descriptor's head for matching a server key cut from it by another
 * normaliser ("DEATH &" from "DEATH & CO NEW YORK NY"): upper case, payment
 * prefixes off, punctuation as spaces.
 */
export function descriptorHead(raw: string): string {
  let s = raw.toUpperCase().replace(/\s+/g, " ").trim();
  for (const p of PREFIXES) s = s.replace(p, "");
  return s.replace(/[^A-Z0-9&' ]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Clean a statement descriptor into a grouping key and a display name.
 * "SQ *BLUE BOTTLE COFFEE #0423 BROOKLYN NY" -> key "BLUE BOTTLE COFFEE", name "Blue Bottle Coffee".
 */
export function normalizeDescriptor(raw: string): { key: string; name: string } {
  let s = raw.toUpperCase().replace(/\s+/g, " ").trim();
  for (const p of PREFIXES) s = s.replace(p, "");
  s = scrubDescriptor(s);
  s = s
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, " ")
    .replace(/#\s*\d*/g, " ")
    .replace(/\bSTORE\s*\d*\b|\bSTE\s*\d+\b/g, " ")
    .replace(/[^A-Z0-9&'.\- ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Trailing "CITY ST" and lone digits.
  for (let k = 0; k < 3; k++) {
    const before = s;
    const words = s.split(" ");
    // a trailing state, but not the "CO" of "DEATH & CO"
    if (words.length > 1 && US_STATES.includes(words[words.length - 1]) && words[words.length - 2] !== "&") s = words.slice(0, -1).join(" ");
    for (const c of CITIES) if (s.endsWith(" " + c)) s = s.slice(0, -c.length - 1);
    // lone store numbers and terminal ids such as "S386"
    s = s.replace(/\s+[A-Z]?\d{1,4}[A-Z]?$/, "").replace(/[\s.-]+$/, "");
    if (s === before) break;
  }
  const alias = ALIASES.find(([re]) => re.test(s));
  if (alias) s = alias[1];
  if (!s) s = raw.trim().toUpperCase().slice(0, 60) || "UNKNOWN";
  const key = s.slice(0, 120);
  const name = key
    .toLowerCase()
    .replace(/(^|[\s&\-.])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase())
    .replace(/'S\b/g, "'s");
  return { key, name };
}

/** Bank category strings (Chase, Amex, Capital One, Discover, Apple, ...) -> our categories. */
const BANK_CATEGORY: [RegExp, Category][] = [
  [/coffee|caf[eé]/i, "coffee"],
  [/fast food/i, "fast_food"],
  [/bar|nightlife|alcohol/i, "bar"],
  [/restaurant|dining|food & drink|food and drink|^food/i, "restaurant"],
  [/grocer|supermarket/i, "grocery"],
  [/gym|fitness|health & wellness|sport/i, "fitness"],
  [/beauty|personal care|salon|spa/i, "beauty"],
  [/stream|subscription|digital/i, "streaming"],
  [/entertainment|movie|music|event|ticket/i, "entertainment"],
  [/travel|transport|gas|fuel|taxi|rideshare|parking|airline|transit|auto/i, "transport"],
  [/shop|merchandise|retail|clothing|department|electronics|home/i, "shopping"],
];

/** Merchant keywords; checked before the bank category because they are more specific. */
const KEYWORDS: [RegExp, Category][] = [
  [/COFFEE|CAFE|ESPRESSO|ROASTER|STARBUCKS|BLUE B(?:OTTLE|TL)\b|DUNKIN|LA COLOMBE|DEVOCION|BLANK STREET|JOE & THE JUICE/, "coffee"],
  [/MCDONALD|BURGER KING|WENDY|TACO BELL|CHIPOTLE|SHAKE SHACK|POPEYES|KFC|SUBWAY|FIVE GUYS|CHICK-FIL-A|SWEETGREEN|CAVA|\bDIG\b|JUST SALAD|\bPRET\b/, "fast_food"],
  [/(NOODLE|SUSHI|OYSTER|RAW|RAMEN|SALAD) BAR\b/, "restaurant"],
  [/\bBAR\b|\bPUB\b|TAVERN|BREWERY|BREWING|WINE BAR|COCKTAIL|SALOON|LOUNGE|ALE HOUSE|TAP ?ROOM|BEER HALL/, "bar"],
  [/WHOLE FOODS|TRADER JOE|KEY FOOD|FAIRWAY|WEGMANS|ALDI|SAFEWAY|KROGER|PUBLIX|GROCERY|\bMARKET\b|C-TOWN|FOOD BAZAAR|GRISTEDES|D'AGOSTINO|INSTACART|FRESH DIRECT|FRESHDIRECT/, "grocery"],
  [/SOULCYCLE|EQUINOX|BARRY'?S|ORANGETHEORY|PELOTON|CROSSFIT|PLANET FITNESS|BLINK FITNESS|CRUNCH|CLASSPASS|YOGA|PILATES|CYCLE|BOULDER|\bGYM\b|FITNESS/, "fitness"],
  [/SEPHORA|ULTA|SALON|BARBER|NAIL|\bSPA\b|DRYBAR|GLOSSIER|AESOP/, "beauty"],
  [/NETFLIX|SPOTIFY|HULU|DISNEY\s?PLUS|DISNEYPLUS|HBO|MAX\.COM|APPLE SERVICES|YOUTUBE|PARAMOUNT|PEACOCK|AUDIBLE|PATREON|SUBSTACK/, "streaming"],
  [/TICKETMASTER|LIVE NATION|\bAXS\b|SEATGEEK|STUBHUB|EVENTBRITE|DICE\.FM|\bAMC\b|REGAL|ALAMO|NITEHAWK|ANGELIKA|METROGRAPH|MUSEUM|THEATER|THEATRE|BOWL/, "entertainment"],
  [/\bUBER\b|LYFT|\bMTA\b|CITI ?BIKE|REVEL|CURB|TAXI|PARKING|SHELL|EXXON|\bBP\b|CHEVRON|AMTRAK|DELTA|JETBLUE|UNITED AIR/, "transport"],
  [/AMAZON|TARGET|WALMART|UNIQLO|ZARA|H&M|ARITZIA|MUJI|NORDSTROM|MACY|BEST BUY|APPLE STORE|IKEA|ETSY|EVERLANE|MADEWELL|BOOK/, "shopping"],
  [/RESTAURANT|TRATTORIA|PIZZ|SUSHI|RAMEN|TAQUERIA|BISTRO|KITCHEN|GRILL|DINER|STEAK|OSTERIA|NOODLE|DUMPLING|BBQ|BAGEL|BAKERY|DELI\b|DELICATESSEN|UBER EATS|DOORDASH|GRUBHUB|SEAMLESS|CAVIAR/, "restaurant"],
];

/**
 * Well-known New York places whose names don't say what they are. A bank
 * category column, when the export has one, covers the rest of the world.
 */
const KNOWN: [RegExp, Category][] = [
  [/^(LILIA|CARBONE|COTE|LLAMA INN|MISI|LEO|ROBERTA'?S|L'INDUSTRIE|RUSS & DAUGHTERS|XI'AN FAMOUS FOODS|VIA CAROTA|CHARLIE BIRD|THAI DINER|DI FARA|LUCALI|BALTHAZAR|MOMOFUKU\b.*)$/, "restaurant"],
  [/^(THE FOUR HORSEMEN|FOUR HORSEMEN|ATTABOY|DEATH & CO|PLEASE DON'?T TELL|DANTE|BAR GOTO|THE BLACK FLAMINGO|MAISON PREMIERE)$/, "bar"],
  [/^(KAFFE|KAFFE 1668|DEVOCION|VARIETY|ABRACO|PARLOR COFFEE|SEY)$/, "coffee"],
];

export function categorize(key: string, bankCategory?: string): Category {
  for (const [re, c] of KNOWN) if (re.test(key)) return c;
  for (const [re, c] of KEYWORDS) if (re.test(key)) return c;
  if (bankCategory) for (const [re, c] of BANK_CATEGORY) if (re.test(bankCategory)) return c;
  return "other";
}

const mode = <T>(xs: T[]): T => {
  const n = new Map<T, number>();
  let best = xs[0];
  let bestN = 0;
  for (const x of xs) {
    const c = (n.get(x) ?? 0) + 1;
    n.set(x, c);
    if (c > bestN) {
      best = x;
      bestN = c;
    }
  }
  return best;
};

/** A merchant as the browser sees it: the aggregate we send, plus a display name kept locally. */
export interface LocalMerchant extends MerchantAggregate {
  name: string;
  category: Category;
}

export interface AggregateOptions {
  /** Contract allows at most 200 merchants per request. */
  max?: number;
}

/** Group transactions by normalised merchant; refunds net off; drops merchants with no net spend. */
export function aggregateMerchants(statement: ParsedStatement, opts: AggregateOptions = {}): LocalMerchant[] {
  const max = opts.max ?? 200;
  const groups = new Map<string, { name: string; raws: string[]; cats: Category[]; count: number; total: number }>();
  for (const t of statement.transactions) {
    const { key, name } = normalizeDescriptor(t.rawMerchant);
    const g = groups.get(key) ?? { name, raws: [], cats: [], count: 0, total: 0 };
    g.raws.push(scrubDescriptor(t.rawMerchant) || key);
    g.cats.push(t.category ?? categorize(key, statement.bankCategories[t.id]));
    if (t.amount > 0) g.count++;
    g.total += t.amount;
    groups.set(key, g);
  }
  const out: LocalMerchant[] = [];
  for (const [key, g] of groups) {
    const total = Math.round(g.total * 100) / 100;
    if (g.count < 1 || total <= 0) continue;
    out.push({
      key,
      name: g.name,
      rawMerchant: mode(g.raws),
      category: mode(g.cats),
      count: g.count,
      totalSpend: total,
      currency: "USD",
      windowDays: statement.windowDays,
    });
  }
  return out.sort((a, b) => b.totalSpend - a.totalSpend).slice(0, max);
}

/** Strip local-only fields; this is exactly what goes over the wire. */
export function toWire(m: LocalMerchant): MerchantAggregate {
  return {
    key: m.key,
    rawMerchant: m.rawMerchant,
    category: m.category,
    count: m.count,
    totalSpend: m.totalSpend,
    currency: m.currency,
    windowDays: m.windowDays,
  };
}

export interface CategorySummary {
  category: Category;
  total: number;
  /** 0..1 of all spend. */
  share: number;
  count: number;
  /** Merchants in this category, by spend. */
  merchants: LocalMerchant[];
}

/** Categories by spend, for the categories screen. Computed locally, never sent. */
export function summarizeCategories(merchants: LocalMerchant[]): CategorySummary[] {
  const all = merchants.reduce((a, m) => a + m.totalSpend, 0) || 1;
  const by = new Map<Category, CategorySummary>();
  for (const m of merchants) {
    const s = by.get(m.category) ?? { category: m.category, total: 0, share: 0, count: 0, merchants: [] };
    s.total += m.totalSpend;
    s.count += m.count;
    s.merchants.push(m);
    by.set(m.category, s);
  }
  return [...by.values()]
    .map((s) => ({ ...s, total: Math.round(s.total * 100) / 100, share: s.total / all }))
    .sort((a, b) => b.total - a.total);
}

export const CATEGORY_LABEL: Record<Category, string> = {
  coffee: "Coffee",
  restaurant: "Dining out",
  fast_food: "Quick meals",
  bar: "Bars",
  grocery: "Groceries",
  fitness: "Fitness",
  beauty: "Beauty",
  shopping: "Shopping",
  entertainment: "Going out & shows",
  streaming: "Streaming",
  transport: "Getting around",
  other: "Other",
};
