/**
 * Concurrent migrations (audit J13): Render's build and the daily workflow both run
 * `db:migrate`; two runs at once must not both apply the same migration. On Postgres the
 * run holds an advisory lock. (No local Postgres: the client and migrator are stubbed and
 * the order of calls is checked; the blocking itself is Postgres's.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let failMigrate = false;
vi.mock("postgres", () => ({
  default: () => {
    const sql = (strings: TemplateStringsArray) => {
      calls.push(strings.join("?").trim());
      return Promise.resolve([]);
    };
    sql.end = async () => calls.push("end");
    return sql;
  },
}));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: () => ({}) }));
vi.mock("drizzle-orm/postgres-js/migrator", () => ({
  migrate: async () => {
    calls.push("migrate");
    if (failMigrate) throw new Error("boom");
  },
}));

beforeEach(() => {
  calls.length = 0;
  failMigrate = false;
});

describe("migration lock (J13)", () => {
  it("holds an advisory lock around the migrations on Postgres", async () => {
    const { runMigrations } = await import("@/lib/db/migrate");
    await runMigrations("postgres://u:p@db.example.com:5432/x");
    const lock = calls.findIndex((c) => c.startsWith("select pg_advisory_lock"));
    const run = calls.indexOf("migrate");
    const unlock = calls.findIndex((c) => c.startsWith("select pg_advisory_unlock"));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(run);
    expect(unlock).toBeGreaterThan(run);
  });

  it("releases the lock when a migration fails", async () => {
    const { runMigrations } = await import("@/lib/db/migrate");
    failMigrate = true;
    await expect(runMigrations("postgres://u:p@db.example.com:5432/x")).rejects.toThrow("boom");
    expect(calls.some((c) => c.startsWith("select pg_advisory_unlock"))).toBe(true);
  });
});
