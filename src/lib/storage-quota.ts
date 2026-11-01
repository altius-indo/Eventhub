import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import type { Database, Tx } from "@/db";
import { eventStorageOverrides, platformSettings, storageHouseholdUsage, storageReservations, storageUsage } from "@/db/schema";
import { usageSources } from "./storage-sources";

/**
 * Per-event storage quota (§4.1, LIM-01/03, ADR-0030).
 *
 * Flow for anything that stores bytes:
 * 1. `const r = await reserve(tx, eventId, bytes, audience, { householdId })` before uploading
 *    (row-locked, so concurrent uploads can't overshoot). Throws `StorageQuotaError` when it
 *    doesn't fit. The reservation is a row that expires (default 7 h, `ttlSeconds`).
 * 2. After the object is confirmed in the store:
 *    `commit(tx, eventId, reserved, actual, { householdId, reservationId: r.id })`.
 *    If the upload failed: `release(tx, eventId, reserved, { householdId, reservationId: r.id })`.
 *    If nobody calls either (the browser went away), the daily job gives the space back
 *    (`releaseExpiredReservations`). `reservationId` is optional; without it the oldest live
 *    reservation of the same size (and family) is used.
 * 3. When the object is deleted: `free(tx, eventId, bytes, { householdId })`.
 *
 * Rules (LIM-03): members and guests are blocked at 100% of the event limit; vendors may use a
 * 10% reserve (up to 110%) so professional deliveries are never lost. Guests are also capped per
 * household (300 items / 5 GB by default). Hosts are warned once at 80% and once at 95%.
 */

const GB = 1024 ** 3;
export const DEFAULT_STORAGE_LIMITS = { storageBytes: 250 * GB, guestItems: 300, guestBytes: 5 * GB };
export type StorageLimits = typeof DEFAULT_STORAGE_LIMITS;
/** Vendors may go this far over the event limit (LIM-03). */
export const VENDOR_RESERVE = 0.1;

export type Audience = "member" | "vendor" | "guest";

export class StorageQuotaError extends Error {
  constructor(
    public code: "storage_full" | "household_items" | "household_bytes" | "invalid",
    public remaining = 0,
  ) {
    super(code);
  }
}

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback);

/** Platform defaults (`platform_settings.limits` keys storageBytes/guestItems/guestBytes) + event overrides. */
export async function getStorageLimits(db: Tx, eventId: string): Promise<StorageLimits> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, "limits"));
  const v = (row?.value ?? {}) as Record<string, unknown>;
  const base: StorageLimits = {
    storageBytes: num(v.storageBytes, DEFAULT_STORAGE_LIMITS.storageBytes),
    guestItems: num(v.guestItems, DEFAULT_STORAGE_LIMITS.guestItems),
    guestBytes: num(v.guestBytes, DEFAULT_STORAGE_LIMITS.guestBytes),
  };
  const [o] = await db.select().from(eventStorageOverrides).where(eq(eventStorageOverrides.eventId, eventId));
  if (o?.storageBytes != null) base.storageBytes = o.storageBytes;
  if (o?.guestItems != null) base.guestItems = o.guestItems;
  if (o?.guestBytes != null) base.guestBytes = o.guestBytes;
  return base;
}

/** App Admin: per-event override (null keeps the platform default). */
export async function setStorageOverride(db: Tx, eventId: string, values: Partial<Record<keyof StorageLimits, number | null>>) {
  await db
    .insert(eventStorageOverrides)
    .values({ eventId, ...values })
    .onConflictDoUpdate({ target: eventStorageOverrides.eventId, set: values });
}

async function lockUsage(tx: Tx, eventId: string) {
  await tx.insert(storageUsage).values({ eventId }).onConflictDoNothing();
  const [row] = await tx.select().from(storageUsage).where(eq(storageUsage.eventId, eventId)).for("update");
  return row;
}

async function lockHousehold(tx: Tx, eventId: string, householdId: string) {
  await tx.insert(storageHouseholdUsage).values({ eventId, householdId }).onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(storageHouseholdUsage)
    .where(and(eq(storageHouseholdUsage.householdId, householdId), eq(storageHouseholdUsage.eventId, eventId)))
    .for("update");
  if (!row) throw new StorageQuotaError("invalid");
  return row;
}

/** The most an audience may fill: the limit, or limit + 10% for vendors. */
export function capFor(limit: number, audience: Audience) {
  return audience === "vendor" ? Math.floor(limit * (1 + VENDOR_RESERVE)) : limit;
}

