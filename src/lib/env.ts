import { z } from "zod";

/** Treat `KEY=` (empty, as in .env.example) the same as an unset variable. */
const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema);

/**
 * Server-side environment, validated lazily on first access so that `next build`
 * and unit tests do not require secrets to be present.
 */
export const EnvSchema = z
  .object({
    /**
     * Postgres connection string (Supabase *session pooler*, port 5432, works over IPv4),
     * or `pglite:<dir>` / `pglite:memory` for local development without a server.
     */
    DATABASE_URL: z.string().min(1).default("pglite:./.data/pglite"),
    /** Shared secret that cron-job.org sends in the `Authorization: Bearer` header. */
    CRON_SECRET: blankAsUnset(z.string().min(16).optional()),
    /** Password required for actions that change state from the dashboard. */
    ADMIN_PASSWORD: blankAsUnset(z.string().min(8).optional()),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  })
  .refine((e) => !(e.NODE_ENV === "production" && e.DATABASE_URL.startsWith("pglite:")), {
    // Render's disk is wiped on every restart: a local database would silently lose data.
    message: "DATABASE_URL must point to Postgres (Supabase) in production",
    path: ["DATABASE_URL"],
  });

export type Env = z.infer<typeof EnvSchema>;

/**
 * Whether a missing ADMIN_PASSWORD / CRON_SECRET may leave things open: only for local
 * development on the embedded PGlite database. Against any real Postgres (e.g. a
 * production URL copied into a local .env) everything fails closed.
 */
export function allowsOpenAccess(e: Pick<Env, "DATABASE_URL" | "NODE_ENV">): boolean {
  return e.NODE_ENV !== "production" && e.DATABASE_URL.startsWith("pglite:");
}

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(`Invalid environment variables:\n${z.prettifyError(parsed.error)}`);
    }
    cached = parsed.data;
  }
  return cached;
}
