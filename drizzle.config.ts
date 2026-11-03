import { defineConfig } from "drizzle-kit";

// drizzle-kit is only used to *generate* SQL migrations from src/lib/db/schema.ts.
// Applying them is done by `npm run db:migrate` (src/scripts/migrate.ts), which
// works for both Supabase Postgres and local PGlite.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
  strict: true,
  verbose: true,
});
