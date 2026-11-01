import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Database, Tx } from "@/db";
import {
  albumSelectionItems,
  albumSelections,
  bookings,
  eventMembers,
  functionInvites,
  functions,
  fulfilments,
  galleryAlbums,
  galleryReadyNotices,
  gallerySettings,
  guests,
  households,
  mediaComments,
  mediaFavourites,
  mediaItems,
  mediaLikes,
  mediaRemovalRequests,
  rateEvents,
  serviceTypes,
  services,
  type GalleryAlbum,
  type GallerySettings,
  type MediaItem,
} from "@/db/schema";
import { audit, type Actor } from "./audit";
import { notify } from "./notifications";
import { enqueue, QuotaError, type EnqueueItem } from "./outbox";
import { recipientsFor } from "./broadcasts";
import { eventKey, StorageError, type ObjectStore, type UploadGrant } from "./storage";
import { queueStorageDeletion } from "./storage-gc";
import { commit, free, release, reserve, StorageQuotaError } from "./storage-quota";
import { vendorUserIds } from "./vendor-access";
import { allowAttempt } from "./website";
import { extFor, readStreamHead, sameFamily, sniffMime } from "./media-files";

/**
 * Post-event photo gallery (GAL-01..08, GAL-10, GAL-11).
 *
 * Uploads go straight from the browser to object storage (ADR-0031): `beginUpload` checks the
 * uploader's right to add to that function, reserves quota and returns an upload grant;
 * `completeUpload` confirms the object's real size, commits the quota and queues the item for
 * renditions (`renditions.ts`, ADR-0032). Abandoned uploads are swept daily (`sweepUploads`).
 *
 * Who sees what (`canViewMedia`): members see everything; vendors their own deliveries and items
 * in an album selection shared with them; guests their own family's uploads plus approved items
 * in released albums of functions their family is invited to (so private functions stay private).
 */

export class GalleryError extends Error {
  constructor(
    public code:
      | "not_found"
      | "invalid"
      | "bad_type"
      | "too_large"
      | "not_booked"
      | "not_invited"
      | "uploads_off"
      | "rate_limited"
      | "not_uploaded"
      | "storage_full"
      | "household_items"
      | "household_bytes"
      | "reactions_off"
      | "already_requested"
      | "not_ready"
      | "album_released"
      | "not_public",
  ) {
    super(code);
  }
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"] as const;
export const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;
/** Guests upload photos as JPEG (resized in the browser to 4096 px, §4.1) and videos. */
export const GUEST_PHOTO_TYPES = ["image/jpeg"] as const;

/** §4.1 single-upload limits. Members (the family) get the vendor video limit. */
export const LIMITS = {
  photo: 50 * MB,
  videoVendor: 4 * GB,
  videoMember: 4 * GB,
  videoGuest: 500 * MB,
} as const;

/** Guest upload attempts per family per hour (on top of the 300 items / 5 GB cap). */
export const GUEST_UPLOADS_PER_HOUR = 300;
/** Full-gallery ZIP downloads per event per day (§4.1). */
export const FULL_DOWNLOADS_PER_DAY = 5;
/**
 * ZIP parts must finish streaming inside one 300 s function: ~400 MB or 500 files each, whichever
 * comes first (about 1.5 MB/s is enough; ADR-0031). The daily limits count parts, not downloads.
 */
export const ZIP_PART_BYTES = 400 * MB;
export const ZIP_PART_FILES = 500;
/** Guest ZIP parts per family per day (each part counts). */
export const GUEST_ZIP_PARTS_PER_DAY = 10;

export const PHOTOGRAPHY_KEYS = ["photography", "videography"] as const;

export type Uploader = { kind: "member"; userId: string } | { kind: "vendor"; vendorId: string; userId: string } | { kind: "guest"; householdId: string };

export type Viewer = { kind: "member" } | { kind: "vendor"; vendorId: string } | { kind: "guest"; householdId: string; functionIds: string[] };

export const DEFAULT_SETTINGS: Omit<GallerySettings, "eventId" | "updatedAt" | "sweptAt" | "sweepStep"> = {
  guestUploads: false,
  autoApprove: false,
  guestOriginals: false,
  reactions: true,
  watermarkText: null,
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getGallerySettings(db: Tx, eventId: string): Promise<GallerySettings> {
  const [row] = await db.select().from(gallerySettings).where(eq(gallerySettings.eventId, eventId));
  return row ?? { eventId, ...DEFAULT_SETTINGS, sweptAt: null, sweepStep: 0, updatedAt: new Date(0) };
}

export const settingsSchema = z.object({
  guestUploads: z.boolean(),
  autoApprove: z.boolean(),
  guestOriginals: z.boolean(),
  reactions: z.boolean(),
  watermarkText: z
    .string()
    .trim()
    .max(60)
    .transform((s) => s || null)
    .nullable(),
});

export async function updateGallerySettings(db: Database, eventId: string, actor: Actor, raw: z.input<typeof settingsSchema>) {
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) throw new GalleryError("invalid");
  const v = parsed.data;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(gallerySettings)
      .values({ eventId, ...v, updatedAt: new Date() })
      .onConflictDoUpdate({ target: gallerySettings.eventId, set: { ...v, updatedAt: new Date() } })
      .returning();
    await audit(tx, { eventId, actor, action: "gallery.settings_changed", entityType: "event", entityId: eventId, data: { ...v } });
    return row;
  });
}

// ---------------------------------------------------------------------------
// Albums
// ---------------------------------------------------------------------------

async function getFunction(db: Tx, eventId: string, functionId: string) {
  if (!z.string().uuid().safeParse(functionId).success) throw new GalleryError("not_found");
  const [fn] = await db
    .select()
    .from(functions)
    .where(and(eq(functions.id, functionId), eq(functions.eventId, eventId)));
  if (!fn) throw new GalleryError("not_found");
  return fn;
}

export async function getAlbum(db: Tx, eventId: string, albumId: string) {
  if (!z.string().uuid().safeParse(albumId).success) throw new GalleryError("not_found");
  const [a] = await db
    .select()
    .from(galleryAlbums)
    .where(and(eq(galleryAlbums.id, albumId), eq(galleryAlbums.eventId, eventId)));
  if (!a) throw new GalleryError("not_found");
  return a;
}

