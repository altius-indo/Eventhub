import { eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { documents } from "@/db/schema";

/**
 * Usage sources: every kind of stored object that counts against an event's storage quota
 * (LIM-01 breakdown, reconciliation; ADR-0030).
 *
 * All sources are registered **in this module**, which `storage-quota.ts` imports. That way any
 * code path that reconciles usage (the daily job, `reconcileUsage`) always sees every source, and
 * the counter can never be reset to "documents only" because some feature module happened not to
 * be imported yet.
 *
 * To add a source (e.g. the gallery): register it below, next to the documents source, with a
 * `measure` that sums the bytes from the database, and add an i18n label at
 * `storage.sources.<key>` in both `en.ts` and `hi.ts`. Keep the measure a plain query on schema
 * tables (or import it from a module that does **not** import `storage-quota.ts`), so there is no
 * import cycle.
 */

export type UsageSource = { key: string; measure: (db: Tx, eventId: string) => Promise<number> };

const sources = new Map<string, UsageSource>();

/** Adds (or replaces, by key) a source. Prefer registering in this file; see the note above. */
export function registerUsageSource(source: UsageSource) {
  sources.set(source.key, source);
}

export function usageSources(): UsageSource[] {
  return [...sources.values()];
}

registerUsageSource({
  key: "documents",
  measure: async (db, eventId) => {
    const [r] = await db
      .select({ n: sql<number>`coalesce(sum(${documents.bytes}), 0)::bigint`.mapWith(Number) })
      .from(documents)
      .where(eq(documents.eventId, eventId));
    return r?.n ?? 0;
  },
});

// [M7 gallery usage source]
// The gallery registers its source(s) here, e.g.:
//   registerUsageSource({ key: "gallery.vendor", measure: async (db, eventId) => sumOfMediaBytes(db, eventId, "vendor") });
// with labels at `storage.sources["gallery.vendor"]` (en + hi).
