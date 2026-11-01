import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import type { Database } from "@/db";
import { events } from "@/db/schema";
import { audit, type Actor } from "./audit";
import { sniffMime } from "./documents";
import { eventKey, getStore } from "./storage";
import { queueStorageDeletion, runStorageDeletions } from "./storage-gc";
import { commit, free, reserve, StorageQuotaError } from "./storage-quota";

/**
 * Event logo (EVT-03 switcher / event header). One 256px square WebP per event, stored under
 * `events/<id>/branding/` so retention and event deletion remove it with the event prefix.
 * Counted against the event's storage quota (ADR-0030) via `events.logo_bytes`.
 */

export const MAX_LOGO_INPUT_BYTES = 4 * 1024 * 1024;
export const LOGO_SIZE = 256;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);

export class EventLogoError extends Error {
  constructor(public code: "empty" | "too_large" | "bad_type" | "bad_image" | "quota" | "not_found") {
    super(code);
  }
}

const KEY_RE = /^events\/[0-9a-f-]{36}\/branding\/logo-[0-9a-f-]{36}\.webp$/;

/** True for keys this module wrote (guards serving/deleting against a tampered column). */
export function isLogoKey(eventId: string, key: string | null | undefined): key is string {
  return !!key && key.startsWith(`events/${eventId}/branding/`) && KEY_RE.test(key);
}

/** The cache-busting version for the logo URL (the uuid in its key), or null when there's none. */
export function logoVersion(eventId: string, key: string | null | undefined): string | null {
  return isLogoKey(eventId, key) ? key.slice(key.lastIndexOf("logo-") + 5, -5) : null;
}

/** Validates (by content, not the browser's type) and resizes to a 256px square WebP. */
export async function processLogo(data: Buffer): Promise<Buffer> {
  if (data.length === 0) throw new EventLogoError("empty");
  if (data.length > MAX_LOGO_INPUT_BYTES) throw new EventLogoError("too_large");
  const mime = sniffMime(data);
  if (!mime || !IMAGE_TYPES.has(mime)) throw new EventLogoError("bad_type");
  try {
    return await sharp(data, { limitInputPixels: 50_000_000 })
      .rotate()
      .resize(LOGO_SIZE, LOGO_SIZE, { fit: "cover", position: "centre" })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    throw new EventLogoError("bad_image");
  }
}

/**
 * Sets or replaces the event logo. The new object is stored inside the transaction (so a failed
 * upload records nothing); the old one is freed from the quota and deleted from the store.
 */
export async function saveEventLogo(db: Database, eventId: string, actor: Actor, data: Buffer) {
  const out = await processLogo(data);
  const store = getStore();
  const key = eventKey(eventId, "branding", `logo-${randomUUID()}.webp`);
  let stored = false;
  try {
    const queued = await db.transaction(async (tx) => {
      const [event] = await tx.select({ logoKey: events.logoKey, logoBytes: events.logoBytes, deletedAt: events.deletedAt }).from(events).where(eq(events.id, eventId)).for("update");
      if (!event || event.deletedAt) throw new EventLogoError("not_found");
      const reservation = await reserve(tx, eventId, out.length, "member");
      await store.put(key, out, "image/webp");
      stored = true;
      await commit(tx, eventId, out.length, out.length, { reservationId: reservation.id });
      await tx.update(events).set({ logoKey: key, logoBytes: out.length }).where(eq(events.id, eventId));
      const ids: number[] = [];
      if (event.logoKey) {
        if (event.logoBytes > 0) await free(tx, eventId, event.logoBytes);
        if (isLogoKey(eventId, event.logoKey)) ids.push(await queueStorageDeletion(tx, event.logoKey, "logo_replaced"));
      }
      await audit(tx, { eventId, actor, action: event.logoKey ? "event.logo_replaced" : "event.logo_added", entityType: "event", entityId: eventId, data: { bytes: out.length } });
      return ids;
    });
    await runStorageDeletions(db, store, queued);
    return { key, bytes: out.length };
  } catch (e) {
    if (stored) await store.delete(key).catch(() => undefined);
    if (e instanceof StorageQuotaError) throw new EventLogoError("quota");
    throw e;
  }
}

export async function removeEventLogo(db: Database, eventId: string, actor: Actor) {
  const queued = await db.transaction(async (tx) => {
    const [event] = await tx.select({ logoKey: events.logoKey, logoBytes: events.logoBytes }).from(events).where(eq(events.id, eventId)).for("update");
    if (!event?.logoKey) throw new EventLogoError("not_found");
    await tx.update(events).set({ logoKey: null, logoBytes: 0 }).where(eq(events.id, eventId));
    if (event.logoBytes > 0) await free(tx, eventId, event.logoBytes);
    await audit(tx, { eventId, actor, action: "event.logo_removed", entityType: "event", entityId: eventId });
    return isLogoKey(eventId, event.logoKey) ? [await queueStorageDeletion(tx, event.logoKey, "logo_removed")] : [];
  });
  await runStorageDeletions(db, getStore(), queued);
}

/** The logo bytes, or null when the event has none (or the object is missing). */
export async function readEventLogo(eventId: string, key: string | null | undefined): Promise<Buffer | null> {
  if (!isLogoKey(eventId, key)) return null;
  return getStore().getBytes(key);
}
