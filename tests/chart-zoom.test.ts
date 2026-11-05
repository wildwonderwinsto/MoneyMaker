import { describe, expect, it } from "vitest";

import {
  clampWindow,
  isFullWindow,
  panBy,
  spanWithin,
  zoomAt,
  type ZoomBounds,
} from "@/components/charts/zoom";

const b: ZoomBounds = { min: 0, max: 100, minSpan: 5 };

describe("chart zoom math", () => {
  it("keeps the span between the minimum and the full range", () => {
    expect(spanWithin(1, b)).toBe(5);
    expect(spanWithin(500, b)).toBe(100);
    expect(spanWithin(40, b)).toBe(40);
    // A range narrower than minSpan can't be zoomed at all.
    expect(spanWithin(1, { min: 0, max: 2, minSpan: 5 })).toBe(2);
  });

  it("zooms around the anchor so the value under the cursor stays put", () => {
    const w = zoomAt({ lo: 0, hi: 100 }, 0.5, 0.25, b);
    expect(w.hi - w.lo).toBe(50);
    // Value at 25% before (25) is still at 25% after.
    expect(w.lo + 0.25 * (w.hi - w.lo)).toBeCloseTo(25);
  });

  it("stops at the minimum span and at the full range", () => {
    expect(zoomAt({ lo: 40, hi: 50 }, 0.01, 0.5, b)).toEqual({ lo: 42.5, hi: 47.5 });
    expect(zoomAt({ lo: 40, hi: 60 }, 100, 0.5, b)).toEqual({ lo: 0, hi: 100 });
  });

  it("slides back inside the bounds instead of showing empty space", () => {
    expect(zoomAt({ lo: 0, hi: 20 }, 2, 0, b)).toEqual({ lo: 0, hi: 40 });
    expect(zoomAt({ lo: 80, hi: 100 }, 2, 1, b)).toEqual({ lo: 60, hi: 100 });
    expect(clampWindow({ lo: -10, hi: 10 }, b)).toEqual({ lo: 0, hi: 20 });
    expect(clampWindow({ lo: 95, hi: 115 }, b)).toEqual({ lo: 80, hi: 100 });
  });

  it("pans by window widths and stops at the edges", () => {
    expect(panBy({ lo: 20, hi: 40 }, 0.5, b)).toEqual({ lo: 30, hi: 50 });
    expect(panBy({ lo: 20, hi: 40 }, -5, b)).toEqual({ lo: 0, hi: 20 });
    expect(panBy({ lo: 70, hi: 90 }, 5, b)).toEqual({ lo: 80, hi: 100 });
  });

  it("treats the whole range as not zoomed", () => {
    expect(isFullWindow({ lo: 0, hi: 100 }, b)).toBe(true);
    expect(isFullWindow({ lo: 0, hi: 90 }, b)).toBe(false);
  });
});
