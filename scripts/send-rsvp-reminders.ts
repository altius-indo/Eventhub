import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/db/schema";
import { sendRsvpReminders } from "../src/lib/rsvp";

/** Reminds families who haven't replied, in the 14 days before the RSVP deadline, every 3 days. Run daily. */
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const n = await sendRsvpReminders(drizzle(pool, { schema }), (process.env.APP_URL ?? "").replace(/\/$/, ""));
  console.log(`Sent RSVP reminders to ${n} families.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
