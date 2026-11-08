/**
 * Admin unlock hardening: the password limiter can't be dodged by rewriting a header the
 * client controls, and an admin cookie stops working after its 30 days.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const reqHeaders = new Map<string, string>();
const jar = new Map<string, string>();
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ refresh: () => {} }));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => reqHeaders.get(k.toLowerCase()) ?? null }),
  cookies: async () => ({
    get: (k: string) => (jar.has(k) ? { value: jar.get(k) } : undefined),
    set: (k: string, v: string) => jar.set(k, v),
    delete: (k: string) => jar.delete(k),
  }),
}));
vi.mock("@/lib/copy/tick", () => ({
  runTick: vi.fn(),
  executeHedge: vi.fn(),
  exitTrader: vi.fn(),
}));
vi.mock("@/lib/copy/runner", () => ({ notifyEngine: async () => {} }));
vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));

const saved = { ...process.env };
async function fresh() {
  Object.assign(process.env, {
    DATABASE_URL: "pglite:memory",
    ADMIN_PASSWORD: "correct horse",
    NEXT_RUNTIME: "nodejs",
    ENGINE_LOOP: "off",
  });
  vi.resetModules();
  reqHeaders.clear();
  jar.clear();
}
afterEach(() => {
  process.env = { ...saved };
  vi.useRealTimers();
});

describe("password guessing (#11)", () => {
  it("is limited even when the client rotates the first X-Forwarded-For entry", async () => {
    await fresh();
    const { unlockAction } = await import("@/app/actions");
    const results: string[] = [];
    for (let i = 0; i < 7; i++) {
      // The proxy appends the address it saw; everything to its left came from the client.
      reqHeaders.set("x-forwarded-for", `10.0.0.${i}, 203.0.113.7`);
      const f = new FormData();
      f.set("password", `guess ${i}`);
      results.push((await unlockAction(null, f)).message);
    }
    expect(results.slice(0, 5).every((m) => m === "Wrong password")).toBe(true);
    expect(results[6]).toMatch(/Too many/);
  });

  // Headers as received on Render (checked 2026-11-08): Cloudflare sets CF-Connecting-IP and
  // rejects requests that send their own; the right-most X-Forwarded-For entry is whichever
  // Render load balancer handled the request.
  const viaRender = (client: string, lb: number, forged = "6.6.6.6") => {
    reqHeaders.set("cf-connecting-ip", client);
    reqHeaders.set("x-forwarded-for", `${forged},${client}, 172.69.59.122, 10.27.210.${lb}`);
  };
  const attempt = async (password: string) => {
    const { unlockAction } = await import("@/app/actions");
    const f = new FormData();
    f.set("password", password);
    return (await unlockAction(null, f)).message;
  };

  it("on Render, limits one guesser even when requests land on different load balancers", async () => {
    await fresh();
    const results: string[] = [];
    for (let i = 0; i < 7; i++) {
      viaRender("24.144.35.220", i, `6.6.6.${i}`);
      results.push(await attempt(`guess ${i}`));
    }
    expect(results[6]).toMatch(/Too many/);
  });

  it("on Render, someone else's wrong guesses don't lock the owner out", async () => {
    await fresh();
    for (let i = 0; i < 6; i++) {
      viaRender("198.51.100.9", 178);
      await attempt(`guess ${i}`);
    }
    viaRender("24.144.35.220", 178);
    expect(await attempt("correct horse")).toBe("Unlocked");
  });
});

describe("the admin cookie (UI-03)", () => {
  async function unlock() {
    const { unlockAction } = await import("@/app/actions");
    const f = new FormData();
    f.set("password", "correct horse");
    expect((await unlockAction(null, f)).ok).toBe(true);
    return import("@/lib/admin");
  }

  it("expires 30 days after it was issued", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await fresh();
    const { isAdmin } = await unlock();
    vi.setSystemTime(Date.now() + 29 * 86_400_000);
    expect(await isAdmin()).toBe(true);
    vi.setSystemTime(Date.now() + 2 * 86_400_000);
    expect(await isAdmin()).toBe(false);
  });

  it("can't be extended by editing its issue time", async () => {
    await fresh();
    const { isAdmin, ADMIN_COOKIE } = await unlock();
    const value = jar.get(ADMIN_COOKIE)!;
    const forged = value.replace(/^\d+/, String(Date.now() + 86_400_000));
    expect(forged).not.toBe(value);
    jar.set(ADMIN_COOKIE, forged);
    expect(await isAdmin()).toBe(false);
  });
});