/** The function's family or guest album, created on first use (serialised per function). */
async function defaultAlbum(tx: Tx, eventId: string, functionId: string, kind: "family" | "guest", userId: string | null, now: Date) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`gallery-album:${functionId}:${kind}`}))`);
  const [existing] = await tx
    .select()
    .from(galleryAlbums)
    .where(and(eq(galleryAlbums.eventId, eventId), eq(galleryAlbums.functionId, functionId), eq(galleryAlbums.kind, kind)))
    .orderBy(asc(galleryAlbums.createdAt))
    .limit(1);
  if (existing) return existing;
  // Guest albums are "released" from the start: moderation (GAL-04) is their gate.
  const [a] = await tx
    .insert(galleryAlbums)
    .values({ eventId, functionId, kind, title: "", sortOrder: kind === "guest" ? 1000 : 0, createdBy: userId, releasedAt: kind === "guest" ? now : null })
    .returning();
  return a;
}

const titleSchema = z.string().trim().min(1).max(80);

export async function createAlbum(db: Database, input: { eventId: string; actor: Actor; functionId: string; title: string }) {
  const title = titleSchema.safeParse(input.title);
  if (!title.success) throw new GalleryError("invalid");
  return db.transaction(async (tx) => {
    await getFunction(tx, input.eventId, input.functionId);
    const [a] = await tx.insert(galleryAlbums).values({ eventId: input.eventId, functionId: input.functionId, kind: "family", title: title.data, createdBy: input.actor.userId }).returning();
    await audit(tx, { eventId: input.eventId, actor: input.actor, action: "gallery.album_created", entityType: "gallery_album", entityId: a.id, data: { title: a.title } });
    return a;
  });
}

/** Renames an album (members; vendors their own delivery albums). */
export async function renameAlbum(db: Tx, input: { eventId: string; albumId: string; title: string; vendorId?: string }) {
  const title = titleSchema.safeParse(input.title);
  if (!title.success) throw new GalleryError("invalid");
  const a = await getAlbum(db, input.eventId, input.albumId);
  if (input.vendorId && a.vendorId !== input.vendorId) throw new GalleryError("not_found");
  await db.update(galleryAlbums).set({ title: title.data }).where(eq(galleryAlbums.id, a.id));
}

/** Deletes an empty album (anything still in it must be deleted first). */
export async function deleteAlbum(db: Database, input: { eventId: string; actor: Actor; albumId: string }) {
  await db.transaction(async (tx) => {
    const a = await getAlbum(tx, input.eventId, input.albumId);
    const [{ n }] = await tx.select({ n: count() }).from(mediaItems).where(eq(mediaItems.albumId, a.id));
    if (n > 0) throw new GalleryError("invalid");
    await tx.delete(galleryAlbums).where(eq(galleryAlbums.id, a.id));
    await audit(tx, { eventId: input.eventId, actor: input.actor, action: "gallery.album_deleted", entityType: "gallery_album", entityId: a.id, data: { title: a.title } });
  });
}

export type AlbumSummary = GalleryAlbum & {
  functionName: string;
  functionDate: string | null;
  approved: number;
  pending: number;
  hidden: number;
  processing: number;
  bytes: number;
  coverId: string | null;
};

/** Every album with counts, grouped by function date (GAL-01). Optionally only one vendor's. */
export async function listAlbums(db: Tx, eventId: string, opts: { vendorId?: string; functionId?: string } = {}): Promise<AlbumSummary[]> {
  const rows = await db
    .select({
      album: galleryAlbums,
      functionName: functions.name,
      functionDate: functions.date,
      approved: sql<number>`count(${mediaItems.id}) filter (where ${mediaItems.status} = 'approved')`.mapWith(Number),
      pending: sql<number>`count(${mediaItems.id}) filter (where ${mediaItems.status} = 'pending')`.mapWith(Number),
      hidden: sql<number>`count(${mediaItems.id}) filter (where ${mediaItems.status} = 'hidden')`.mapWith(Number),
      processing: sql<number>`count(${mediaItems.id}) filter (where ${mediaItems.status} in ('processing', 'failed'))`.mapWith(Number),
      bytes: sql<number>`coalesce(sum(${mediaItems.originalBytes}) filter (where ${mediaItems.status} <> 'uploading'), 0)::bigint`.mapWith(Number),
      coverId: sql<string | null>`(array_agg(${mediaItems.id} order by ${mediaItems.takenAt}, ${mediaItems.id}) filter (where ${mediaItems.status} = 'approved' and ${mediaItems.thumbKey} is not null))[1]`,
    })
    .from(galleryAlbums)
    .innerJoin(functions, eq(functions.id, galleryAlbums.functionId))
    .leftJoin(mediaItems, eq(mediaItems.albumId, galleryAlbums.id))
    .where(
      and(
        eq(galleryAlbums.eventId, eventId),
        opts.vendorId ? eq(galleryAlbums.vendorId, opts.vendorId) : undefined,
        opts.functionId ? eq(galleryAlbums.functionId, opts.functionId) : undefined,
      ),
    )
    .groupBy(galleryAlbums.id, functions.id)
    .orderBy(sql`${functions.date} asc nulls last`, asc(functions.startTime), asc(galleryAlbums.sortOrder), asc(galleryAlbums.createdAt));
  return rows.map((r) => ({ ...r.album, functionName: r.functionName, functionDate: r.functionDate, approved: r.approved, pending: r.pending, hidden: r.hidden, processing: r.processing, bytes: r.bytes, coverId: r.coverId }));
}

// ---------------------------------------------------------------------------
// Vendors: which functions a photographer/videographer may deliver to (GAL-02)
// ---------------------------------------------------------------------------

export type VendorGalleryFunction = { functionId: string; functionName: string; functionDate: string | null; bookingId: string; vendorId: string };

/** Confirmed bookings on a Photography/Videography service, one row per (booking, function). */
export async function photoBookings(db: Tx, eventId: string, opts: { vendorId?: string; functionId?: string; bookingId?: string } = {}): Promise<VendorGalleryFunction[]> {
  const rows = await db
    .selectDistinct({ functionId: functions.id, functionName: functions.name, functionDate: functions.date, bookingId: bookings.id, vendorId: bookings.vendorId })
    .from(fulfilments)
    .innerJoin(bookings, eq(bookings.id, fulfilments.bookingId))
    .innerJoin(services, eq(services.id, fulfilments.serviceId))
    .innerJoin(serviceTypes, eq(serviceTypes.id, services.serviceTypeId))
    .innerJoin(functions, eq(functions.id, services.functionId))
    .where(
      and(
        eq(bookings.eventId, eventId),
        eq(bookings.status, "confirmed"),
        isNull(fulfilments.cancelledAt),
        isNull(services.cancelledAt),
        inArray(serviceTypes.systemKey, [...PHOTOGRAPHY_KEYS]),
        opts.vendorId ? eq(bookings.vendorId, opts.vendorId) : undefined,
        opts.functionId ? eq(functions.id, opts.functionId) : undefined,
        opts.bookingId ? eq(bookings.id, opts.bookingId) : undefined,
      ),
    );
  return rows.sort((a, b) => (a.functionDate ?? "9999").localeCompare(b.functionDate ?? "9999") || a.functionName.localeCompare(b.functionName));
}

/** A vendor's delivery album for one of their booked functions (e.g. "Sneak peek", "Full delivery"). */
export async function createVendorAlbum(db: Database, input: { eventId: string; vendorId: string; userId: string; functionId: string; title: string }) {
  const title = titleSchema.safeParse(input.title);
  if (!title.success) throw new GalleryError("invalid");
  return db.transaction(async (tx) => {
    const [booking] = await photoBookings(tx, input.eventId, { vendorId: input.vendorId, functionId: input.functionId });
    if (!booking) throw new GalleryError("not_booked");
    const [a] = await tx
      .insert(galleryAlbums)
      .values({ eventId: input.eventId, functionId: input.functionId, kind: "delivery", bookingId: booking.bookingId, vendorId: input.vendorId, title: title.data, createdBy: input.userId })
      .returning();
    await audit(tx, { eventId: input.eventId, actor: { userId: input.userId, isAppAdmin: false }, action: "gallery.delivery_album_created", entityType: "gallery_album", entityId: a.id, data: { title: a.title } });
    return a;
  });
}

// ---------------------------------------------------------------------------
// Guests: which functions a family is invited to
// ---------------------------------------------------------------------------

export async function householdFunctionIds(db: Tx, eventId: string, householdId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: functionInvites.functionId })
    .from(functionInvites)
    .innerJoin(guests, eq(guests.id, functionInvites.guestId))
    .where(and(eq(guests.householdId, householdId), eq(guests.eventId, eventId)));
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Uploads (ADR-0031)
// ---------------------------------------------------------------------------

export const beginSchema = z.object({
  functionId: z.string().uuid(),
  albumId: z.string().uuid().nullish(),
  clientKey: z.string().uuid(),
  filename: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .transform((s) => s.replace(/[\u0000-\u001f\\/]/g, "_")),
  mime: z
    .string()
    .trim()
    .toLowerCase()
    .max(100),
  size: z.number().int().positive(),
});
export type BeginInput = z.input<typeof beginSchema>;

export function kindOf(mime: string): "photo" | "video" | null {
  if ((PHOTO_TYPES as readonly string[]).includes(mime)) return "photo";
  if ((VIDEO_TYPES as readonly string[]).includes(mime)) return "video";
  return null;
}

/** The largest file an uploader may send of this type, or null when the type isn't allowed. */
export function maxBytesFor(uploader: Uploader["kind"], mime: string): number | null {
  const kind = kindOf(mime);
  if (!kind) return null;
  if (uploader === "guest" && kind === "photo" && !(GUEST_PHOTO_TYPES as readonly string[]).includes(mime)) return null;
  if (kind === "photo") return LIMITS.photo;
  return uploader === "vendor" ? LIMITS.videoVendor : uploader === "guest" ? LIMITS.videoGuest : LIMITS.videoMember;
}

const audienceOf = (u: Uploader) => (u.kind === "guest" ? "guest" : u.kind) as "member" | "vendor" | "guest";

function sameUploader(row: MediaItem, u: Uploader) {
  if (u.kind === "member") return row.uploaderKind === "member" && row.userId === u.userId;
  if (u.kind === "vendor") return row.uploaderKind === "vendor" && row.vendorId === u.vendorId;
  return row.uploaderKind === "household" && row.householdId === u.householdId;
}

export function originalKeyFor(eventId: string, mediaId: string, householdId: string | null) {
  return householdId ? eventKey(eventId, "households", householdId, "gallery", mediaId, "original") : eventKey(eventId, "gallery", mediaId, "original");
}

/** The folder holding an item's original and renditions (deleted as one prefix). */
export function mediaPrefix(item: Pick<MediaItem, "eventId" | "id" | "householdId">) {
  const key = originalKeyFor(item.eventId, item.id, item.householdId);
  return key.slice(0, key.length - "original".length);
}

function quotaError(e: unknown): never {
  if (e instanceof StorageQuotaError) {
    throw new GalleryError(e.code === "invalid" ? "invalid" : e.code);
  }
  throw e;
}

export type BeginResult = { mediaId: string; grant: UploadGrant } | { mediaId: string; done: true; status: MediaItem["status"] };

/** What finishing an upload can say instead of returning the item. */
type FinishFailure = "missing" | "rejected" | "bad_type";

function finishError(f: Exclude<FinishFailure, "missing">): never {
  throw new GalleryError(f === "bad_type" ? "bad_type" : "too_large");
}

/**
 * Starts (or resumes) one upload: checks the uploader may add to that function, reserves quota
 * and returns a grant for a direct browser upload. Retrying with the same `clientKey` resumes.
 */
export async function beginUpload(db: Database, store: ObjectStore, eventId: string, uploader: Uploader, raw: BeginInput, now = new Date()): Promise<BeginResult> {
  const parsed = beginSchema.safeParse(raw);
  if (!parsed.success) throw new GalleryError("invalid");
  const input = parsed.data;
  const max = maxBytesFor(uploader.kind, input.mime);
  if (max == null) throw new GalleryError("bad_type");
  if (input.size > max) throw new GalleryError("too_large");
  const kind = kindOf(input.mime)!;
  const ttlSeconds = kind === "video" ? 6 * 3600 : 30 * 60;

  const res = await db.transaction(async (tx): Promise<BeginResult | Exclude<FinishFailure, "missing">> => {
    // A retry of the same file: hand out a fresh grant for the same key, or report it's done.
    const [existing] = await tx
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.eventId, eventId), eq(mediaItems.clientKey, input.clientKey)))
      .for("update");
    if (existing) {
      if (!sameUploader(existing, uploader)) throw new GalleryError("invalid");
      if (existing.status !== "uploading") return { mediaId: existing.id, done: true as const, status: existing.status };
      // The bytes may have arrived and only "complete" got lost: finish instead of a new grant
      // (a grant never overwrites, so a retry would fail for ever otherwise).
      const finished = await finishUpload(tx, store, existing);
      if (finished === "rejected" || finished === "bad_type") return finished;
      if (finished !== "missing") return { mediaId: finished.id, done: true as const, status: finished.status };
      const grant = await store.authorizeUpload({ key: existing.originalKey, maxBytes: existing.reservedBytes, contentTypes: [existing.mime], ttlSeconds });
      await tx.update(mediaItems).set({ uploadExpiresAt: new Date(grant.expiresAt) }).where(eq(mediaItems.id, existing.id));
      return { mediaId: existing.id, grant };
    }

    const fn = await getFunction(tx, eventId, input.functionId);
    let album: GalleryAlbum;
    let householdId: string | null = null;
    if (uploader.kind === "member") {
      if (input.albumId) {
        album = await getAlbum(tx, eventId, input.albumId);
        if (album.functionId !== fn.id || album.kind === "guest") throw new GalleryError("invalid");
      } else album = await defaultAlbum(tx, eventId, fn.id, "family", uploader.userId, now);
    } else if (uploader.kind === "vendor") {
      if (!input.albumId) throw new GalleryError("invalid");
      album = await getAlbum(tx, eventId, input.albumId);
      if (album.kind !== "delivery" || album.vendorId !== uploader.vendorId || album.functionId !== fn.id) throw new GalleryError("not_found");
      // Deliveries stay private until the family releases them (GAL-02): no adding to a released album.
      if (album.releasedAt) throw new GalleryError("album_released");
      const [booking] = await photoBookings(tx, eventId, { vendorId: uploader.vendorId, functionId: fn.id });
      if (!booking) throw new GalleryError("not_booked");
    } else {
      const settings = await getGallerySettings(tx, eventId);
      if (!settings.guestUploads) throw new GalleryError("uploads_off");
      const invited = await householdFunctionIds(tx, eventId, uploader.householdId);
      if (!invited.includes(fn.id)) throw new GalleryError("not_invited");
      if (!(await allowAttempt(tx, "gallery-upload", uploader.householdId, GUEST_UPLOADS_PER_HOUR, 3600_000, now))) throw new GalleryError("rate_limited");
      householdId = uploader.householdId;
      album = await defaultAlbum(tx, eventId, fn.id, "guest", null, now);
    }

    // The reservation outlives the grant by an hour; after that the daily job gives it back.
    let reservationId: string;
    try {
      reservationId = (await reserve(tx, eventId, input.size, audienceOf(uploader), { householdId, ttlSeconds: ttlSeconds + 3600, now })).id;
    } catch (e) {
      quotaError(e);
    }
    const id = randomUUID();
    const key = originalKeyFor(eventId, id, householdId);
    const grant = await store.authorizeUpload({ key, maxBytes: input.size, contentTypes: [input.mime], ttlSeconds, multipart: input.size > 50 * MB });
    await tx.insert(mediaItems).values({
      id,
      eventId,
      albumId: album.id,
      functionId: fn.id,
      uploaderKind: uploader.kind === "guest" ? "household" : uploader.kind,
      userId: uploader.kind === "guest" ? null : uploader.userId,
      vendorId: uploader.kind === "vendor" ? uploader.vendorId : null,
      householdId,
      clientKey: input.clientKey,
      kind,
      mime: input.mime,
      filename: input.filename,
      originalKey: key,
      reservedBytes: input.size,
      reservationId,
      takenAt: now,
      status: "uploading",
      uploadExpiresAt: new Date(grant.expiresAt),
    });
    await ensureSettingsRow(tx, eventId);
    return { mediaId: id, grant };
  });
  if (typeof res === "string") finishError(res);
  return res;
}

async function lockOwnUpload(tx: Tx, eventId: string, uploader: Uploader, mediaId: string) {
  if (!z.string().uuid().safeParse(mediaId).success) throw new GalleryError("not_found");
  const [row] = await tx
    .select()
    .from(mediaItems)
    .where(and(eq(mediaItems.id, mediaId), eq(mediaItems.eventId, eventId)))
    .for("update");
  if (!row || !sameUploader(row, uploader)) throw new GalleryError("not_found");
  return row;
}

/** The real type of a stored object from its first bytes (null when unreadable or unknown). */
export async function sniffStored(store: ObjectStore, key: string): Promise<string | null> {
  const obj = await store.get(key);
  if (!obj) return null;
  return sniffMime(await readStreamHead(obj.stream));
}

/**
 * Turns an uploaded object into usage: confirms its real size and its real type (from the first
 * bytes, S1), commits quota and queues renditions. A forged or broken object is deleted and its
 * reservation given back. A null `reservationId` means it was already given back (expired).
 */
async function finishUpload(tx: Tx, store: ObjectStore, row: MediaItem): Promise<MediaItem | FinishFailure> {
  const head = await store.head(row.originalKey);
  if (!head) return "missing";
  const drop = async (why: Exclude<FinishFailure, "missing">) => {
    await store.delete(row.originalKey).catch(() => undefined);
    await release(tx, row.eventId, row.reservedBytes, { householdId: row.householdId, reservationId: row.reservationId });
    await tx.delete(mediaItems).where(eq(mediaItems.id, row.id));
    return why;
  };
  // The store enforces the size, so this is a forged or broken object.
  if (head.size <= 0 || head.size > row.reservedBytes) return drop("rejected");
  const real = await sniffStored(store, row.originalKey);
  if (!real || !sameFamily(row.mime, real) || maxBytesFor(row.uploaderKind === "household" ? "guest" : row.uploaderKind, real) == null) return drop("bad_type");
  await commit(tx, row.eventId, row.reservedBytes, head.size, { householdId: row.householdId, reservationId: row.reservationId });
  const [u] = await tx
    .update(mediaItems)
    .set({ status: "processing", mime: real, originalBytes: head.size, reservedBytes: 0, reservationId: null, uploadExpiresAt: null })
    .where(eq(mediaItems.id, row.id))
    .returning();
  return u;
}

/** The browser says the upload finished: verify it in the store and queue renditions. */
export async function completeUpload(db: Database, store: ObjectStore, eventId: string, uploader: Uploader, mediaId: string): Promise<MediaItem> {
  const done = await db.transaction(async (tx) => {
    const row = await lockOwnUpload(tx, eventId, uploader, mediaId);
    if (row.status !== "uploading") return row;
    return finishUpload(tx, store, row);
  });
  if (done === "missing") throw new GalleryError("not_uploaded");
  if (done === "rejected" || done === "bad_type") finishError(done);
  return done;
}

/** The browser gave up on a file: give the reservation back. */
export async function abortUpload(db: Database, store: ObjectStore, eventId: string, uploader: Uploader, mediaId: string) {
  const key = await db.transaction(async (tx) => {
    const row = await lockOwnUpload(tx, eventId, uploader, mediaId);
    if (row.status !== "uploading") return null;
    await release(tx, eventId, row.reservedBytes, { householdId: row.householdId, reservationId: row.reservationId });
    await tx.delete(mediaItems).where(eq(mediaItems.id, row.id));
    return row.originalKey;
  });
  if (key) await store.delete(key).catch(() => undefined);
}

/** Grace after a grant expires before the sweep decides (a multipart upload may still be finishing). */
const SWEEP_GRACE_MS = 15 * 60_000;

/**
 * Daily: uploads whose grant expired are finished if the object arrived (the browser closed
 * before "complete"; if the reservation already expired the object counts as new usage), or
 * dropped otherwise: the row goes (there's no file to show) and its reservation is released (a
 * no-op if the daily reservation job already gave it back).
 */
export async function sweepUploads(db: Database, store: ObjectStore, now = new Date(), opts: { limit?: number } = {}) {
  const due = await db
    .select({ id: mediaItems.id })
    .from(mediaItems)
    .where(and(eq(mediaItems.status, "uploading"), lt(mediaItems.uploadExpiresAt, new Date(now.getTime() - SWEEP_GRACE_MS))))
    .limit(opts.limit ?? 500);
  let n = 0;
  for (const { id } of due) {
    const dropKey = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(mediaItems).where(eq(mediaItems.id, id)).for("update", { skipLocked: true });
      if (!row || row.status !== "uploading") return null;
      const done = await finishUpload(tx, store, row);
      if (done !== "missing") return null;
      await release(tx, row.eventId, row.reservedBytes, { householdId: row.householdId, reservationId: row.reservationId });
      await tx.delete(mediaItems).where(eq(mediaItems.id, row.id));
      return row.originalKey;
    });
    if (dropKey) await store.delete(dropKey).catch(() => undefined);
    n++;
  }
  return n;
}

/**
 * Daily: deletes gallery objects no row points at any more (their rows went with a cascaded
 * delete, e.g. a function or vendor). Objects younger than a day are left alone.
 */
const HEX = "0123456789abcdef";
/**
 * The orphan sweep walks an event in steps: the 16 `gallery/<first hex digit>` prefixes, then the
 * 16 `households/<first hex digit>` prefixes. Progress is saved after each step.
 */
export const SWEEP_STEPS = 32;
const sweepPrefix = (eventId: string, step: number) => (step < 16 ? `events/${eventId}/gallery/${HEX[step]}` : `events/${eventId}/households/${HEX[step - 16]}`);
const SWEEP_CHUNK = 500;

/**
 * Daily: deletes gallery objects no row points at any more (their rows went with a cascaded
 * delete, e.g. a function or vendor). Objects younger than a day are left alone.
 *
 * Bounded by `budgetMs`: it works in steps (one key prefix each, see SWEEP_STEPS), checks ids
 * against the database in chunks, and saves the step reached per event, so a big event is swept
 * over several days without holding up later jobs. Events part-way through come first.
 */
export async function sweepOrphanObjects(db: Database, store: ObjectStore, now = new Date(), opts: { limit?: number; budgetMs?: number; clock?: () => number } = {}) {
  const clock = opts.clock ?? Date.now;
  const deadline = opts.budgetMs != null ? clock() + opts.budgetMs : Infinity;
  const due = await db
    .select({ eventId: gallerySettings.eventId, step: gallerySettings.sweepStep })
    .from(gallerySettings)
    .orderBy(desc(sql`${gallerySettings.sweepStep} > 0`), sql`${gallerySettings.sweptAt} asc nulls first`)
    .limit(opts.limit ?? 10);
  let deleted = 0;
  const ID = /\/gallery\/([0-9a-f-]{36})\//;
  const dayAgo = now.getTime() - 24 * 3600_000;

  const flush = async (eventId: string, batch: { key: string; id: string }[]) => {
    if (batch.length === 0) return;
    const ids = [...new Set(batch.map((b) => b.id))];
    const known = new Set(
      (await db.select({ id: mediaItems.id }).from(mediaItems).where(and(eq(mediaItems.eventId, eventId), inArray(mediaItems.id, ids)))).map((r) => r.id),
    );
    for (const b of batch) {
      if (known.has(b.id)) continue;
      await store.delete(b.key);
      deleted++;
    }
  };

  for (const { eventId, step: from } of due) {
    let step = Math.min(Math.max(0, from), SWEEP_STEPS);
    while (step < SWEEP_STEPS) {
      if (clock() >= deadline) return deleted;
      let batch: { key: string; id: string }[] = [];
      for await (const o of store.list(sweepPrefix(eventId, step))) {
        const m = o.key.match(ID);
        if (!m || o.uploadedAt.getTime() > dayAgo) continue;
        batch.push({ key: o.key, id: m[1] });
        if (batch.length >= SWEEP_CHUNK) {
          await flush(eventId, batch);
          batch = [];
          if (clock() >= deadline) return deleted; // this step is redone next time
        }
      }
      await flush(eventId, batch);
      step++;
      await db.update(gallerySettings).set({ sweepStep: step }).where(eq(gallerySettings.eventId, eventId));
    }
    await db.update(gallerySettings).set({ sweptAt: now, sweepStep: 0 }).where(eq(gallerySettings.eventId, eventId));
  }
  return deleted;
}

/** Every event with media gets a settings row, so the orphan sweep visits it. */
export async function ensureSettingsRow(db: Tx, eventId: string) {
  await db.insert(gallerySettings).values({ eventId }).onConflictDoNothing();
}

// ---------------------------------------------------------------------------
// Access (GAL-05)
// ---------------------------------------------------------------------------

export type AccessItem = Pick<MediaItem, "status" | "uploaderKind" | "vendorId" | "householdId" | "functionId"> & { albumReleased: boolean; sharedWithVendorIds?: string[] };

/** Can this viewer see this item at all? (Variants add their own rules, see `variantAllowed`.) */
export function canViewMedia(viewer: Viewer, item: AccessItem): boolean {
  if (item.status === "uploading") return false;
  if (viewer.kind === "member") return true;
  if (viewer.kind === "vendor") {
    return (item.uploaderKind === "vendor" && item.vendorId === viewer.vendorId) || (item.sharedWithVendorIds ?? []).includes(viewer.vendorId);
  }
  if (item.householdId && item.householdId === viewer.householdId) return true;
  return item.status === "approved" && item.albumReleased && viewer.functionIds.includes(item.functionId);
}

export const VARIANTS = ["thumb", "web", "original", "download"] as const;
export type Variant = (typeof VARIANTS)[number];

/**
 * A file to serve: `key` in the store; `watermark` = serve the watermarked copy of the web
 * rendition instead (S4); `strip` = a JPEG original whose metadata must be stripped first (S2);
 * `mime` = the type of what's served (for the extension, never the uploader's file name).
 */
export type VariantFile = { key: string; watermark: boolean; strip: boolean; mime: string };

type VariantItem = Pick<MediaItem, "kind" | "mime" | "householdId" | "thumbKey" | "webKey" | "originalKey"> & Partial<Pick<MediaItem, "shareKey">>;

/**
 * What a guest gets instead of someone else's original (S2): JPEGs with their metadata stripped,
 * other photos as the clean full-size JPEG made with the renditions, videos as they are (not
 * re-muxed; ADR-0032). Null when there's no clean copy.
 */
function guestOriginal(item: VariantItem): VariantFile | null {
  if (item.kind === "video") return { key: item.originalKey, watermark: false, strip: false, mime: item.mime };
  if (item.mime === "image/jpeg") return { key: item.originalKey, watermark: false, strip: true, mime: "image/jpeg" };
  return item.shareKey ? { key: item.shareKey, watermark: false, strip: false, mime: "image/jpeg" } : null;
}

/**
 * Which file a variant serves for this viewer, or null.
 * - The team and vendors get true originals; a family gets its own uploads as they are.
 * - Other guests: web resolution (watermarked when the family set a watermark, GAL-10/S4).
 *   Originals only when the family allowed them (GAL-06) and no watermark is set, and then
 *   without location or camera metadata (S2). Never a file whose preview failed to decode.
 */
export function variantFor(viewer: Viewer, item: VariantItem, variant: Variant, settings: Pick<GallerySettings, "guestOriginals"> & Partial<Pick<GallerySettings, "watermarkText">>): VariantFile | null {
  const plain = (key: string, mime: string): VariantFile => ({ key, watermark: false, strip: false, mime });
  const web = item.webKey ? plain(item.webKey, "image/webp") : null;
  if (variant === "thumb") return item.thumbKey ? plain(item.thumbKey, "image/webp") : null;
  const trusted = viewer.kind !== "guest" || item.householdId === viewer.householdId;
  if (trusted) {
    if (variant === "web" && item.kind === "photo" && web) return web;
    return plain(item.originalKey, item.mime);
  }
  const wm = !!settings.watermarkText;
  const originals = settings.guestOriginals && !wm;
  if (item.kind === "video") return variant === "original" && !originals ? null : plain(item.originalKey, item.mime);
  const marked = web ? { ...web, watermark: wm, mime: wm ? "image/jpeg" : web.mime } : null;
  switch (variant) {
    case "web":
      return marked;
    case "original":
      return originals ? guestOriginal(item) : null;
    case "download":
      return (originals ? guestOriginal(item) : null) ?? marked;
  }
}

export type LoadedMedia = MediaItem & { album: GalleryAlbum; functionName: string };

/** Loads an item the viewer may see (null otherwise, so callers answer 404 either way). */
export async function loadMediaForViewer(db: Tx, eventId: string, mediaId: string, viewer: Viewer): Promise<LoadedMedia | null> {
  if (!z.string().uuid().safeParse(mediaId).success) return null;
  const [row] = await db
    .select({ item: mediaItems, album: galleryAlbums, functionName: functions.name })
    .from(mediaItems)
    .innerJoin(galleryAlbums, eq(galleryAlbums.id, mediaItems.albumId))
    .innerJoin(functions, eq(functions.id, mediaItems.functionId))
    .where(and(eq(mediaItems.id, mediaId), eq(mediaItems.eventId, eventId)));
  if (!row) return null;
  let shared: string[] = [];
  if (viewer.kind === "vendor") {
    const s = await db
      .select({ vendorId: albumSelections.vendorId })
      .from(albumSelectionItems)
      .innerJoin(albumSelections, eq(albumSelections.id, albumSelectionItems.selectionId))
      .where(and(eq(albumSelectionItems.mediaId, mediaId), eq(albumSelections.vendorId, viewer.vendorId), isNotNull(albumSelections.sharedAt)));
    shared = s.map((x) => x.vendorId!).filter(Boolean);
  }
  const ok = canViewMedia(viewer, { ...row.item, albumReleased: !!row.album.releasedAt, sharedWithVendorIds: shared });
  return ok ? { ...row.item, album: row.album, functionName: row.functionName } : null;
}

// ---------------------------------------------------------------------------
// Listing (keyset pages on (taken_at, id), GAL-01)
// ---------------------------------------------------------------------------

export const PAGE_SIZE = 60;

export type Cursor = { t: Date; id: string };

export function encodeCursor(item: Pick<MediaItem, "takenAt" | "id">) {
  return `${item.takenAt.getTime()}_${item.id}`;
}

export function decodeCursor(raw: unknown): Cursor | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/^(\d{1,15})_([0-9a-f-]{36})$/);
  return m ? { t: new Date(Number(m[1])), id: m[2] } : null;
}

const after = (c: Cursor | null): SQL | undefined => (c ? sql`(${mediaItems.takenAt}, ${mediaItems.id}) > (${c.t}, ${c.id})` : undefined);

export type MediaPage = { items: MediaItem[]; next: string | null };

async function page(db: Tx, where: SQL | undefined, cursor: Cursor | null, limit = PAGE_SIZE): Promise<MediaPage> {
  const rows = await db
    .select()
    .from(mediaItems)
    .where(and(where, after(cursor)))
    .orderBy(asc(mediaItems.takenAt), asc(mediaItems.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  return { items, next: rows.length > limit ? encodeCursor(items[items.length - 1]) : null };
}

/** An album's items for the team (or the delivering vendor), oldest capture first. */
export async function listAlbumMedia(db: Tx, eventId: string, albumId: string, cursor: Cursor | null, opts: { limit?: number; vendorId?: string } = {}) {
  return page(
    db,
    and(
      eq(mediaItems.eventId, eventId),
      eq(mediaItems.albumId, albumId),
      ne(mediaItems.status, "uploading"),
      opts.vendorId ? and(eq(mediaItems.vendorId, opts.vendorId), eq(mediaItems.uploaderKind, "vendor")) : undefined,
    ),
    cursor,
    opts.limit,
  );
}

/** What a family sees for one function: released, approved items plus their own uploads. */
export async function listGuestMedia(db: Tx, eventId: string, viewer: Extract<Viewer, { kind: "guest" }>, functionId: string, cursor: Cursor | null, limit = PAGE_SIZE) {
  if (!viewer.functionIds.includes(functionId)) return { items: [], next: null };
  return page(
    db,
    and(
      eq(mediaItems.eventId, eventId),
      eq(mediaItems.functionId, functionId),
      ne(mediaItems.status, "uploading"),
      or(
        eq(mediaItems.householdId, viewer.householdId),
        and(
          eq(mediaItems.status, "approved"),
          sql`exists (select 1 from ${galleryAlbums} a where a.id = ${mediaItems.albumId} and a.released_at is not null)`,
        ),
      ),
    ),
    cursor,
    limit,
  );
}

/** A family's gallery overview: their invited functions with how many items they can see. */
export async function guestGalleryOverview(db: Tx, eventId: string, viewer: Extract<Viewer, { kind: "guest" }>) {
  if (viewer.functionIds.length === 0) return [];
  const rows = await db
    .select({
      id: functions.id,
      name: functions.name,
      date: functions.date,
      startTime: functions.startTime,
      visible: sql<number>`count(${mediaItems.id}) filter (where ${mediaItems.status} = 'approved' and ${galleryAlbums.releasedAt} is not null)`.mapWith(Number),
      own: sql<number>`count(${mediaItems.id}) filter (where ${mediaItems.householdId} = ${viewer.householdId} and ${mediaItems.status} <> 'uploading')`.mapWith(Number),
      coverId: sql<string | null>`(array_agg(${mediaItems.id} order by ${mediaItems.takenAt}) filter (where ${mediaItems.status} = 'approved' and ${galleryAlbums.releasedAt} is not null and ${mediaItems.thumbKey} is not null))[1]`,
    })
    .from(functions)
    .leftJoin(mediaItems, eq(mediaItems.functionId, functions.id))
    .leftJoin(galleryAlbums, eq(galleryAlbums.id, mediaItems.albumId))
    .where(and(eq(functions.eventId, eventId), inArray(functions.id, viewer.functionIds)))
    .groupBy(functions.id)
    .orderBy(sql`${functions.date} asc nulls last`, sql`${functions.startTime} asc nulls last`);
  return rows;
}

/** Does the site have anything gallery-ish for this family (nav link)? */
export async function guestHasGallery(db: Tx, eventId: string, viewer: Extract<Viewer, { kind: "guest" }>) {
  const settings = await getGallerySettings(db, eventId);
  if (settings.guestUploads && viewer.functionIds.length > 0) return true;
  const overview = await guestGalleryOverview(db, eventId, viewer);
  return overview.some((f) => f.visible > 0 || f.own > 0);
}

// ---------------------------------------------------------------------------
// Moderation, highlights, deletion (GAL-04, GAL-05)
// ---------------------------------------------------------------------------

/** The moderation queue: guest uploads waiting for a Host/Planner, oldest first. */
export async function moderationQueue(db: Tx, eventId: string, cursor: Cursor | null, limit = PAGE_SIZE) {
  return page(db, and(eq(mediaItems.eventId, eventId), eq(mediaItems.status, "pending")), cursor, limit);
}

export async function pendingCount(db: Tx, eventId: string) {
  const [{ n }] = await db
    .select({ n: count() })
    .from(mediaItems)
    .where(and(eq(mediaItems.eventId, eventId), eq(mediaItems.status, "pending")));
  return n;
}

/** Approve or hide items (only ones that finished processing). Returns how many changed. */
export async function moderate(db: Database, input: { eventId: string; actor: Actor; mediaIds: string[]; action: "approve" | "hide"; now?: Date }) {
  const ids = input.mediaIds.filter((id) => z.string().uuid().safeParse(id).success).slice(0, 500);
  if (ids.length === 0) return 0;
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(mediaItems)
      .set(input.action === "approve" ? { status: "approved", approvedBy: input.actor.userId, approvedAt: now } : { status: "hidden", highlight: false })
      .where(and(eq(mediaItems.eventId, input.eventId), inArray(mediaItems.id, ids), inArray(mediaItems.status, ["pending", "approved", "hidden"])))
      .returning({ id: mediaItems.id });
    if (rows.length) {
      await audit(tx, {
        eventId: input.eventId,
        actor: input.actor,
        action: input.action === "approve" ? "gallery.approved" : "gallery.hidden",
        entityType: "media",
        entityId: rows.length === 1 ? rows[0].id : undefined,
        data: { count: rows.length },
      });
    }
    return rows.length;
  });
}

/**
 * What may be on the public website (GAL-05, S5): approved photos with a web copy, in a released
 * album of a public function. Checked when picking and again whenever highlights are read.
 */
const highlightable = () =>
  and(
    eq(mediaItems.status, "approved"),
    eq(mediaItems.kind, "photo"),
    isNotNull(mediaItems.webKey),
    sql`exists (select 1 from ${galleryAlbums} a join ${functions} f on f.id = a.function_id where a.id = ${mediaItems.albumId} and a.released_at is not null and f.is_public)`,
  );

/** Picks (or un-picks) a photo for the public website (GAL-05). Audited. */
export async function setHighlight(db: Database, input: { eventId: string; actor: Actor; mediaId: string; on: boolean }) {
  if (!z.string().uuid().safeParse(input.mediaId).success) throw new GalleryError("not_found");
  await db.transaction(async (tx) => {
    const [item] = await tx
      .select({ id: mediaItems.id, ok: sql<boolean>`${highlightable()!}` })
      .from(mediaItems)
      .where(and(eq(mediaItems.eventId, input.eventId), eq(mediaItems.id, input.mediaId)))
      .for("update");
    if (!item) throw new GalleryError("not_found");
    if (input.on && !item.ok) throw new GalleryError("not_public");
    await tx.update(mediaItems).set({ highlight: input.on }).where(eq(mediaItems.id, item.id));
    await audit(tx, { eventId: input.eventId, actor: input.actor, action: input.on ? "gallery.highlight_added" : "gallery.highlight_removed", entityType: "media", entityId: item.id });
  });
}

/** Highlighted photos, for the website's gallery section. */
export async function listHighlights(db: Tx, eventId: string, limit = 60) {
  return db
    .select({ id: mediaItems.id, width: mediaItems.width, height: mediaItems.height })
    .from(mediaItems)
    .where(and(eq(mediaItems.eventId, eventId), eq(mediaItems.highlight, true), highlightable()))
    .orderBy(asc(mediaItems.takenAt), asc(mediaItems.id))
    .limit(limit);
}

/** One highlighted photo's web copy key, if it may still be shown on the website. */
export async function highlightWebKey(db: Tx, eventId: string, mediaId: string) {
  if (!z.string().uuid().safeParse(mediaId).success) return null;
  const [row] = await db
    .select({ webKey: mediaItems.webKey })
    .from(mediaItems)
    .where(and(eq(mediaItems.eventId, eventId), eq(mediaItems.id, mediaId), eq(mediaItems.highlight, true), highlightable()));
  return row?.webKey ?? null;
}

/** Clears highlights that may no longer be public (album withdrawn, function made private). */
export async function clearHighlights(db: Tx, eventId: string, where: { albumId?: string; functionId?: string }) {
  await db
    .update(mediaItems)
    .set({ highlight: false })
    .where(
      and(
        eq(mediaItems.eventId, eventId),
        eq(mediaItems.highlight, true),
        where.albumId ? eq(mediaItems.albumId, where.albumId) : undefined,
        where.functionId ? eq(mediaItems.functionId, where.functionId) : undefined,
      ),
    );
}

/** Deletes an item inside a transaction: frees its quota and queues its files for deletion. */
async function deleteItemTx(tx: Tx, item: MediaItem) {
  if (item.status === "uploading") await release(tx, item.eventId, item.reservedBytes, { householdId: item.householdId, reservationId: item.reservationId });
  else await free(tx, item.eventId, item.originalBytes, { householdId: item.householdId });
  await tx.delete(mediaItems).where(eq(mediaItems.id, item.id));
  return queueStorageDeletion(tx, mediaPrefix(item), "gallery_item");
}

/**
 * Before a family is erased (EVT-09): gives back the space of its uploads (stored originals and
 * uploads in flight) in the caller's transaction, so usage drops at once instead of waiting for
 * the nightly reconcile. The rows, household counters and reservation rows then go by cascade;
 * the files go with the household prefix.
 */
export async function releaseHouseholdMedia(tx: Tx, eventId: string, householdId: string) {
  const rows = await tx
    .select()
    .from(mediaItems)
    .where(and(eq(mediaItems.eventId, eventId), eq(mediaItems.householdId, householdId)))
    .for("update");
  for (const item of rows) {
    if (item.status === "uploading") await release(tx, eventId, item.reservedBytes, { householdId, reservationId: item.reservationId });
    else await free(tx, eventId, item.originalBytes, { householdId });
  }
  return rows.length;
}

/** Deletes items for good (members). Returns storage deletion ids to run right away. */
export async function deleteMedia(db: Database, input: { eventId: string; actor: Actor; mediaIds: string[] }) {
  const ids = input.mediaIds.filter((id) => z.string().uuid().safeParse(id).success).slice(0, 500);
  if (ids.length === 0) return [];
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.eventId, input.eventId), inArray(mediaItems.id, ids)))
      .for("update");
    const out: number[] = [];
    for (const r of rows) out.push(await deleteItemTx(tx, r));
    if (rows.length) {
      await audit(tx, { eventId: input.eventId, actor: input.actor, action: "gallery.deleted", entityType: "media", entityId: rows.length === 1 ? rows[0].id : undefined, data: { count: rows.length, filename: rows[0].filename } });
    }
    return out;
  });
}

/** A family deletes one of its own uploads. */
export async function deleteOwnUpload(db: Database, input: { eventId: string; householdId: string; mediaId: string }) {
  if (!z.string().uuid().safeParse(input.mediaId).success) throw new GalleryError("not_found");
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.eventId, input.eventId), eq(mediaItems.id, input.mediaId), eq(mediaItems.householdId, input.householdId)))
      .for("update");
    if (!row) throw new GalleryError("not_found");
    return [await deleteItemTx(tx, row)];
  });
}

/** A vendor deletes one of its own deliveries (e.g. a wrong file) before the album is released. */
export async function deleteVendorUpload(db: Database, input: { eventId: string; vendorId: string; mediaId: string }) {
  if (!z.string().uuid().safeParse(input.mediaId).success) throw new GalleryError("not_found");
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ item: mediaItems, releasedAt: galleryAlbums.releasedAt })
      .from(mediaItems)
      .innerJoin(galleryAlbums, eq(galleryAlbums.id, mediaItems.albumId))
      .where(and(eq(mediaItems.eventId, input.eventId), eq(mediaItems.id, input.mediaId), eq(mediaItems.vendorId, input.vendorId), eq(mediaItems.uploaderKind, "vendor")))
      .for("update", { of: mediaItems });
    if (!row || row.releasedAt) throw new GalleryError("not_found");
    return [await deleteItemTx(tx, row.item)];
  });
}

// ---------------------------------------------------------------------------
// Release + "your photos are ready" (GAL-02, GAL-11)
// ---------------------------------------------------------------------------

export type ReleaseResult = { album: GalleryAlbum; notified: number; quota: string | null };

/** The households to tell when a function's photos are ready: anyone invited to it. */
async function invitedHouseholds(db: Tx, eventId: string, functionId: string) {
  const rows = await db
    .selectDistinct({ id: households.id, locale: households.locale, preferred: households.preferredChannel })
    .from(functionInvites)
    .innerJoin(guests, eq(guests.id, functionInvites.guestId))
    .innerJoin(households, eq(households.id, guests.householdId))
    .where(and(eq(functionInvites.functionId, functionId), eq(households.eventId, eventId), isNull(households.linkRevokedAt)));
  return rows;
}

const CHANNEL_SET = new Set(["whatsapp", "email", "sms"]);

/**
 * Releases (or withdraws) an album. The first release in a function sends invited families a
 * "photos are ready" message (GAL-11) through the outbox, bulk and quota-checked; the idempotency
 * key is per (function, family), so later albums and re-releases don't message again. If the
 * messaging limit is reached the release still happens and `quota` names the channel.
 */
export async function releaseAlbum(db: Database, input: { eventId: string; actor: Actor; albumId: string; release: boolean; appUrl: string; now?: Date }): Promise<ReleaseResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const album = await getAlbum(tx, input.eventId, input.albumId);
    const [u] = await tx
      .update(galleryAlbums)
      .set(input.release ? { releasedAt: album.releasedAt ?? now, releasedBy: album.releasedBy ?? input.actor.userId } : { releasedAt: null, releasedBy: null })
      .where(eq(galleryAlbums.id, album.id))
      .returning();
    await audit(tx, {
      eventId: input.eventId,
      actor: input.actor,
      action: input.release ? "gallery.album_released" : "gallery.album_withdrawn",
      entityType: "gallery_album",
      entityId: album.id,
      data: { title: album.title },
    });
    // Withdrawn photos can't stay on the public website (S5).
    if (!input.release) await clearHighlights(tx, input.eventId, { albumId: album.id });
    if (!input.release || album.kind === "guest") return { album: u, notified: 0, quota: null };
    const r = await notifyFunctionReady(tx, { eventId: input.eventId, functionId: album.functionId, appUrl: input.appUrl });
    return { album: u, ...r };
  });
}

/**
 * "Photos from <function> are ready" to every invited family (GAL-11), at most once per function:
 * on release, and again when items of an already-released album finish processing (the release
 * may have come first). Bulk and quota-checked through the outbox; the idempotency key is per
 * (function, family). When the messaging limit refuses it, the function is marked `quota` so
 * Hosts see a "Send now" button; `force` retries that. Nothing happens while the function has no
 * approved items in a released (non-guest) album.
 */
export async function notifyFunctionReady(tx: Tx, input: { eventId: string; functionId: string; appUrl: string; force?: boolean }): Promise<{ notified: number; quota: string | null }> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`gallery-ready:${input.functionId}`}))`);
  const [notice] = await tx.select().from(galleryReadyNotices).where(eq(galleryReadyNotices.functionId, input.functionId));
  if (notice?.status === "sent" || (notice?.status === "quota" && !input.force)) return { notified: 0, quota: notice.status === "quota" ? notice.channel : null };
  const [{ n }] = await tx
    .select({ n: count() })
    .from(mediaItems)
    .innerJoin(galleryAlbums, eq(galleryAlbums.id, mediaItems.albumId))
    .where(
      and(
        eq(mediaItems.eventId, input.eventId),
        eq(mediaItems.functionId, input.functionId),
        eq(mediaItems.status, "approved"),
        isNotNull(galleryAlbums.releasedAt),
        ne(galleryAlbums.kind, "guest"),
      ),
    );
  if (n === 0) return { notified: 0, quota: null };

  const hh = await invitedHouseholds(tx, input.eventId, input.functionId);
  const contacts = await recipientsFor(tx, input.eventId, hh.map((h) => h.id));
  const items: EnqueueItem[] = [];
  for (const h of hh) {
    const c = contacts.get(h.id)?.[0];
    if (!c) continue;
    items.push({
      eventId: input.eventId,
      purpose: "broadcast",
      templateKey: "gallery_ready",
      vars: { appUrl: input.appUrl, functionId: input.functionId },
      recipient: {
        householdId: h.id,
        guestId: c.guestId,
        addresses: { whatsapp: c.phone, sms: c.phone, email: c.email },
        locale: h.locale,
        preferred: h.preferred && CHANNEL_SET.has(h.preferred) ? (h.preferred as "whatsapp" | "email" | "sms") : null,
      },
      bulk: true,
      key: `gal:${input.functionId}:${h.id}`,
    });
  }
  if (items.length === 0) return { notified: 0, quota: null };
  const mark = (status: "sent" | "quota", channel: string | null) =>
    tx
      .insert(galleryReadyNotices)
      .values({ functionId: input.functionId, eventId: input.eventId, status, channel, updatedAt: new Date() })
      .onConflictDoUpdate({ target: galleryReadyNotices.functionId, set: { status, channel, updatedAt: new Date() } });
  try {
    const res = await enqueue(tx, items);
    await mark("sent", null);
    return { notified: res.queued, quota: null };
  } catch (e) {
    if (!(e instanceof QuotaError)) throw e;
    await mark("quota", e.channel);
    return { notified: 0, quota: e.channel };
  }
}

