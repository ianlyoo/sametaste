import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MerchantAggregateSchema } from "../lib/contract";
import { PERSONAS, aggregateTransactions, merchantKey, parseCsv } from ".";

describe("personas", () => {
  it("parses quoted CSV fields", () => {
    const t = parseCsv('date,description,amount,currency\n2026-09-01,"JOE\'S, ""NYC""",4.5,USD\n');
    expect(t[0]).toMatchObject({ rawMerchant: 'JOE\'S, "NYC"', amount: 4.5, currency: "USD" });
  });

  it("keys strip store numbers and processor marks", () => {
    expect(merchantKey("SQ *BLUE BTL 0423")).toBe("SQ BLUE BTL");
    expect(merchantKey("STARBUCKS STORE #11742")).toBe(merchantKey("STARBUCKS STORE 11742"));
  });

  for (const p of PERSONAS) {
    it(`${p.id} aggregates into valid merchants`, () => {
      const txns = parseCsv(readFileSync(`personas/${p.file}`, "utf8"));
      expect(txns.length).toBeGreaterThan(20);
      const ms = aggregateTransactions(txns);
      expect(ms.length).toBeGreaterThan(8);
      for (const m of ms) expect(MerchantAggregateSchema.safeParse(m).success).toBe(true);
      const total = txns.filter((t) => t.amount > 0).reduce((a, t) => a + t.amount, 0);
      expect(ms.reduce((a, m) => a + m.totalSpend, 0)).toBeCloseTo(total, 1);
    });
  }
});

describe("embedded persona data", () => {
  it("matches the CSV files (run npm run personas:embed after edits)", async () => {
    const { PERSONA_CSV } = await import("./data");
    const { loadPersona } = await import(".");
    for (const p of PERSONAS) {
      expect(PERSONA_CSV[p.id]).toBe(readFileSync(`personas/${p.file}`, "utf8"));
      expect(loadPersona(p.id)?.merchants.length).toBeGreaterThan(8);
    }
    expect(loadPersona("nope")).toBeUndefined();
  });
});