export type ReserveOpts = {
  householdId?: string | null;
  items?: number;
  /**
   * How long the reservation holds if it is neither committed nor released (abandoned upload).
   * Default: the longest upload grant (6 h) plus an hour; then the space is given back.
   */
  ttlSeconds?: number;
  now?: Date;
};

/** What `reserve` returns: pass `id` to `commit`/`release` as `reservationId`. */
export type Reservation = { id: string; bytes: number; expiresAt: Date };

export const DEFAULT_RESERVATION_TTL_S = 7 * 3600;

type ReservationRow = typeof storageReservations.$inferSelect;

/** Takes reservation rows off the counters (event and household). The usage row must be locked. */
async function dropReservationCounters(tx: Tx, eventId: string, rows: ReservationRow[]) {
  if (rows.length === 0) return;
  const total = rows.reduce((a, r) => a + r.bytes, 0);
  await tx
    .update(storageUsage)
    .set({ reservedBytes: sql`greatest(0, ${storageUsage.reservedBytes} - ${total})` })
    .where(eq(storageUsage.eventId, eventId));
  for (const r of rows) {
    if (!r.householdId) continue;
    await tx
      .update(storageHouseholdUsage)
      .set({
        items: sql`greatest(0, ${storageHouseholdUsage.items} - ${r.items})`,
        bytes: sql`greatest(0, ${storageHouseholdUsage.bytes} - ${r.bytes})`,
      })
      .where(eq(storageHouseholdUsage.householdId, r.householdId));
  }
}

/** Gives back this event's expired reservations (call with the usage row locked). */
async function releaseExpiredFor(tx: Tx, eventId: string, now: Date) {
  const rows = await tx
    .delete(storageReservations)
    .where(and(eq(storageReservations.eventId, eventId), lte(storageReservations.expiresAt, now)))
    .returning();
  await dropReservationCounters(tx, eventId, rows);
  return rows.length;
}

/**
 * Finds and deletes the reservation a commit/release refers to: by id when given, otherwise (for
 * callers that don't pass one) the oldest one with the same size and family.
 * Returns the row; `null` when the id no longer exists (already given back, e.g. expired);
 * `undefined` when no id was given and nothing matched.
 */
async function takeReservation(tx: Tx, eventId: string, bytes: number, householdId: string | null | undefined, reservationId: string | undefined) {
  if (reservationId) {
    const [row] = await tx
      .delete(storageReservations)
      .where(and(eq(storageReservations.id, reservationId), eq(storageReservations.eventId, eventId)))
      .returning();
    return row ?? null;
  }
  const [match] = await tx
    .select({ id: storageReservations.id })
    .from(storageReservations)
    .where(
      and(
        eq(storageReservations.eventId, eventId),
        eq(storageReservations.bytes, bytes),
        householdId ? eq(storageReservations.householdId, householdId) : isNull(storageReservations.householdId),
      ),
    )
    .orderBy(asc(storageReservations.createdAt))
    .limit(1);
  if (!match) return undefined;
  const [row] = await tx.delete(storageReservations).where(eq(storageReservations.id, match.id)).returning();
  return row ?? undefined;
}

/**
 * Reserves space for an upload (call inside the transaction that records it). The reservation is
 * a row with an expiry, so an upload the browser abandons doesn't hold the space for ever.
 */
export async function reserve(tx: Tx, eventId: string, bytes: number, audience: Audience, opts: ReserveOpts = {}): Promise<Reservation> {
  if (!Number.isInteger(bytes) || bytes <= 0) throw new StorageQuotaError("invalid");
  const now = opts.now ?? new Date();
  let usage = await lockUsage(tx, eventId);
  if (await releaseExpiredFor(tx, eventId, now)) {
    [usage] = await tx.select().from(storageUsage).where(eq(storageUsage.eventId, eventId));
  }
  const limits = await getStorageLimits(tx, eventId);
  const remaining = capFor(limits.storageBytes, audience) - usage.usedBytes - usage.reservedBytes;
  if (bytes > remaining) throw new StorageQuotaError("storage_full", Math.max(0, remaining));
  const household = audience === "guest" && opts.householdId ? opts.householdId : null;
  const items = household ? (opts.items ?? 1) : 0;
  if (household) {
    const h = await lockHousehold(tx, eventId, household);
    if (h.items + items > limits.guestItems) throw new StorageQuotaError("household_items", Math.max(0, limits.guestItems - h.items));
    if (h.bytes + bytes > limits.guestBytes) throw new StorageQuotaError("household_bytes", Math.max(0, limits.guestBytes - h.bytes));
    await tx
      .update(storageHouseholdUsage)
      .set({ items: sql`${storageHouseholdUsage.items} + ${items}`, bytes: sql`${storageHouseholdUsage.bytes} + ${bytes}` })
      .where(eq(storageHouseholdUsage.householdId, household));
  }
  await tx
    .update(storageUsage)
    .set({ reservedBytes: sql`${storageUsage.reservedBytes} + ${bytes}` })
    .where(eq(storageUsage.eventId, eventId));
  const ttl = Math.max(60, Math.floor(opts.ttlSeconds ?? DEFAULT_RESERVATION_TTL_S));
  const expiresAt = new Date(now.getTime() + ttl * 1000);
  const [row] = await tx
    .insert(storageReservations)
    .values({ eventId, householdId: household, bytes, items, audience, expiresAt, createdAt: now })
    .returning({ id: storageReservations.id });
  return { id: row.id, bytes, expiresAt };
}