/** A function's "photos are ready" state (album page: "Send now" when the limit refused it). */
export async function readyNotice(db: Tx, eventId: string, functionId: string) {
  const [row] = await db
    .select()
    .from(galleryReadyNotices)
    .where(and(eq(galleryReadyNotices.functionId, functionId), eq(galleryReadyNotices.eventId, eventId)));
  return row ?? null;
}

/** Hosts retry a "photos are ready" message the messaging limit refused (GAL-11). */
export async function sendReadyNow(db: Database, input: { eventId: string; actor: Actor; albumId: string; appUrl: string }) {
  return db.transaction(async (tx) => {
    const album = await getAlbum(tx, input.eventId, input.albumId);
    const r = await notifyFunctionReady(tx, { eventId: input.eventId, functionId: album.functionId, appUrl: input.appUrl, force: true });
    if (r.notified > 0) {
      await audit(tx, { eventId: input.eventId, actor: input.actor, action: "gallery.ready_sent", entityType: "gallery_album", entityId: album.id, data: { count: r.notified } });
    }
    return r;
  });
}

// ---------------------------------------------------------------------------
// Favourites and album selection (GAL-07)
// ---------------------------------------------------------------------------

async function assertReady(db: Tx, eventId: string, mediaId: string) {
  if (!z.string().uuid().safeParse(mediaId).success) throw new GalleryError("not_found");
  const [row] = await db
    .select({ id: mediaItems.id })
    .from(mediaItems)
    .where(and(eq(mediaItems.eventId, eventId), eq(mediaItems.id, mediaId), ne(mediaItems.status, "uploading")));
  if (!row) throw new GalleryError("not_found");
}

