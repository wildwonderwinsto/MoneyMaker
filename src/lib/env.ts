import { z } from "zod";

/**
 * Server-side environment, validated lazily on first access so that `next build`
 * and unit tests do not require secrets to be present.
 */
const EnvSchema = z.object({
  /**
   * Postgres connection string (Supabase *session pooler*, port 5432, works over IPv4),
   * or `pglite:<dir>` / `pglite:memory` for local development without a server.
   */
  DATABASE_URL: z.string().min(1).default("pglite:./.data/pglite"),
  /** Shared secret that cron-job.org sends in the `Authorization: Bearer` header. */
  CRON_SECRET: z.string().min(16).optional(),
  /** Password required for actions that change state from the dashboard. */
  ADMIN_PASSWORD: z.string().min(8).optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof EnvSchema>;

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
