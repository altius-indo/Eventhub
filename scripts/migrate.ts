import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { databaseUrl } from "../src/db/url";

async function main() {
  // A direct (unpooled) connection is preferred for migrations where one exists (Neon on Vercel).
  // Preview builds migrate only the preview database, never production (ADR-0035).
  const url = process.argv[2] ?? databaseUrl("unpooled");
  console.log(`Migrating ${process.env.VERCEL_ENV === "preview" ? "the PREVIEW database" : "DATABASE_URL"}${process.env.VERCEL_ENV ? ` (VERCEL_ENV=${process.env.VERCEL_ENV})` : ""}.`);
  const pool = new Pool({ connectionString: url });
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  await pool.end();
  console.log("Migrations applied.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
