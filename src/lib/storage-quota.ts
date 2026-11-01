import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { documents, eventStorageOverrides, platformSettings, storageHouseholdUsage, storageUsage } from "@/db/schema";

/**
 * Per-event storage quota (§4.1, LIM-01/03, ADR-0030).
 *
 * Flow for anything that stores bytes:
 * 1. `reserve(tx, eventId, bytes, audience, { householdId })` before uploading (row-locked, so
 *    concurrent uploads can't overshoot). Throws `StorageQuotaError` when it doesn't fit.
 * 2. After the object is confirmed in the store: `commit(tx, eventId, reserved, actual)`.
 *    If the upload is abandoned/failed: `release(tx, eventId, reserved, { householdId })`.
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

export type ReserveOpts = { householdId?: string | null; items?: number };

/** Reserves space for an upload (call inside the transaction that records it). */
export async function reserve(tx: Tx, eventId: string, bytes: number, audience: Audience, opts: ReserveOpts = {}) {
  if (!Number.isInteger(bytes) || bytes <= 0) throw new StorageQuotaError("invalid");
  const usage = await lockUsage(tx, eventId);
  const limits = await getStorageLimits(tx, eventId);
  const remaining = capFor(limits.storageBytes, audience) - usage.usedBytes - usage.reservedBytes;
  if (bytes > remaining) throw new StorageQuotaError("storage_full", Math.max(0, remaining));
  if (audience === "guest" && opts.householdId) {
    const items = opts.items ?? 1;
    const h = await lockHousehold(tx, eventId, opts.householdId);
    if (h.items + items > limits.guestItems) throw new StorageQuotaError("household_items", Math.max(0, limits.guestItems - h.items));
    if (h.bytes + bytes > limits.guestBytes) throw new StorageQuotaError("household_bytes", Math.max(0, limits.guestBytes - h.bytes));
    await tx
      .update(storageHouseholdUsage)
      .set({ items: sql`${storageHouseholdUsage.items} + ${items}`, bytes: sql`${storageHouseholdUsage.bytes} + ${bytes}` })
      .where(eq(storageHouseholdUsage.householdId, opts.householdId));
  }
  await tx
    .update(storageUsage)
    .set({ reservedBytes: sql`${storageUsage.reservedBytes} + ${bytes}` })
    .where(eq(storageUsage.eventId, eventId));
}

/**
 * Turns a reservation into usage. `actualBytes` (default: the reservation) is what was really
 * stored; for guests the household's bytes are corrected by the difference.
 */
export async function commit(tx: Tx, eventId: string, reservedBytes: number, actualBytes = reservedBytes, opts: { householdId?: string | null } = {}) {
  await lockUsage(tx, eventId);
  await tx
    .update(storageUsage)
    .set({
      reservedBytes: sql`greatest(0, ${storageUsage.reservedBytes} - ${reservedBytes})`,
      usedBytes: sql`${storageUsage.usedBytes} + ${actualBytes}`,
    })
    .where(eq(storageUsage.eventId, eventId));
  if (opts.householdId && actualBytes !== reservedBytes) {
    await tx
      .update(storageHouseholdUsage)
      .set({ bytes: sql`greatest(0, ${storageHouseholdUsage.bytes} + ${actualBytes - reservedBytes})` })
      .where(eq(storageHouseholdUsage.householdId, opts.householdId));
  }
  await checkStorageWarnings(tx, eventId);
}

/** Gives back a reservation for an upload that didn't happen. */
export async function release(tx: Tx, eventId: string, bytes: number, opts: ReserveOpts = {}) {
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

/**
 * A kind of stored object that counts against the quota. Documents are built in; the gallery
 * (WP-B) registers its own (e.g. `gallery.vendor`, `gallery.member`, `gallery.guest`), with an
 * i18n label at `storage.sources.<key>`.
 */
export type UsageSource = { key: string; measure: (db: Tx, eventId: string) => Promise<number> };

const sources = new Map<string, UsageSource>();

export function registerUsageSource(source: UsageSource) {
  sources.set(source.key, source);
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

export async function storageBreakdown(db: Tx, eventId: string) {
  const out: { key: string; bytes: number }[] = [];
  for (const s of sources.values()) out.push({ key: s.key, bytes: await s.measure(db, eventId) });
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

/** Sets the usage counter to what the sources add up to (drift from cascaded deletes). */
export async function reconcileUsage(tx: Tx, eventId: string, now = new Date()) {
  await lockUsage(tx, eventId);
  const total = (await storageBreakdown(tx, eventId)).reduce((a, b) => a + b.bytes, 0);
  await tx.update(storageUsage).set({ usedBytes: total, reconciledAt: now }).where(eq(storageUsage.eventId, eventId));
  return total;
}