export async function toggleFavourite(db: Tx, input: { eventId: string; userId: string; mediaId: string }) {
  await assertReady(db, input.eventId, input.mediaId);
  const removed = await db
    .delete(mediaFavourites)
    .where(and(eq(mediaFavourites.mediaId, input.mediaId), eq(mediaFavourites.userId, input.userId)))
    .returning({ id: mediaFavourites.mediaId });
  if (removed.length) return false;
  await db.insert(mediaFavourites).values({ eventId: input.eventId, mediaId: input.mediaId, userId: input.userId }).onConflictDoNothing();
  return true;
}

export async function isFavourite(db: Tx, mediaId: string, userId: string) {
  const [r] = await db
    .select({ id: mediaFavourites.mediaId })
    .from(mediaFavourites)
    .where(and(eq(mediaFavourites.mediaId, mediaId), eq(mediaFavourites.userId, userId)));
  return !!r;
}

/** Favourites across the family (or one member's), newest first. */
export async function listFavourites(db: Tx, eventId: string, opts: { userId?: string; limit?: number } = {}) {
  return db
    .select({ item: mediaItems, votes: sql<number>`count(*)`.mapWith(Number) })
    .from(mediaFavourites)
    .innerJoin(mediaItems, eq(mediaItems.id, mediaFavourites.mediaId))
    .where(and(eq(mediaFavourites.eventId, eventId), opts.userId ? eq(mediaFavourites.userId, opts.userId) : undefined))
    .groupBy(mediaItems.id)
    .orderBy(desc(sql`max(${mediaFavourites.createdAt})`))
    .limit(opts.limit ?? 500);
}

