import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { buildUrl, fetchJson, HttpError, RateLimiter, retryAfterMs, SchemaError } from "@/lib/http";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildUrl", () => {
  it("repeats array params and drops nullish values", () => {
    const url = buildUrl("https://x.test", "/m", {
      id: ["a", "b"],
      closed: false,
      skip: undefined,
      n: null,
    });
    expect(url).toBe("https://x.test/m?id=a&id=b&closed=false");
  });
});

describe("retryAfterMs", () => {
  it("parses seconds and dates", () => {
    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs("garbage")).toBeUndefined();
    const future = new Date(Date.now() + 5000).toUTCString();
    expect(retryAfterMs(future)).toBeGreaterThan(3000);
  });
});

describe("fetchJson", () => {
  const schema = z.object({ ok: z.boolean() });

  it("retries 429 honoring Retry-After, then succeeds", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await expect(fetchJson("https://x.test/a", { schema })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry 4xx client errors", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("bad", { status: 400 }));
    await expect(fetchJson("https://x.test/a", { schema })).rejects.toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws SchemaError on unexpected shapes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: "yes" }));
    await expect(fetchJson("https://x.test/a", { schema })).rejects.toBeInstanceOf(SchemaError);
  });
});

describe("RateLimiter", () => {
  it("never exceeds max concurrency", async () => {
    const limiter = new RateLimiter(2, 0);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        limiter.run(async () => {
          peak = Math.max(peak, ++active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});
