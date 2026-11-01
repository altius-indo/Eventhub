import "dotenv/config";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/db/schema";
import { documentBlobs, documents } from "../src/db/schema";
import { documentKey, getStore } from "../src/lib/storage";

/**
 * One-off (ADR-0030): copies document bytes from `document_blobs` (ADR-0018) to object storage,
 * sets `documents.storage_key` and deletes the blob row. Safe to re-run: it only touches rows
 * without a key, and each row is moved in its own transaction after the upload succeeded.
 *
 *   npx tsx scripts/migrate-documents-to-store.ts [--dry-run] [--limit N]
 *
 * Uses DATABASE_URL and the configured store (BLOB_READ_WRITE_TOKEN in production).
 */
async function main() {
  const dry = process.argv.includes("--dry-run");
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });
  const store = getStore();
  let moved = 0;
  for (;;) {
    if (moved >= limit) break;
    const batch = await db.select({ id: documents.id, eventId: documents.eventId, mime: documents.mime }).from(documents).where(isNull(documents.storageKey)).limit(50);
    if (batch.length === 0) break;
    for (const doc of batch) {
      if (moved >= limit) break;
      const [blob] = await db.select().from(documentBlobs).where(eq(documentBlobs.documentId, doc.id));
      if (!blob) {
        console.warn(`document ${doc.id} has neither a key nor bytes; skipped`);
        continue;
      }
      const key = documentKey(doc.eventId, doc.id);
      if (dry) {
        console.log(`would move ${doc.id} (${blob.data.length} bytes) to ${key}`);
        moved++;
        continue;
      }
      await store.put(key, blob.data, doc.mime);
      await db.transaction(async (tx) => {
        const set = await tx
          .update(documents)
          .set({ storageKey: key })
          .where(and(eq(documents.id, doc.id), isNull(documents.storageKey)))
          .returning({ id: documents.id });
        if (set.length) await tx.delete(documentBlobs).where(eq(documentBlobs.documentId, doc.id));
      });
      moved++;
    }
    if (dry) break;
  }
  console.log(`${dry ? "Would move" : "Moved"} ${moved} document(s) to ${store.driver} storage.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
