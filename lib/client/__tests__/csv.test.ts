import { describe, expect, it } from "vitest";
import { detectDelimiter, parseCsv } from "../csv";

describe("parseCsv", () => {
  it("handles quotes, doubled quotes, embedded commas and newlines", () => {
    const rows = parseCsv('a,b,c\r\n"x, y","he said ""hi""","multi\nline"\n');
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["x, y", 'he said "hi"', "multi\nline"],
    ]);
  });
  it("strips a BOM, drops blank lines and keeps a last line without newline", () => {
    expect(parseCsv("﻿a,b\n\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
  it("detects semicolon and tab delimiters", () => {
    expect(detectDelimiter("date;merchant;amount\n2026-09-01;Cafe;4,50")).toBe(";");
    expect(detectDelimiter("date\tmerchant\tamount\n2026-09-01\tCafe\t4.50")).toBe("\t");
    expect(detectDelimiter('date,merchant,amount\n2026-09-01,"A; B",4.50')).toBe(",");
  });
});
