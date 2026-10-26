import { describe, expect, it } from "vitest";
import { barRows, coveredRows, overlap } from "../cover";

// a probe row: [x0, y0, x1, y1, receipt (0 ours, 1 the model's), line, from TOTAL down, 3D occluder]
const row = (x0: number, y0: number, x1: number, y1: number, li = 3, fromTotal = 0) => [x0, y0, x1, y1, 0, li, fromTotal, 0];
const view = { w: 1920, h: 1080 };

describe("M8 cover", () => {
  it("measures the overlap of two rects both ways, 0 when apart", () => {
    expect(overlap({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 6, y0: 8, x1: 20, y1: 20 })).toEqual({ ox: 4, oy: 2 });
    expect(overlap({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 12, y0: 0, x1: 20, y1: 10 })).toEqual({ ox: 0, oy: 10 });
  });

  it("reports the overlay that covers a row most, with its kind, and lets a touch within the tolerance pass", () => {
    const rows = [row(100, 100, 500, 120, 3), row(100, 130, 500, 150, 4, 1)];
    const overlays = [
      { kind: "tip", r: { x0: 480, y0: 98, x1: 700, y1: 122 } }, // 20 px over row 3's right end
      { kind: "slip", r: { x0: 300, y0: 95, x1: 600, y1: 125 } }, // more of row 3
      { kind: "caption", r: { x0: 498, y0: 130, x1: 900, y1: 150 } }, // 2 px: a side bearing, not a cover
    ];
    expect(coveredRows(rows, overlays, view)).toEqual([{ which: 0, li: 3, fromTotal: 0, kind: "slip", ox: 200, oy: 20 }]);
  });

  it("judges only the part of a row inside the frame", () => {
    const strip = [{ kind: "strip", r: { x0: 0, y0: 0, x1: 1920, y1: 90 } }];
    expect(coveredRows([row(100, -40, 500, -20)], strip, view)).toEqual([]); // above the frame: not on screen
    expect(coveredRows([row(100, -10, 500, 10, 9, 1)], strip, view)).toEqual([{ which: 0, li: 9, fromTotal: 1, kind: "strip", ox: 400, oy: 10 }]);
  });

  it("passes a row under the bar while its veil is up, and never one under the strip's text unveiled (v13)", () => {
    const nav = [{ x0: 180, y0: 36, x1: 660, y1: 58 }], band = { ...view, top: 90 };
    const under = row(650, 50, 1260, 70, 2), clear = row(650, 120, 1260, 140, 5);
    expect(barRows([under, clear], nav, band, { a: 1, y1: 90 })).toEqual([]); // faded under the veil, the nav's text over it
    expect(barRows([under, clear], nav, band, { a: 0, y1: 90 })).toEqual([{ which: 0, li: 2, fromTotal: 0, kind: "strip", ox: 10, oy: 8 }]);
    expect(barRows([row(900, 60, 1260, 80, 2)], nav, band, { a: 0.2, y1: 90 })).toEqual([{ which: 0, li: 2, fromTotal: 0, kind: "bar", ox: 360, oy: 20 }]); // in the band, unveiled
    expect(barRows([row(100, 100, 500, 120, 7)], [{ x0: 0, y0: 95, x1: 600, y1: 125 }], band, { a: 1, y1: 90 })).toEqual([{ which: 0, li: 7, fromTotal: 0, kind: "strip", ox: 400, oy: 20 }]); // strip ink below the veil
  });
});
