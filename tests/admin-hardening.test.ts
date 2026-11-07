/**
 * Admin unlock hardening: the password limiter can't be dodged by rewriting a header the
 * client controls, and an admin cookie stops working after its 30 days.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const reqHeaders = new Map<string, string>();
const jar = new Map<string, string>();
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ refresh: () => {} }));
// No request scope under vitest; in Next it just marks the route as per-request.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));
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

describe("temporary X-Forwarded-For check (#11)", () => {
  const call = async () => {
    const { GET } = await import("@/app/api/admin/forwarded/route");
    return GET(
      new Request("http://localhost/api/admin/forwarded", {
        headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.7", "x-real-ip": "203.0.113.7" },
      }),
    );
  };

  it("is admin-only", async () => {
    await fresh();
    expect((await call()).status).toBe(401);
  });

  it("shows the client-IP headers as received and the key the limiter uses", async () => {
    await fresh();
    const { unlockAction } = await import("@/app/actions");
    const f = new FormData();
    f.set("password", "correct horse");
    expect((await unlockAction(null, f)).ok).toBe(true);
    const body = (await (await call()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      "x-forwarded-for": "6.6.6.6, 203.0.113.7",
      "x-real-ip": "203.0.113.7",
      limiterKey: "203.0.113.7",
    });
  });
});