export const selectionSchema = z.object({
  bookingId: z.string().uuid(),
  title: titleSchema,
  deadline: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  note: z
    .string()
    .trim()
    .max(1000)
    .transform((s) => s || null)
    .nullable(),
});

/** An album selection for a photographer/videographer's booking. */
export async function createSelection(db: Database, eventId: string, actor: Actor, raw: z.input<typeof selectionSchema>) {
  const parsed = selectionSchema.safeParse(raw);
  if (!parsed.success) throw new GalleryError("invalid");
  return db.transaction(async (tx) => {
    const [b] = await photoBookings(tx, eventId, { bookingId: parsed.data.bookingId });
    if (!b) throw new GalleryError("not_booked");
    const [s] = await tx
      .insert(albumSelections)
      .values({ eventId, bookingId: b.bookingId, vendorId: b.vendorId, title: parsed.data.title, deadline: parsed.data.deadline, note: parsed.data.note, createdBy: actor.userId })
      .returning();
    await audit(tx, { eventId, actor, action: "gallery.selection_created", entityType: "album_selection", entityId: s.id, data: { title: s.title } });
    return s;
  });
}

export async function updateSelection(db: Tx, eventId: string, selectionId: string, raw: { title: string; deadline: string | null; note: string | null }) {
  const parsed = selectionSchema.omit({ bookingId: true }).safeParse(raw);
  if (!parsed.success) throw new GalleryError("invalid");
  const s = await getSelection(db, eventId, selectionId);
  await db.update(albumSelections).set(parsed.data).where(eq(albumSelections.id, s.id));
}

