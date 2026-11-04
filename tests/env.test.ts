import { describe, expect, it } from "vitest";

import { EnvSchema } from "@/lib/env";

describe("EnvSchema", () => {
  it("defaults to a local PGlite database in development", () => {
    expect(EnvSchema.parse({}).DATABASE_URL).toMatch(/^pglite:/);
  });

  it("refuses an ephemeral local database in production", () => {
    expect(EnvSchema.safeParse({ NODE_ENV: "production" }).success).toBe(false);
    const ok = EnvSchema.safeParse({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
    });
    expect(ok.success).toBe(true);
  });

  it("requires a strong cron secret when one is set", () => {
    expect(EnvSchema.safeParse({ CRON_SECRET: "short" }).success).toBe(false);
  });

  it("treats blank values copied from .env.example as unset", () => {
    const parsed = EnvSchema.parse({ CRON_SECRET: "", ADMIN_PASSWORD: "" });
    expect(parsed.CRON_SECRET).toBeUndefined();
    expect(parsed.ADMIN_PASSWORD).toBeUndefined();
  });
});
