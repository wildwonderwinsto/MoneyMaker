/** Display formatting that the mobile layout depends on (owner, 2026-11-10). */
import { describe, expect, it } from "vitest";

import { axisUsd, dateLabel, monthlyCumulative } from "@/lib/format";

describe("axisUsd: chart axis labels", () => {
  it("is short and in one style at every scale", () => {
    // The monthly P&L axis used to read "$19.5K, $13K, $6,500.00, $0.00, -$6,500.00".
    expect([19_500, 13_000, 6_500, 0, -6_500].map(axisUsd)).toEqual([
      "$19.5K",
      "$13K",
      "$6,500",
      "$0",
      "−$6,500",
    ]);
    // An equity axis around $1,000 keeps whole dollars ("$1K" would hide the change).
    expect([1_001, 994, 987.4].map(axisUsd)).toEqual(["$1,001", "$994", "$987"]);
    expect(axisUsd(250)).toBe("$250");
    expect(axisUsd(-0.2)).toBe("$0");
    expect(axisUsd(1_250_000)).toBe("$1.3M");
    for (const v of [-99_999, -6_500, 0, 999, 12_345, 987_654]) {
      expect(axisUsd(v).length).toBeLessThanOrEqual(7); // fits the 52px axis at 11px
    }
  });
});

describe("dateLabel: chart dates", () => {
  it("shows a calendar day as that day in every time zone (not the day before in the US)", () => {
    const saved = process.env.TZ;
    try {
      for (const tz of ["America/Los_Angeles", "UTC", "Asia/Tokyo"]) {
        process.env.TZ = tz;
        expect(dateLabel("2026-11-04")).toBe("Nov 4");
        expect(dateLabel("2026-05")).toBe("May 2026"); // a month (pruned history fallback)
      }
    } finally {
      process.env.TZ = saved;
    }
  });

  it("keeps instants in local time and leaves unknown text alone", () => {
    expect(dateLabel("not a date")).toBe("not a date");
    expect(dateLabel(new Date(2026, 10, 4, 12).toISOString())).toBe("Nov 4");
  });
});

describe("monthlyCumulative: cumulative profit from monthly P&L", () => {
  it("runs the months into a cumulative line", () => {
    expect(
      monthlyCumulative([
        { month: "2026-03", pnl: 100 },
        { month: "2026-04", pnl: -40 },
        { month: "2026-05", pnl: 15.5 },
      ]),
    ).toEqual([
      { t: "2026-03", pnl: 100 },
      { t: "2026-04", pnl: 60 },
      { t: "2026-05", pnl: 75.5 },
    ]);
    expect(monthlyCumulative(undefined)).toEqual([]);
  });
});
