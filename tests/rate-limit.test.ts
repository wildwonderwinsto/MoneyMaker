import { describe, expect, it } from "vitest";

import { allowAttempt, clearAttempts } from "@/lib/rate-limit";

describe("allowAttempt", () => {
  it("allows 5 password tries per 15 minutes, then blocks until the window ends", () => {
    const t = 1_000_000;
    for (let i = 0; i < 5; i++) expect(allowAttempt("ip-a", t)).toBe(true);
    expect(allowAttempt("ip-a", t + 1000)).toBe(false);
    expect(allowAttempt("ip-b", t + 1000)).toBe(true); // other visitors unaffected
    expect(allowAttempt("ip-a", t + 15 * 60_000 + 1)).toBe(true);
  });

  it("resets after a successful unlock", () => {
    for (let i = 0; i < 6; i++) allowAttempt("ip-c", 5);
    clearAttempts("ip-c");
    expect(allowAttempt("ip-c", 6)).toBe(true);
  });
});
