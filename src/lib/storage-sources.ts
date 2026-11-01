import { and, eq, ne, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { documents, events, mediaItems } from "@/db/schema";

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
// Stored gallery originals by uploader type (GAL-02/03, ADR-0031). Uploads in flight are counted
// as reservations, not here; renditions (thumb/web WebP, a few % of the originals) aren't counted.
const galleryBytes = async (db: Tx, eventId: string, kind: "member" | "vendor" | "household") => {
  const [r] = await db
    .select({ n: sql<number>`coalesce(sum(${mediaItems.originalBytes}), 0)::bigint`.mapWith(Number) })
    .from(mediaItems)
    .where(and(eq(mediaItems.eventId, eventId), eq(mediaItems.uploaderKind, kind), ne(mediaItems.status, "uploading")));
  return r?.n ?? 0;
};
registerUsageSource({ key: "gallery.member", measure: (db, eventId) => galleryBytes(db, eventId, "member") });
registerUsageSource({ key: "gallery.vendor", measure: (db, eventId) => galleryBytes(db, eventId, "vendor") });
registerUsageSource({ key: "gallery.guest", measure: (db, eventId) => galleryBytes(db, eventId, "household") });

// Event logo (256px WebP under `events/<id>/branding/`), see `event-logo.ts`.
registerUsageSource({
  key: "branding",
  measure: async (db, eventId) => {
    const [r] = await db.select({ n: events.logoBytes }).from(events).where(eq(events.id, eventId));
    return r?.n ?? 0;
  },
});
