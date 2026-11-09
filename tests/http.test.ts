import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  buildUrl,
  fetchJson,
  HttpError,
  httpStats,
  RateLimiter,
  retryAfterMs,
  SchemaError,
} from "@/lib/http";

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

  it("caps a huge Retry-After at 30 s, for the request and the shared limiter", async () => {
    // Regression (A4): Retry-After was honored as sent; one 429 asking for an hour stalled
    // the request and paused the limiter shared by every other call for that hour.
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(4, 0);
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response("slow down", { status: 429, headers: { "retry-after": "3600" } }),
        )
        .mockImplementation(async () => Response.json({ ok: true }));
      let first = false;
      void fetchJson("https://x.test/a", { schema, limiter }).then(() => (first = true));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(first).toBe(true);
      let second = false;
      void fetchJson("https://x.test/b", { schema, limiter }).then(() => (second = true));
      await vi.advanceTimersByTimeAsync(1);
      expect(second).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts requests, 429s, retries and time spent waiting (daily job timing logs)", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
      )
      .mockResolvedValueOnce(new Response("oops", { status: 503, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const before = httpStats();
    await fetchJson("https://x.test/a", { schema });
    const after = httpStats();
    expect(after.requests - before.requests).toBe(3);
    expect(after.rateLimited - before.rateLimited).toBe(1);
    expect(after.retries - before.retries).toBe(2);
    expect(after.retryWaitMs - before.retryWaitMs).toBeGreaterThanOrEqual(0);
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
