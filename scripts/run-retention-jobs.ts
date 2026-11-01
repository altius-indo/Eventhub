import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/db/schema";
import { purgeExpiredEvents, sendRetentionReminders } from "../src/lib/retention";
import { getStore } from "../src/lib/storage";
import { processStorageDeletions, reconcileStorage } from "../src/lib/storage-gc";
import { releaseExpiredReservations } from "../src/lib/storage-quota";
import "../src/lib/templates";

/** Daily retention jobs (EVT-07/08, ADR-0033) for hosts without the /api/cron/daily route. */
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });
  const now = new Date();
  const reminded = await sendRetentionReminders(db, now);
  const purged = await purgeExpiredEvents(db, now);
  const released = await releaseExpiredReservations(db, now);
  const deleted = await processStorageDeletions(db, getStore(), now);
  const reconciled = await reconcileStorage(db, getStore(), now);
  console.log(`Retention: reminded ${reminded}, purged ${purged}, storage deletions ${deleted}, reconciled ${reconciled}, expired reservations ${released}.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