export async function getSelection(db: Tx, eventId: string, selectionId: string, opts: { vendorId?: string } = {}) {
  if (!z.string().uuid().safeParse(selectionId).success) throw new GalleryError("not_found");
  const [s] = await db
    .select()
    .from(albumSelections)
    .where(
      and(
        eq(albumSelections.id, selectionId),
        eq(albumSelections.eventId, eventId),
        opts.vendorId ? and(eq(albumSelections.vendorId, opts.vendorId), isNotNull(albumSelections.sharedAt)) : undefined,
      ),
    );
  if (!s) throw new GalleryError("not_found");
  return s;
}

export async function listSelections(db: Tx, eventId: string, opts: { vendorId?: string } = {}) {
  return db
    .select({ selection: albumSelections, items: sql<number>`(select count(*) from ${albumSelectionItems} i where i.selection_id = ${albumSelections.id})`.mapWith(Number) })
    .from(albumSelections)
    .where(and(eq(albumSelections.eventId, eventId), opts.vendorId ? and(eq(albumSelections.vendorId, opts.vendorId), isNotNull(albumSelections.sharedAt)) : undefined))
    .orderBy(desc(albumSelections.createdAt));
}

export async function selectionItems(db: Tx, eventId: string, selectionId: string) {
  return db
    .select({ item: mediaItems, functionName: functions.name })
    .from(albumSelectionItems)
    .innerJoin(mediaItems, eq(mediaItems.id, albumSelectionItems.mediaId))
    .innerJoin(functions, eq(functions.id, mediaItems.functionId))
    .where(and(eq(albumSelectionItems.selectionId, selectionId), eq(albumSelectionItems.eventId, eventId)))
    .orderBy(asc(mediaItems.takenAt), asc(mediaItems.id));
}

