import { and, asc, count, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Database, Tx } from "@/db";
import { documents, events, storageDeletions, storageUsage } from "@/db/schema";
import { reconcileUsage } from "./storage-quota";
import { documentsPrefix, isValidKey, isValidPrefix, type ObjectStore } from "./storage";

/**
 * Deleting objects from storage (EVT-07/09, ADR-0030/0033). Rows are queued in the same
 * transaction as the database delete, so a crash can't leave files behind; the daily job (and
 * callers that want it sooner) delete them from the store.
 */

const BACKOFF_MIN = [5, 30, 120, 720, 1440];

/** Queues an object key or an `events/<id>/...` prefix (ending in "/") for deletion. */
export async function queueStorageDeletion(tx: Tx, prefixOrKey: string, reason: string) {
  if (!isValidKey(prefixOrKey) && !isValidPrefix(prefixOrKey)) throw new Error(`bad storage prefix: ${prefixOrKey}`);
  const [row] = await tx.insert(storageDeletions).values({ prefix: prefixOrKey, reason }).returning({ id: storageDeletions.id });
  return row.id;
}

async function deleteOne(store: ObjectStore, prefix: string) {
  if (isValidPrefix(prefix)) return store.deleteByPrefix(prefix);
  await store.delete(prefix);
  return 1;
}

/** Tries queued deletions right away (e.g. after a single document delete); failures stay queued. */
export async function runStorageDeletions(db: Database, store: ObjectStore, ids: number[]) {
  if (ids.length === 0) return;
  const rows = await db.select().from(storageDeletions).where(inArray(storageDeletions.id, ids));
  for (const r of rows) {
    try {
      await deleteOne(store, r.prefix);
      await db.delete(storageDeletions).where(eq(storageDeletions.id, r.id));
    } catch {
      // Left for the daily job.
    }
  }
}

/** Daily GC: deletes due prefixes; claims rows with a lease so parallel runs don't collide. */
export async function processStorageDeletions(db: Database, store: ObjectStore, now = new Date(), opts: { limit?: number; budgetMs?: number } = {}) {
  const started = Date.now();
  const claimed = await db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(storageDeletions)
      .where(lte(storageDeletions.nextAttemptAt, now))
      .orderBy(asc(storageDeletions.nextAttemptAt))
      .limit(opts.limit ?? 200)
      .for("update", { skipLocked: true });
    if (due.length) {
      await tx
        .update(storageDeletions)
        .set({ nextAttemptAt: new Date(now.getTime() + 15 * 60_000) })
        .where(inArray(storageDeletions.id, due.map((d) => d.id)));
    }
    return due;
  });
  let done = 0;
  for (const row of claimed) {
    if (opts.budgetMs && Date.now() - started > opts.budgetMs) break;
    try {
      await deleteOne(store, row.prefix);
      await db.delete(storageDeletions).where(eq(storageDeletions.id, row.id));
      done++;
    } catch (e) {
      const wait = BACKOFF_MIN[Math.min(row.attempts, BACKOFF_MIN.length - 1)];
      await db
        .update(storageDeletions)
        .set({ attempts: row.attempts + 1, lastError: String((e as Error)?.message ?? e).slice(0, 500), nextAttemptAt: new Date(now.getTime() + wait * 60_000) })
        .where(eq(storageDeletions.id, row.id));
    }
  }
  return done;
}

/**
 * Daily: for the events reconciled longest ago, reset the usage counter from the database and
 * delete document objects no row points at any more (their row went with a cascaded delete, e.g.
 * a vendor or invoice). Objects younger than a day are left alone (uploads in flight).
 */
export async function reconcileStorage(db: Database, store: ObjectStore, now = new Date(), opts: { limit?: number; budgetMs?: number } = {}) {
  const started = Date.now();
  const overBudget = () => opts.budgetMs != null && Date.now() - started > opts.budgetMs;
  const due = await db
    .select({ id: events.id })
    .from(events)
    .leftJoin(storageUsage, eq(storageUsage.eventId, events.id))
    .where(isNull(events.deletedAt))
    .orderBy(sql`${storageUsage.reconciledAt} asc nulls first`)
    .limit(opts.limit ?? 25);
  let n = 0;
  for (const { id } of due) {
    if (overBudget()) break;
    await db.transaction((tx) => reconcileUsage(tx, id, now));
    const known = new Set(
      (await db.select({ k: documents.storageKey }).from(documents).where(and(eq(documents.eventId, id), sql`${documents.storageKey} is not null`))).map((r) => r.k!),
    );
    for await (const o of store.list(documentsPrefix(id))) {
      if (overBudget()) break;
      if (!known.has(o.key) && now.getTime() - o.uploadedAt.getTime() > 24 * 3600_000) await store.delete(o.key);
    }
    n++;
  }
  return n;
}

/** Deletions that keep failing (this many attempts or more) are shown to the App Admin. */
export const STUCK_ATTEMPTS = 5;

/** App Admin dashboard: how many queued storage deletions keep failing (store outage, bad prefix). */
export async function stuckStorageDeletions(db: Tx): Promise<number> {
  const [r] = await db.select({ n: count() }).from(storageDeletions).where(gte(storageDeletions.attempts, STUCK_ATTEMPTS));
  return r?.n ?? 0;
}