/**
 * Turns a reservation into usage. `actualBytes` (default: the reservation) is what was really
 * stored; for guests the household's bytes are corrected by the difference. Pass the
 * `reservationId` from `reserve` when you have it. If the reservation already expired (and was
 * given back), the object is counted as new usage.
 */
export async function commit(
  tx: Tx,
  eventId: string,
  reservedBytes: number,
  actualBytes = reservedBytes,
  opts: { householdId?: string | null; reservationId?: string; items?: number } = {},
) {
  await lockUsage(tx, eventId);
  const row = await takeReservation(tx, eventId, reservedBytes, opts.householdId, opts.reservationId);
  if (row === null) {
    await tx
      .update(storageUsage)
      .set({ usedBytes: sql`${storageUsage.usedBytes} + ${actualBytes}` })
      .where(eq(storageUsage.eventId, eventId));
    if (opts.householdId) {
      await tx.insert(storageHouseholdUsage).values({ eventId, householdId: opts.householdId }).onConflictDoNothing();
      await tx
        .update(storageHouseholdUsage)
        .set({ items: sql`${storageHouseholdUsage.items} + ${opts.items ?? 1}`, bytes: sql`${storageHouseholdUsage.bytes} + ${actualBytes}` })
        .where(eq(storageHouseholdUsage.householdId, opts.householdId));
    }
  } else {
    const held = row?.bytes ?? reservedBytes;
    const household = row ? row.householdId : opts.householdId;
    await tx
      .update(storageUsage)
      .set({
        reservedBytes: sql`greatest(0, ${storageUsage.reservedBytes} - ${held})`,
        usedBytes: sql`${storageUsage.usedBytes} + ${actualBytes}`,
      })
      .where(eq(storageUsage.eventId, eventId));
    if (household && actualBytes !== held) {
      await tx
        .update(storageHouseholdUsage)
        .set({ bytes: sql`greatest(0, ${storageHouseholdUsage.bytes} + ${actualBytes - held})` })
        .where(eq(storageHouseholdUsage.householdId, household));
    }
  }
  await checkStorageWarnings(tx, eventId);
}

/** Gives back a reservation for an upload that didn't happen. */
export async function release(tx: Tx, eventId: string, bytes: number, opts: ReserveOpts & { reservationId?: string } = {}) {
  await lockUsage(tx, eventId);
  const row = await takeReservation(tx, eventId, bytes, opts.householdId, opts.reservationId);
  if (row === null) return; // already given back
  if (row) return dropReservationCounters(tx, eventId, [row]);
  await tx
    .update(storageUsage)
    .set({ reservedBytes: sql`greatest(0, ${storageUsage.reservedBytes} - ${bytes})` })
    .where(eq(storageUsage.eventId, eventId));
  await householdDown(tx, opts, bytes);
}

/** Gives back space when a stored object is deleted. */
export async function free(tx: Tx, eventId: string, bytes: number, opts: ReserveOpts = {}) {
  await tx
    .update(storageUsage)
    .set({ usedBytes: sql`greatest(0, ${storageUsage.usedBytes} - ${bytes})` })
    .where(eq(storageUsage.eventId, eventId));
  await householdDown(tx, opts, bytes);
}

async function householdDown(tx: Tx, opts: ReserveOpts, bytes: number) {
  if (!opts.householdId) return;
  await tx
    .update(storageHouseholdUsage)
    .set({
      items: sql`greatest(0, ${storageHouseholdUsage.items} - ${opts.items ?? 1})`,
      bytes: sql`greatest(0, ${storageHouseholdUsage.bytes} - ${bytes})`,
    })
    .where(eq(storageHouseholdUsage.householdId, opts.householdId));
}

