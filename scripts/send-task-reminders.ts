import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/db/schema";
import { sendTaskReminders } from "../src/lib/tasks";
import { resolveAppUrl } from "../src/lib/app-url";

/** Emails/texts assignees about tasks due by tomorrow or overdue. Run daily, e.g. 8:00 IST. */
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const n = await sendTaskReminders(drizzle(pool, { schema }), new Date(), resolveAppUrl());
  console.log(`Sent task reminders to ${n} people.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
