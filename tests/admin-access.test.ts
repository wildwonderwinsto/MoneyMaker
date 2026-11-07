/**
 * Without ADMIN_PASSWORD, the dashboard is only open for local development against the
 * embedded PGlite database. Pointed at a real Postgres (e.g. production Supabase) it must
 * fail closed: admin actions locked, cron locked, and the server refuses to start.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ refresh: () => {} }));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
const runTick = vi.fn(async () => ({ errors: [] }));
vi.mock("@/lib/copy/tick", () => ({ runTick, executeHedge: vi.fn(), exitTrader: vi.fn() }));
vi.mock("@/lib/copy/runner", () => ({
  getRunner: () => ({ isRunning: false }),
  notifyEngine: async () => {},
  startEngine: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));

const REMOTE = "postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
const saved = { ...process.env };

/** Fresh modules so env() re-reads process.env. */
async function withEnv(vars: Record<string, string | undefined>) {
  for (const k of ["DATABASE_URL", "ADMIN_PASSWORD", "CRON_SECRET", "NODE_ENV", "NEXT_PHASE"]) {
    delete process.env[k];
  }
  Object.assign(process.env, { NEXT_RUNTIME: "nodejs", ENGINE_LOOP: "off" });
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  vi.resetModules();
}

afterEach(() => {
  process.env = { ...saved };
  runTick.mockClear();
});

describe("no ADMIN_PASSWORD", () => {
  it("locks admin actions when the database is not PGlite (even in development)", async () => {
    await withEnv({ DATABASE_URL: REMOTE, NODE_ENV: "development" });
    const { isAdmin } = await import("@/lib/admin");
    expect(await isAdmin()).toBe(false);
    const { resetPaperAction } = await import("@/app/actions");
    const f = new FormData();
    f.set("balance", "10");
    expect((await resetPaperAction(null, f)).ok).toBe(false);
  });

  it("stays open for local development on PGlite", async () => {
    await withEnv({ DATABASE_URL: "pglite:memory", NODE_ENV: "development" });
    const { isAdmin } = await import("@/lib/admin");
    expect(await isAdmin()).toBe(true);
  });

  it("refuses to start the server against a non-PGlite database", async () => {
    await withEnv({ DATABASE_URL: REMOTE, NODE_ENV: "development" });
    const { register } = await import("@/instrumentation");
    await expect(register()).rejects.toThrow(/ADMIN_PASSWORD/);
  });

  it("starts normally against PGlite, and against Postgres once a password is set", async () => {
    await withEnv({ DATABASE_URL: "pglite:memory", NODE_ENV: "development" });
    await expect((await import("@/instrumentation")).register()).resolves.toBeUndefined();
    await withEnv({ DATABASE_URL: REMOTE, NODE_ENV: "development", ADMIN_PASSWORD: "a-long-pass" });
    await expect((await import("@/instrumentation")).register()).resolves.toBeUndefined();
  });
});

describe("no CRON_SECRET", () => {
  it("rejects cron calls when the database is not PGlite (even in development)", async () => {
    await withEnv({ DATABASE_URL: REMOTE, NODE_ENV: "development", ADMIN_PASSWORD: "a-long-pass" });
    const { GET } = await import("@/app/api/cron/tick/route");
    const res = await GET(new Request("http://localhost/api/cron/tick"));
    expect(res.status).toBe(503);
    expect(runTick).not.toHaveBeenCalled();
  });

  it("stays open for local development on PGlite", async () => {
    await withEnv({ DATABASE_URL: "pglite:memory", NODE_ENV: "development" });
    const { GET } = await import("@/app/api/cron/tick/route");
    const res = await GET(new Request("http://localhost/api/cron/tick"));
    expect(res.status).toBe(200);
    expect(runTick).toHaveBeenCalledOnce();
  });
});