/** Daily: gives back reservations of abandoned uploads (expired rows), one event per transaction. */
export async function releaseExpiredReservations(db: Database, now = new Date(), opts: { limit?: number } = {}) {
  const due = await db
    .selectDistinct({ eventId: storageReservations.eventId })
    .from(storageReservations)
    .where(lte(storageReservations.expiresAt, now))
    .limit(opts.limit ?? 500);
  let n = 0;
  for (const { eventId } of due) {
    n += await db.transaction(async (tx) => {
      await lockUsage(tx, eventId);
      return releaseExpiredFor(tx, eventId, now);
    });
  }
  return n;
}

/** LIM-03: warn Hosts once at 80% and once at 95% of the event's storage limit. */
export async function checkStorageWarnings(tx: Tx, eventId: string) {
  const [u] = await tx.select().from(storageUsage).where(eq(storageUsage.eventId, eventId));
  if (!u) return;
  const { storageBytes } = await getStorageLimits(tx, eventId);
  const pct = storageBytes > 0 ? (u.usedBytes / storageBytes) * 100 : 100;
  for (const level of [95, 80] as const) {
    if (pct < level) continue;
    const col = level === 95 ? storageUsage.warned95At : storageUsage.warned80At;
    const marked = await tx
      .update(storageUsage)
      .set(level === 95 ? { warned95At: new Date() } : { warned80At: new Date() })
      .where(and(eq(storageUsage.eventId, eventId), sql`${col} is null`))
      .returning({ e: storageUsage.eventId });
    if (marked.length) {
      const { notifyHosts } = await import("./notifications");
      await notifyHosts(tx, eventId, { kind: "usage.storageWarning", data: { pct: level }, href: `/events/${eventId}/usage` });
    }
    break;
  }
}

// ---------------------------------------------------------------------------
// Usage sources: what the counter should add up to (reconciliation, LIM-01 breakdown)
// ---------------------------------------------------------------------------

// Every source is registered centrally in `storage-sources.ts` (imported above), so reconcile
// always sees all of them. Re-exported for callers that used them from this module.
export { registerUsageSource, type UsageSource } from "./storage-sources";

export async function storageBreakdown(db: Tx, eventId: string) {
  const out: { key: string; bytes: number }[] = [];
  for (const s of usageSources()) out.push({ key: s.key, bytes: await s.measure(db, eventId) });
  return out;
}

export type StorageUsage = {
  used: number;
  reserved: number;
  limit: number;
  remaining: number;
  /** Used share of the limit, 0–100+ (vendors can push it past 100). */
  pct: number;
  limits: StorageLimits;
  breakdown: { key: string; bytes: number }[];
};

/** LIM-01: storage used vs the event's limit, with a breakdown by source. */
export async function getStorageUsage(db: Tx, eventId: string): Promise<StorageUsage> {
  const limits = await getStorageLimits(db, eventId);
  const [u] = await db.select().from(storageUsage).where(eq(storageUsage.eventId, eventId));
  const used = u?.usedBytes ?? 0;
  const reserved = u?.reservedBytes ?? 0;
  return {
    used,
    reserved,
    limit: limits.storageBytes,
    remaining: Math.max(0, limits.storageBytes - used - reserved),
    pct: limits.storageBytes > 0 ? Math.round((used / limits.storageBytes) * 100) : 100,
    limits,
    breakdown: await storageBreakdown(db, eventId),
  };
}

/**
 * Sets the counters to what's really there (drift from cascaded deletes and abandoned uploads):
 * used = what the sources add up to; reserved = the live reservation rows, after giving back
 * expired ones.
 */
export async function reconcileUsage(tx: Tx, eventId: string, now = new Date()) {
  await lockUsage(tx, eventId);
  await releaseExpiredFor(tx, eventId, now);
  const total = (await storageBreakdown(tx, eventId)).reduce((a, b) => a + b.bytes, 0);
  const [r] = await tx
    .select({ n: sql<number>`coalesce(sum(${storageReservations.bytes}), 0)::bigint`.mapWith(Number) })
    .from(storageReservations)
    .where(eq(storageReservations.eventId, eventId));
  await tx.update(storageUsage).set({ usedBytes: total, reservedBytes: r?.n ?? 0, reconciledAt: now }).where(eq(storageUsage.eventId, eventId));
  return total;
}
