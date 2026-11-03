import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/db/schema";
import { sendPaymentReminders } from "../src/lib/payments";

/** Daily job (run e.g. 8:00 IST): see sendPaymentReminders in src/lib/payments.ts. */
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const n = await sendPaymentReminders(drizzle(pool, { schema }), new Date(), (process.env.APP_URL ?? "").replace(/\/$/, ""));
  console.log(`Sent payment reminders: ${n}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
