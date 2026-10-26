/** Name similarity for matching statement names to Qloo entities. */

const STOP = new Set(["the", "and", "of", "nyc", "ny", "new", "york", "co", "company", "inc", "llc", "cafe", "coffee", "restaurant", "bar", "shop"]);

export function normName(s: string): string {
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

function tokens(s: string, dropStop: boolean): string[] {
  const t = normName(s).split(" ").filter(Boolean);
  if (!dropStop) return t;
  const core = t.filter((x) => !STOP.has(x));
  return core.length ? core : t;
}

/** 0..1; 1 for equal names, high for "Blue Bottle" vs "Blue Bottle Coffee". */
export function nameSimilarity(a: string, b: string): number {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = tokens(a, true);
  const tb = tokens(b, true);
  const match = (x: string, y: string) => x === y || (x.length >= 4 && y.startsWith(x)) || (y.length >= 4 && x.startsWith(y));
  const hits = ta.filter((x) => tb.some((y) => match(x, y))).length;
  const dice = (2 * hits) / (ta.length + tb.length);
  const contains = na.includes(nb) || nb.includes(na) ? 0.85 : 0;
  return Math.max(dice, contains);
}
