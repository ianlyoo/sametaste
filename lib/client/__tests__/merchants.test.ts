import { describe, expect, it } from "vitest";
import { aggregateMerchants, categorize, normalizeDescriptor, scrubDescriptor, summarizeCategories, toWire } from "../merchants";
import { parseStatement } from "../statement";

describe("normalizeDescriptor", () => {
  it.each([
    ["SQ *BLUE BOTTLE COFFEE #0423 BROOKLYN NY", "BLUE BOTTLE COFFEE", "Blue Bottle Coffee"],
    ["TST* LILIA 4410", "LILIA", "Lilia"],
    ["SQ *BLUE BTL", "BLUE BTL", "Blue Btl"],
    ["SQ *BLUE BOTTLE COFFE", "BLUE BOTTLE COFFE", "Blue Bottle Coffe"],
    ["DEATH & CO NEW YORK NY", "DEATH & CO", "Death & Co"],
    ["TRADER JOE S NEW YORK NY", "TRADER JOE'S", "Trader Joe's"],
    ["SWEETGREEN NYC 8TH", "SWEETGREEN", "Sweetgreen"],
    ["WHOLEFDS WBG 10234 BROOKLYN NY", "WHOLE FOODS", "Whole Foods"],
    ["AMZN Mktp US*2K4AB1C23", "AMAZON", "Amazon"],
    ["UBER   *TRIP HELP.UBER.COM", "UBER", "Uber"],
    ["UBER *EATS PENDING", "UBER EATS", "Uber Eats"],
    ["PURCHASE AUTHORIZED ON 09/01 BLUE BOTTLE COFFEE BROOKLYN NY S386", "BLUE BOTTLE COFFEE", "Blue Bottle Coffee"],
    ["TRADER JOE'S #558 QPS", "TRADER JOE'S", "Trader Joe's"],
    ["Variety Coffee", "VARIETY COFFEE", "Variety Coffee"],
  ])("%s -> %s", (raw, key, name) => {
    expect(normalizeDescriptor(raw)).toEqual({ key, name });
  });
});

describe("scrubDescriptor", () => {
  it("removes card, reference and phone numbers and emails", () => {
    const s = scrubDescriptor("LILIA 4410 REF 2K4AB1C23 CARD 1234 212-555-0199 maya@example.com");
    expect(s).toBe("LILIA REF CARD");
  });
});

describe("categorize", () => {
  it("prefers merchant keywords, then the bank category", () => {
    expect(categorize("BLUE BOTTLE COFFEE", "Food & Drink")).toBe("coffee");
    expect(categorize("BLUE BTL")).toBe("coffee");
    expect(categorize("LILIA", "Food & Drink")).toBe("restaurant");
    expect(categorize("SOULCYCLE WILLIAMSBURG")).toBe("fitness");
    expect(categorize("CYCLEBAR WILLIAMSBURG")).toBe("fitness");
    expect(categorize("MAISON PREMIERE", "Bars & Nightlife")).toBe("bar");
    expect(categorize("TICKETMASTER")).toBe("entertainment");
    expect(categorize("SUPERMARKET 5")).toBe("other");
    expect(categorize("XYZ")).toBe("other");
    expect(categorize("MOMOFUKU NOODLE BAR")).toBe("restaurant");
    expect(categorize("MCSORLEY'S OLD ALE HOUSE")).toBe("bar");
    expect(categorize("THE FOUR HORSEMEN")).toBe("bar");
  });
});

describe("aggregateMerchants", () => {
  const st = parseStatement(
    [
      "date,merchant,amount",
      "2026-09-01,SQ *BLUE BOTTLE COFFEE #0423 BROOKLYN NY,6.80",
      "2026-09-02,SQ *BLUE BOTTLE COFFEE #0423 BROOKLYN NY,7.20",
      "2026-09-05,TST* LILIA 4410,112.40",
      "2026-09-06,TST* LILIA 4410,-12.40",
      "2026-09-07,REFUND ONLY SHOP,5.00",
      "2026-09-08,REFUND ONLY SHOP,-5.00",
      "2026-09-30,WHOLEFDS WBG 10234 BROOKLYN NY,45.90",
    ].join("\n"),
  );
  const ms = aggregateMerchants(st);

  it("groups by normalised key, nets refunds and drops zero-spend merchants", () => {
    expect(ms.map((m) => [m.key, m.count, m.totalSpend, m.category])).toEqual([
      ["LILIA", 1, 100, "restaurant"],
      ["WHOLE FOODS", 1, 45.9, "grocery"],
      ["BLUE BOTTLE COFFEE", 2, 14, "coffee"],
    ]);
    expect(ms[0].windowDays).toBe(30);
  });

  it("sends only scrubbed aggregates", () => {
    const wire = ms.map(toWire);
    expect(Object.keys(wire[0]).sort()).toEqual(["category", "count", "currency", "key", "rawMerchant", "totalSpend", "windowDays"]);
    expect(JSON.stringify(wire)).not.toMatch(/\d{4}/);
  });

  it("caps the number of merchants", () => {
    expect(aggregateMerchants(st, { max: 2 })).toHaveLength(2);
  });

  it("summarises categories by spend", () => {
    const cats = summarizeCategories(ms);
    expect(cats.map((c) => c.category)).toEqual(["restaurant", "grocery", "coffee"]);
    expect(cats.reduce((a, c) => a + c.share, 0)).toBeCloseTo(1);
  });
});