/** Adds items (or every family favourite with `favourites: true`). Returns how many were new. */
export async function addToSelection(db: Tx, input: { eventId: string; selectionId: string; mediaIds?: string[]; favourites?: boolean }) {
  const s = await getSelection(db, input.eventId, input.selectionId);
  let ids = (input.mediaIds ?? []).filter((id) => z.string().uuid().safeParse(id).success);
  if (input.favourites) ids = [...ids, ...(await listFavourites(db, input.eventId)).map((f) => f.item.id)];
  if (ids.length === 0) return 0;
  const ok = await db
    .select({ id: mediaItems.id })
    .from(mediaItems)
    .where(and(eq(mediaItems.eventId, input.eventId), inArray(mediaItems.id, [...new Set(ids)]), ne(mediaItems.status, "uploading")));
  if (ok.length === 0) return 0;
  const rows = await db
    .insert(albumSelectionItems)
    .values(ok.map((r) => ({ eventId: input.eventId, selectionId: s.id, mediaId: r.id })))
    .onConflictDoNothing()
    .returning({ id: albumSelectionItems.mediaId });
  return rows.length;
}

export async function removeFromSelection(db: Tx, input: { eventId: string; selectionId: string; mediaId: string }) {
  const s = await getSelection(db, input.eventId, input.selectionId);
  await db.delete(albumSelectionItems).where(and(eq(albumSelectionItems.selectionId, s.id), eq(albumSelectionItems.mediaId, input.mediaId)));
}

export async function deleteSelection(db: Tx, input: { eventId: string; selectionId: string }) {
  const s = await getSelection(db, input.eventId, input.selectionId);
  await db.delete(albumSelections).where(eq(albumSelections.id, s.id));
}

/** Shares (or re-shares after changes) the selection with the photographer and notifies them. */
export async function shareSelection(db: Database, input: { eventId: string; actor: Actor; selectionId: string; now?: Date }) {
  return db.transaction(async (tx) => {
    const s = await getSelection(tx, input.eventId, input.selectionId);
    if (!s.vendorId) throw new GalleryError("not_booked");
    const [{ n }] = await tx.select({ n: count() }).from(albumSelectionItems).where(eq(albumSelectionItems.selectionId, s.id));
    if (n === 0) throw new GalleryError("invalid");
    const [u] = await tx
      .update(albumSelections)
      .set({ sharedAt: input.now ?? new Date(), sharedBy: input.actor.userId })
      .where(eq(albumSelections.id, s.id))
      .returning();
    await notify(tx, {
      eventId: input.eventId,
      userIds: await vendorUserIds(tx, [s.vendorId]),
      kind: "vendor.gallery_selection",
      data: { title: s.title, count: n, deadline: s.deadline ?? "" },
      href: `/vendor/${s.vendorId}/gallery/selections/${s.id}`,
    });
    await audit(tx, { eventId: input.eventId, actor: input.actor, action: "gallery.selection_shared", entityType: "album_selection", entityId: s.id, data: { title: s.title, count: n } });
    return u;
  });
}

// ---------------------------------------------------------------------------
// Likes and comments (GAL-08)
// ---------------------------------------------------------------------------

async function guestCanReact(db: Tx, eventId: string, viewer: Extract<Viewer, { kind: "guest" }>, mediaId: string) {
  const settings = await getGallerySettings(db, eventId);
  if (!settings.reactions) throw new GalleryError("reactions_off");
  const item = await loadMediaForViewer(db, eventId, mediaId, viewer);
  if (!item || item.status !== "approved") throw new GalleryError("not_found");
  return item;
}

export async function toggleLike(db: Tx, eventId: string, viewer: Extract<Viewer, { kind: "guest" }>, mediaId: string) {
  await guestCanReact(db, eventId, viewer, mediaId);
  const removed = await db
    .delete(mediaLikes)
    .where(and(eq(mediaLikes.mediaId, mediaId), eq(mediaLikes.householdId, viewer.householdId)))
    .returning({ id: mediaLikes.mediaId });
  if (removed.length) return false;
  await db.insert(mediaLikes).values({ eventId, mediaId, householdId: viewer.householdId }).onConflictDoNothing();
  return true;
}

export const commentSchema = z.string().trim().min(1).max(500);

export async function addComment(db: Tx, eventId: string, viewer: Extract<Viewer, { kind: "guest" }>, mediaId: string, body: string, now = new Date()) {
  const text = commentSchema.safeParse(body);
  if (!text.success) throw new GalleryError("invalid");
  await guestCanReact(db, eventId, viewer, mediaId);
  if (!(await allowAttempt(db, "gallery-comment", viewer.householdId, 30, 3600_000, now))) throw new GalleryError("rate_limited");
  const [c] = await db.insert(mediaComments).values({ eventId, mediaId, householdId: viewer.householdId, body: text.data, createdAt: now }).returning();
  return c;
}

export async function hideComment(db: Database, input: { eventId: string; actor: Actor; commentId: string; hidden: boolean }) {
  if (!z.string().uuid().safeParse(input.commentId).success) throw new GalleryError("not_found");
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(mediaComments)
      .set(input.hidden ? { hiddenAt: new Date(), hiddenBy: input.actor.userId } : { hiddenAt: null, hiddenBy: null })
      .where(and(eq(mediaComments.id, input.commentId), eq(mediaComments.eventId, input.eventId)))
      .returning();
    if (!rows.length) throw new GalleryError("not_found");
    if (input.hidden) await audit(tx, { eventId: input.eventId, actor: input.actor, action: "gallery.comment_hidden", entityType: "media_comment", entityId: rows[0].id });
    return rows[0];
  });
}

/**
 * Likes and comments on an item. Guests never see other families' names (only "a guest");
 * members see family names and hidden comments.
 */
export async function reactionsFor(db: Tx, mediaId: string, opts: { householdId?: string; member?: boolean }) {
  const [{ likes }] = await db.select({ likes: count() }).from(mediaLikes).where(eq(mediaLikes.mediaId, mediaId));
  const liked = opts.householdId
    ? (await db.select({ id: mediaLikes.mediaId }).from(mediaLikes).where(and(eq(mediaLikes.mediaId, mediaId), eq(mediaLikes.householdId, opts.householdId)))).length > 0
    : false;
  const rows = await db
    .select({ comment: mediaComments, family: households.name })
    .from(mediaComments)
    .innerJoin(households, eq(households.id, mediaComments.householdId))
    .where(and(eq(mediaComments.mediaId, mediaId), opts.member ? undefined : isNull(mediaComments.hiddenAt)))
    .orderBy(asc(mediaComments.createdAt))
    .limit(200);
  const comments = rows.map((r) => ({
    id: r.comment.id,
    body: r.comment.body,
    createdAt: r.comment.createdAt,
    hidden: !!r.comment.hiddenAt,
    mine: !!opts.householdId && r.comment.householdId === opts.householdId,
    family: opts.member ? r.family : null,
  }));
  return { likes, liked, comments };
}

// ---------------------------------------------------------------------------
// Removal requests (GAL-04)
// ---------------------------------------------------------------------------

export const reasonSchema = z
  .string()
  .trim()
  .max(500)
  .transform((s) => s || null);

/** A family asks for a photo to be taken down; the team is notified. */
export async function requestRemoval(db: Database, eventId: string, viewer: Extract<Viewer, { kind: "guest" }>, mediaId: string, reason: string) {
  const r = reasonSchema.safeParse(reason);
  if (!r.success) throw new GalleryError("invalid");
  return db.transaction(async (tx) => {
    const item = await loadMediaForViewer(tx, eventId, mediaId, viewer);
    if (!item) throw new GalleryError("not_found");
    if (!(await allowAttempt(tx, "gallery-removal", viewer.householdId, 20, 24 * 3600_000))) throw new GalleryError("rate_limited");
    const [open] = await tx
      .select({ id: mediaRemovalRequests.id })
      .from(mediaRemovalRequests)
      .where(and(eq(mediaRemovalRequests.mediaId, mediaId), eq(mediaRemovalRequests.householdId, viewer.householdId), eq(mediaRemovalRequests.status, "open")));
    if (open) throw new GalleryError("already_requested");
    const [req] = await tx.insert(mediaRemovalRequests).values({ eventId, mediaId, householdId: viewer.householdId, reason: r.data }).returning();
    const [h] = await tx.select({ name: households.name }).from(households).where(eq(households.id, viewer.householdId));
    const members = await tx.select({ userId: eventMembers.userId }).from(eventMembers).where(eq(eventMembers.eventId, eventId));
    await notify(tx, {
      eventId,
      userIds: members.map((m) => m.userId),
      kind: "gallery.removal_requested",
      data: { family: h?.name ?? "", function: item.functionName },
      href: `/events/${eventId}/gallery/removals`,
    });
    await audit(tx, { eventId, actor: null, action: "gallery.removal_requested", entityType: "media", entityId: mediaId, data: { family: h?.name ?? "" } });
    return req;
  });
}

