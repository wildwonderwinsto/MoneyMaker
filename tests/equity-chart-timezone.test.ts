/**
 * The equity chart is drawn on the server (UTC on Render) and again in the browser (the
 * viewer's time zone). Its first render must not depend on the time zone, or React throws a
 * hydration error and redraws the page (production /paper, error #418, on every load).
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { EquityChart } from "@/components/charts/equity-chart";

const curve = [
  { t: "2026-11-11T03:10:00.000Z", equity: 1000 },
  { t: "2026-11-11T15:17:00.000Z", equity: 1012.5 },
];
const render = (timeZone: string) => {
  process.env.TZ = timeZone;
  return renderToString(createElement(EquityChart, { curve, fills: [], baseline: 1000 }));
};

const original = process.env.TZ;
afterEach(() => {
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
});

describe("EquityChart first render", () => {
  it("is the same whatever the machine's time zone", () => {
    const utc = render("UTC");
    expect(utc).toContain("3:17 PM"); // the snapshot's time is in the table
    expect(render("America/Chicago")).toBe(utc);
    expect(render("Asia/Tokyo")).toBe(utc);
  });
});
