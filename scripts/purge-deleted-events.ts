import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/db/schema";
import { purgeDeletedEvents } from "../src/lib/events";

/** Permanently deletes events whose 7-day undo window has passed. Run daily (e.g. cron). */
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const n = await purgeDeletedEvents(drizzle(pool, { schema }));
  console.log(`Purged ${n} deleted event(s).`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
