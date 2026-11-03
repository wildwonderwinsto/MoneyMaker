import { runMigrations } from "@/lib/db/migrate";
import { env } from "@/lib/env";

async function main() {
  const url = env().DATABASE_URL;
  const target = url.startsWith("pglite:") ? url : url.replace(/\/\/[^@]*@/, "//***@");
  console.log(`Applying migrations to ${target} ...`);
  await runMigrations(url);
  console.log("Migrations applied.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