export async function listRemovalRequests(db: Tx, eventId: string, status: "open" | "closed" = "open") {
  return db
    .select({ request: mediaRemovalRequests, family: households.name, item: mediaItems })
    .from(mediaRemovalRequests)
    .leftJoin(households, eq(households.id, mediaRemovalRequests.householdId))
    .leftJoin(mediaItems, eq(mediaItems.id, mediaRemovalRequests.mediaId))
    .where(and(eq(mediaRemovalRequests.eventId, eventId), status === "open" ? eq(mediaRemovalRequests.status, "open") : ne(mediaRemovalRequests.status, "open")))
    .orderBy(desc(mediaRemovalRequests.createdAt))
    .limit(200);
}

export async function openRemovalCount(db: Tx, eventId: string) {
  const [{ n }] = await db
    .select({ n: count() })
    .from(mediaRemovalRequests)
    .where(and(eq(mediaRemovalRequests.eventId, eventId), eq(mediaRemovalRequests.status, "open")));
  return n;
}

/** Remove (delete the item, closing every open request for it) or keep it. */
export async function decideRemoval(db: Database, input: { eventId: string; actor: Actor; requestId: string; decision: "remove" | "keep"; now?: Date }) {
  if (!z.string().uuid().safeParse(input.requestId).success) throw new GalleryError("not_found");
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [req] = await tx
      .select()
      .from(mediaRemovalRequests)
      .where(and(eq(mediaRemovalRequests.id, input.requestId), eq(mediaRemovalRequests.eventId, input.eventId)))
      .for("update");
    if (!req || req.status !== "open") throw new GalleryError("not_found");
    const deletions: number[] = [];
    if (input.decision === "remove" && req.mediaId) {
      await tx
        .update(mediaRemovalRequests)
        .set({ status: "removed", decidedBy: input.actor.userId, decidedAt: now })
        .where(and(eq(mediaRemovalRequests.mediaId, req.mediaId), eq(mediaRemovalRequests.status, "open")));
      const [item] = await tx.select().from(mediaItems).where(eq(mediaItems.id, req.mediaId)).for("update");
      if (item) deletions.push(await deleteItemTx(tx, item));
    } else {
      await tx
        .update(mediaRemovalRequests)
        .set({ status: input.decision === "remove" ? "removed" : "kept", decidedBy: input.actor.userId, decidedAt: now })
        .where(eq(mediaRemovalRequests.id, req.id));
    }
    await audit(tx, {
      eventId: input.eventId,
      actor: input.actor,
      action: input.decision === "remove" ? "gallery.removal_done" : "gallery.removal_kept",
      entityType: "media",
      entityId: req.mediaId ?? undefined,
    });
    return deletions;
  });
}

// ---------------------------------------------------------------------------
// ZIP downloads (GAL-06) and archive parts (EVT-08)
// ---------------------------------------------------------------------------

export type ZipItem = Pick<MediaItem, "id" | "filename" | "originalKey" | "originalBytes" | "takenAt" | "kind" | "mime" | "householdId" | "shareKey" | "previewError"> & {
  functionName: string;
  albumTitle: string;
  albumKind: GalleryAlbum["kind"];
};

/** Stored originals in a stable order (new uploads append), optionally one album/function. */
export async function zipItems(db: Tx, eventId: string, opts: { albumId?: string; functionId?: string; guest?: Extract<Viewer, { kind: "guest" }> } = {}): Promise<ZipItem[]> {
  const g = opts.guest;
  return db
    .select({
      id: mediaItems.id,
      filename: mediaItems.filename,
      originalKey: mediaItems.originalKey,
      originalBytes: mediaItems.originalBytes,
      takenAt: mediaItems.takenAt,
      kind: mediaItems.kind,
      mime: mediaItems.mime,
      householdId: mediaItems.householdId,
      shareKey: mediaItems.shareKey,
      previewError: mediaItems.previewError,
      functionName: functions.name,
      albumTitle: galleryAlbums.title,
      albumKind: galleryAlbums.kind,
    })
    .from(mediaItems)
    .innerJoin(galleryAlbums, eq(galleryAlbums.id, mediaItems.albumId))
    .innerJoin(functions, eq(functions.id, mediaItems.functionId))
    .where(
      and(
        eq(mediaItems.eventId, eventId),
        ne(mediaItems.status, "uploading"),
        opts.albumId ? eq(mediaItems.albumId, opts.albumId) : undefined,
        opts.functionId ? eq(mediaItems.functionId, opts.functionId) : undefined,
        g
          ? and(
              inArray(mediaItems.functionId, g.functionIds.length ? g.functionIds : ["00000000-0000-0000-0000-000000000000"]),
              or(eq(mediaItems.householdId, g.householdId), and(eq(mediaItems.status, "approved"), isNotNull(galleryAlbums.releasedAt))),
            )
          : undefined,
      ),
    )
    .orderBy(asc(mediaItems.createdAt), asc(mediaItems.id));
}

/**
 * Splits items into parts of at most `maxBytes` and `maxFiles` each (a bigger single file gets its
 * own part), so each part streams within one function's time limit.
 */
export function splitParts<T extends { originalBytes: number }>(items: T[], maxBytes = ZIP_PART_BYTES, maxFiles = ZIP_PART_FILES): T[][] {
  const parts: T[][] = [];
  let cur: T[] = [];
  let size = 0;
  for (const it of items) {
    if (cur.length && (size + it.originalBytes > maxBytes || cur.length >= maxFiles)) {
      parts.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(it);
    size += it.originalBytes;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

const safe = (s: string) =>
  s
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "_")
    .trim()
    .slice(-100) || "file";

/** `YYYY-MM-DD` of an instant in the event's timezone. */
export function localDay(at: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** The uploader's name without its extension (the extension comes from the verified type, S1). */
export const baseName = (filename: string) => safe(filename.replace(/\.[^.]{1,8}$/, "")).slice(0, 80) || "file";

/**
 * ZIP paths: `<function>/<album>/<date>-<id8>-<name>.<ext>`, unique by construction. The date is
 * the capture day in the event's timezone; the extension comes from the type actually served.
 * For a guest (`forHousehold`), other families' file names are never shown (S6): `<date>-<id8>`.
 */
export function zipPath(it: ZipItem, albumLabel: (kind: GalleryAlbum["kind"]) => string, timeZone: string, opts: { mime?: string; forHousehold?: string } = {}) {
  const album = it.albumTitle || albumLabel(it.albumKind);
  const showName = opts.forHousehold === undefined || it.householdId === opts.forHousehold;
  const stem = `${localDay(it.takenAt, timeZone)}-${it.id.slice(0, 8)}${showName ? `-${baseName(it.filename)}` : ""}`;
  return `${safe(it.functionName)}/${safe(album)}/${stem}.${extFor(opts.mime ?? it.mime)}`;
}

/**
 * The file a guest's ZIP holds for an item: their own uploads as they are; others' photos without
 * metadata (S2: stripped JPEG, or the clean JPEG copy), never one whose preview failed; videos as
 * they are. Null = leave it out.
 */
export function guestZipFile(it: ZipItem, householdId: string): { key: string; strip: boolean; mime: string } | null {
  if (it.householdId === householdId) return { key: it.originalKey, strip: false, mime: it.mime };
  if (it.kind === "video") return { key: it.originalKey, strip: false, mime: it.mime };
  if (it.previewError) return null;
  if (it.mime === "image/jpeg") return { key: it.originalKey, strip: true, mime: "image/jpeg" };
  return it.shareKey ? { key: it.shareKey, strip: false, mime: "image/jpeg" } : null;
}

/** A guest's ZIP of one function, split into parts: each entry with the file the guest gets. */
export async function guestZipParts(db: Tx, eventId: string, viewer: Extract<Viewer, { kind: "guest" }>, functionId: string) {
  const files: { it: ZipItem; file: NonNullable<ReturnType<typeof guestZipFile>>; originalBytes: number }[] = [];
  for (const it of await zipItems(db, eventId, { functionId, guest: viewer })) {
    const file = guestZipFile(it, viewer.householdId);
    if (file) files.push({ it, file, originalBytes: it.originalBytes });
  }
  return splitParts(files);
}

const DAY_MS = 24 * 3600_000;

/**
 * The family's full-gallery ZIP (§4.1: 5 full downloads per event per day). Every part counts
 * when it starts, per event and part number, so restarting at part 2 or fetching parts in
 * parallel doesn't get around the limit. False once that part was fetched 5 times today.
 */
export async function allowFullDownload(db: Tx, eventId: string, part: number, now = new Date()) {
  return allowAttempt(db, "gallery-zip-full", `${eventId}:${part}`, FULL_DOWNLOADS_PER_DAY, DAY_MS, now);
}

/**
 * A guest's ZIP part (S3): each part counts per family (GUEST_ZIP_PARTS_PER_DAY a day) and per
 * event and (function, part), with the same 5-a-day cap as the family's full downloads.
 */
export async function allowGuestZipPart(db: Tx, input: { eventId: string; householdId: string; functionId: string; part: number }, now = new Date()) {
  const eventKey = `${input.eventId}:${input.functionId}:${input.part}`;
  const [{ n }] = await db
    .select({ n: count() })
    .from(rateEvents)
    .where(and(eq(rateEvents.kind, "gallery-zip-guest-event"), eq(rateEvents.key, eventKey), gt(rateEvents.createdAt, new Date(now.getTime() - DAY_MS))));
  if (n >= FULL_DOWNLOADS_PER_DAY) return false;
  if (!(await allowAttempt(db, "gallery-zip-guest", input.householdId, GUEST_ZIP_PARTS_PER_DAY, DAY_MS, now))) return false;
  return allowAttempt(db, "gallery-zip-guest-event", eventKey, FULL_DOWNLOADS_PER_DAY, DAY_MS, now);
}

/** Bytes as KB/MB/GB with the locale's digit grouping (units stay Latin, as people write them). */
export function formatBytes(intlLocale: string, n: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${new Intl.NumberFormat(intlLocale, { maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 }).format(v)} ${units[i]}`;
}

export { StorageError };
