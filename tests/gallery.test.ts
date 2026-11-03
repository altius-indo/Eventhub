import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  eventLimitOverrides,
  eventStorageOverrides,
  functionInvites,
  galleryAlbums,
  guests,
  households,
  mediaItems,
  mediaRemovalRequests,
  notifications,
  outboundMessages,
  storageDeletions,
  storageHouseholdUsage,
  storageReservations,
  storageUsage,
} from "@/db/schema";
import "@/lib/approval-handlers";
import "@/lib/templates";
import { listArchiveParts, partEntries } from "@/lib/archive";
import { proposeBooking } from "@/lib/bookings";
import { listServiceTypes } from "@/lib/catalogue";
import { createEvent } from "@/lib/events";
import { createFunction, updateFunction } from "@/lib/functions";
import {
  abortUpload,
  addComment,
  addToSelection,
  allowFullDownload,
  allowGuestZipPart,
  GUEST_ZIP_PARTS_PER_DAY,
  guestZipFile,
  highlightWebKey,
  notifyFunctionReady,
  readyNotice,
  sendReadyNow,
  SWEEP_STEPS,
  ZIP_PART_FILES,
  zipPath,
  beginUpload,
  canViewMedia,
  completeUpload,
  createAlbum,
  createSelection,
  createVendorAlbum,
  decideRemoval,
  decodeCursor,
  deleteMedia,
  encodeCursor,
  FULL_DOWNLOADS_PER_DAY,
  getSelection,
  hideComment,
  listAlbumMedia,
  listGuestMedia,
  listHighlights,
  loadMediaForViewer,
  moderate,
  moderationQueue,
  photoBookings,
  reactionsFor,
  releaseAlbum,
  requestRemoval,
  setHighlight,
  shareSelection,
  splitParts,
  sweepOrphanObjects,
  sweepUploads,
  toggleFavourite,
  toggleLike,
  updateGallerySettings,
  variantFor,
  zipItems,
  type BeginResult,
  type Uploader,
  type Viewer,
} from "@/lib/gallery";
import { deleteHousehold } from "@/lib/guests";
import type { PolicySubject } from "@/lib/policy";
import { createQuoteRequests, getQuote, saveQuote } from "@/lib/quotes";
import { captureInstant, nextRenditionsDelay, processRenditions, readExifDate, RETRY_BASE_MS, watermark, watermarkedCopy, watermarkKey } from "@/lib/renditions";
import { NotJpegError, parseExif, sniffMime, stripJpegMetadata } from "@/lib/media-files";
import { addRequirement, addService } from "@/lib/services";
import { FsStore, setStoreForTests } from "@/lib/storage";
import { processStorageDeletions } from "@/lib/storage-gc";
import { getStorageUsage, reconcileUsage, releaseExpiredReservations } from "@/lib/storage-quota";
import { inviteVendorContact } from "@/lib/vendor-access";
import { createVendor } from "@/lib/vendors";
import { actorOf, db, makeUser, resetDb } from "./helpers";

let root: string;
let store: FsStore;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "eh-gallery-"));
  store = new FsStore(root);
  setStoreForTests(store);
});
afterAll(async () => {
  setStoreForTests(null);
  await rm(root, { recursive: true, force: true });
});
beforeEach(resetDb);

const hostS: PolicySubject = { isAppAdmin: false, membership: { role: "host", giftAccess: "none" } };
const blank = { startTime: "19:00", endTime: null, venueName: null, venueAddress: null, mapUrl: null, dressCode: null, description: null };
const TODAY = "2026-11-01";
const MB = 1024 * 1024;
/** 64×48 HEIC (HEVC) made with x265 and a minimal HEIF muxer; 885 bytes. */
const HEIC_FIXTURE = path.join(__dirname, "fixtures", "tiny.heic");

async function jpeg(opts: { w?: number; h?: number; taken?: string; offset?: string } = {}) {
  let img = sharp({ create: { width: opts.w ?? 1200, height: opts.h ?? 800, channels: 3, background: { r: 200, g: 60, b: 40 } } });
  if (opts.taken) img = img.withExif({ IFD0: { Make: "EventHub test" }, IFD2: { DateTimeOriginal: opts.taken, ...(opts.offset ? { OffsetTimeOriginal: opts.offset } : {}) } });
  return img.jpeg({ quality: 80 }).toBuffer();
}

async function setup() {
  const host = await makeUser("host@example.com", "Asha");
  const actor = actorOf(host);
  const event = await createEvent(db(), actor, { name: "Wedding", coupleNames: "Priya & Arjun", startDate: "2026-12-09" });
  const H = { eventId: event.id, actor, subject: hostS };
  const mehendi = await createFunction(db(), event.id, actor, { name: "Mehendi", date: "2026-12-09", ...blank });
  const sangeet = await createFunction(db(), event.id, actor, { name: "Sangeet", date: "2026-12-10", ...blank });
  const types = await listServiceTypes(db(), event.id);

  /** Books a vendor on a service of `typeKey` for `fn` (a Host booking is confirmed directly). */
  async function book(name: string, contact: string, typeKey: string, fnId: string) {
    const type = types.find((t) => t.systemKey === typeKey)!;
    const svc = (await addService(db(), H, { functionId: fnId, serviceTypeId: type.id, useTemplates: false, ownerUserId: host.id })).service;
    const req = (
      await addRequirement(db(), H, svc.id, { title: "Coverage", quantity: 1, unit: null, specs: null, startsAt: null, endsAt: null, venue: null, estimatePaise: 1_00_000_00, priority: "must", payer: null })
    ).requirement;
    const vendor = await createVendor(db(), event.id, actor, { name, contactName: null, phone: null, email: null, gstin: null, notes: null, serviceTypeIds: [type.id] });
    await inviteVendorContact(db(), { eventId: event.id, vendorId: vendor.id, identifier: { type: "email", value: contact }, actor, appUrl: "" });
    const user = await makeUser(contact, name);
    const [requestId] = await createQuoteRequests(db(), event.id, actor, { vendorIds: [vendor.id], serviceIds: [svc.id], dueDate: null, message: null });
    const q = await saveQuote(db(), event.id, actor, { requestId }, {
      vendorRef: null,
      receivedOn: TODAY,
      validUntil: null,
      terms: null,
      taxType: "none",
      allOrNothing: false,
      minFunctions: null,
      lines: [{ scope: "requirement", serviceId: svc.id, requirementId: req.id, description: null, quantity: null, amountPaise: 1_00_000_00, gstRateBps: 0, conditional: false, allocation: null }],
    });
    const v = await getQuote(db(), event.id, q.id);
    const b = await proposeBooking(db(), H, { quoteId: q.id, lineIds: [v.lines[0].id], today: TODAY });
    return { vendor, user, booking: b.booking };
  }

  async function family(name: string, fnIds: string[], phone = "+919876500001") {
    const [h] = await db().insert(households).values({ eventId: event.id, name, side: "bride" }).returning();
    const gs = await db()
      .insert(guests)
      .values([{ eventId: event.id, householdId: h.id, name: `${name} 1`, isHead: true, phone }])
      .returning();
    if (fnIds.length) await db().insert(functionInvites).values(fnIds.map((functionId) => ({ functionId, guestId: gs[0].id })));
    return h;
  }

  const member: Uploader = { kind: "member", userId: host.id };
  return { host, actor, event, mehendi, sangeet, book, family, member };
}

/** Begins, "uploads" (writes the bytes like the browser would) and completes one file. */
async function upload(eventId: string, who: Uploader, input: { functionId: string; albumId?: string | null; bytes: Buffer; mime?: string; filename?: string; declared?: number }) {
  const res = await beginUpload(db(), store, eventId, who, {
    functionId: input.functionId,
    albumId: input.albumId ?? null,
    clientKey: randomUUID(),
    filename: input.filename ?? "IMG_0001.jpg",
    mime: input.mime ?? "image/jpeg",
    size: input.declared ?? input.bytes.length,
  });
  if (!("grant" in res)) throw new Error("expected a grant");
  expect(res.grant.driver).toBe("fs");
  await store.put(res.grant.key, input.bytes, input.mime ?? "image/jpeg");
  return completeUpload(db(), store, eventId, who, res.mediaId);
}

const usage = async (eventId: string) => (await db().select().from(storageUsage).where(eq(storageUsage.eventId, eventId)))[0];

describe("uploads and quota (ADR-0031)", () => {
  it("members upload to the function's family album; quota is reserved, then committed at the real size", async () => {
    const s = await setup();
    const bytes = await jpeg();
    const res = (await beginUpload(db(), store, s.event.id, s.member, { functionId: s.sangeet.id, clientKey: randomUUID(), filename: "a.jpg", mime: "image/jpeg", size: bytes.length + 100 })) as Extract<BeginResult, { grant: unknown }>;
    expect((await usage(s.event.id)).reservedBytes).toBe(bytes.length + 100);
    await store.put(res.grant.key, bytes, "image/jpeg");
    const item = await completeUpload(db(), store, s.event.id, s.member, res.mediaId);
    expect(item.status).toBe("processing");
    expect(item.originalBytes).toBe(bytes.length);
    const u = await usage(s.event.id);
    expect(u.reservedBytes).toBe(0);
    expect(u.usedBytes).toBe(bytes.length);
    const [album] = await db().select().from(galleryAlbums).where(eq(galleryAlbums.id, item.albumId));
    expect(album).toMatchObject({ kind: "family", functionId: s.sangeet.id, releasedAt: null });
  });

  it("resumes with the same client key instead of creating a second item", async () => {
    const s = await setup();
    const clientKey = randomUUID();
    const input = { functionId: s.sangeet.id, clientKey, filename: "a.jpg", mime: "image/jpeg", size: 1000 };
    const a = await beginUpload(db(), store, s.event.id, s.member, input);
    const b = await beginUpload(db(), store, s.event.id, s.member, input);
    expect(b.mediaId).toBe(a.mediaId);
    expect((await usage(s.event.id)).reservedBytes).toBe(1000);
    // Someone else can't hijack the key.
    const other = await makeUser("p@example.com");
    await expect(beginUpload(db(), store, s.event.id, { kind: "member", userId: other.id }, input)).rejects.toMatchObject({ code: "invalid" });
  });

  it("refuses wrong types, oversized files, and objects bigger than declared (forged uploads)", async () => {
    const s = await setup();
    const base = { functionId: s.sangeet.id, filename: "x", size: 10 };
    await expect(beginUpload(db(), store, s.event.id, s.member, { ...base, clientKey: randomUUID(), mime: "application/pdf" })).rejects.toMatchObject({ code: "bad_type" });
    await expect(beginUpload(db(), store, s.event.id, s.member, { ...base, clientKey: randomUUID(), mime: "image/svg+xml" })).rejects.toMatchObject({ code: "bad_type" });
    await expect(beginUpload(db(), store, s.event.id, s.member, { ...base, clientKey: randomUUID(), mime: "image/jpeg", size: 50 * MB + 1 })).rejects.toMatchObject({ code: "too_large" });
    // Another event's function.
    const other = await createEvent(db(), s.actor, { name: "Other" });
    const otherFn = await createFunction(db(), other.id, s.actor, { name: "X", date: null, ...blank });
    await expect(beginUpload(db(), store, s.event.id, s.member, { ...base, functionId: otherFn.id, clientKey: randomUUID(), mime: "image/jpeg" })).rejects.toMatchObject({ code: "not_found" });

    const bytes = await jpeg();
    await expect(upload(s.event.id, s.member, { functionId: s.sangeet.id, bytes, declared: 100 })).rejects.toMatchObject({ code: "too_large" });
    const u = await usage(s.event.id);
    expect(u.reservedBytes).toBe(0);
    expect(u.usedBytes).toBe(0);
    expect(await db().select().from(mediaItems)).toHaveLength(0);
  });

  it("complete before the bytes arrive says so; abort releases the reservation", async () => {
    const s = await setup();
    const r = await beginUpload(db(), store, s.event.id, s.member, { functionId: s.sangeet.id, clientKey: randomUUID(), filename: "a.jpg", mime: "image/jpeg", size: 5000 });
    await expect(completeUpload(db(), store, s.event.id, s.member, r.mediaId)).rejects.toMatchObject({ code: "not_uploaded" });
    await abortUpload(db(), store, s.event.id, s.member, r.mediaId);
    expect((await usage(s.event.id)).reservedBytes).toBe(0);
    expect(await db().select().from(mediaItems)).toHaveLength(0);
  });

  it("the daily sweep finishes uploads whose object arrived and releases abandoned ones", async () => {
    const s = await setup();
    const t0 = new Date("2026-12-11T10:00:00Z");
    const bytes = await jpeg();
    const arrived = (await beginUpload(db(), store, s.event.id, s.member, { functionId: s.sangeet.id, clientKey: randomUUID(), filename: "a.jpg", mime: "image/jpeg", size: bytes.length }, t0)) as Extract<BeginResult, { grant: unknown }>;
    await store.put(arrived.grant.key, bytes, "image/jpeg");
    await beginUpload(db(), store, s.event.id, s.member, { functionId: s.sangeet.id, clientKey: randomUUID(), filename: "b.jpg", mime: "image/jpeg", size: 7777 }, t0);
    // Not yet expired: nothing happens.
    await db().update(mediaItems).set({ uploadExpiresAt: new Date(t0.getTime() + 30 * 60_000) });
    expect(await sweepUploads(db(), store, new Date(t0.getTime() + 20 * 60_000))).toBe(0);
    expect(await sweepUploads(db(), store, new Date(t0.getTime() + 3 * 3600_000))).toBe(2);
    const rows = await db().select().from(mediaItems);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("processing");
    const u = await usage(s.event.id);
    expect(u.reservedBytes).toBe(0);
    expect(u.usedBytes).toBe(bytes.length);
  });

  it("an upload finished after its reservation expired is still counted once", async () => {
    const s = await setup();
    const t0 = new Date("2026-12-11T10:00:00Z");
    const bytes = await jpeg();
    const r = (await beginUpload(db(), store, s.event.id, s.member, { functionId: s.sangeet.id, clientKey: randomUUID(), filename: "a.jpg", mime: "image/jpeg", size: bytes.length }, t0)) as Extract<BeginResult, { grant: unknown }>;
    const [row] = await db().select().from(mediaItems).where(eq(mediaItems.id, r.mediaId));
    expect(row.reservationId).not.toBeNull();
    await store.put(r.grant.key, bytes, "image/jpeg");
    // The daily job gives the reservation back (photo grant 30 min + 1 h)...
    expect(await releaseExpiredReservations(db(), new Date(t0.getTime() + 2 * 3600_000))).toBe(1);
    expect((await usage(s.event.id)).reservedBytes).toBe(0);
    // ...and the sweep then finds the object and counts it as usage.
    await sweepUploads(db(), store, new Date(t0.getTime() + 3 * 3600_000));
    const u = await usage(s.event.id);
    expect(u.reservedBytes).toBe(0);
    expect(u.usedBytes).toBe(bytes.length);
  });

  it("stops members at 100% of the limit and lets vendors use the 10% reserve (LIM-03)", async () => {
    const s = await setup();
    const { vendor, user } = await s.book("Lens", "lens@example.com", "photography", s.sangeet.id);
    const album = await createVendorAlbum(db(), { eventId: s.event.id, vendorId: vendor.id, userId: user.id, functionId: s.sangeet.id, title: "Full delivery" });
    await db().insert(eventStorageOverrides).values({ eventId: s.event.id, storageBytes: 10 * MB });
    await db().insert(storageUsage).values({ eventId: s.event.id, usedBytes: 9.5 * MB });
    const begin = (who: Uploader, size: number, albumId?: string) =>
      beginUpload(db(), store, s.event.id, who, { functionId: s.sangeet.id, albumId, clientKey: randomUUID(), filename: "a.jpg", mime: "image/jpeg", size });
    await expect(begin(s.member, 1 * MB)).rejects.toMatchObject({ code: "storage_full" });
    const v: Uploader = { kind: "vendor", vendorId: vendor.id, userId: user.id };
    await expect(begin(v, 1 * MB, album.id)).resolves.toHaveProperty("grant");
    await expect(begin(v, 1 * MB, album.id)).rejects.toMatchObject({ code: "storage_full" });
  });

  it("guests: only when enabled, only invited functions, JPEG photos, 300 items per family", async () => {
    const s = await setup();
    const sharma = await s.family("Sharma", [s.sangeet.id]);
    const g: Uploader = { kind: "guest", householdId: sharma.id };
    const begin = (fnId: string, extra: Partial<{ mime: string; size: number }> = {}) =>
      beginUpload(db(), store, s.event.id, g, { functionId: fnId, clientKey: randomUUID(), filename: "a.jpg", mime: "image/jpeg", size: 1000, ...extra });
    await expect(begin(s.sangeet.id)).rejects.toMatchObject({ code: "uploads_off" });
    await updateGallerySettings(db(), s.event.id, s.actor, { guestUploads: true, autoApprove: false, guestOriginals: false, reactions: true, watermarkText: null });
    await expect(begin(s.mehendi.id)).rejects.toMatchObject({ code: "not_invited" });
    await expect(begin(s.sangeet.id, { mime: "image/heic" })).rejects.toMatchObject({ code: "bad_type" });
    await expect(begin(s.sangeet.id, { mime: "video/mp4", size: 500 * MB + 1 })).rejects.toMatchObject({ code: "too_large" });
    const ok = await begin(s.sangeet.id);
    expect(ok).toHaveProperty("grant");
    const [row] = await db().select().from(mediaItems).where(eq(mediaItems.id, ok.mediaId));
    expect(row.originalKey.startsWith(`events/${s.event.id}/households/${sharma.id}/gallery/`)).toBe(true);
    const [album] = await db().select().from(galleryAlbums).where(eq(galleryAlbums.id, row.albumId));
    expect(album.kind).toBe("guest");
    // Household cap (§4.1: 300 items).
    await db().update(storageHouseholdUsage).set({ items: 300 }).where(eq(storageHouseholdUsage.householdId, sharma.id));
    await expect(begin(s.sangeet.id)).rejects.toMatchObject({ code: "household_items" });
    await db().update(storageHouseholdUsage).set({ items: 1, bytes: 5 * 1024 * MB - 10 }).where(eq(storageHouseholdUsage.householdId, sharma.id));
    await expect(begin(s.sangeet.id)).rejects.toMatchObject({ code: "household_bytes" });
  });

  it("vendors upload only into their own delivery albums for functions they're booked to photograph", async () => {
    const s = await setup();
    const lens = await s.book("Lens", "lens@example.com", "photography", s.sangeet.id);
    const chef = await s.book("Chef", "chef@example.com", "catering", s.sangeet.id);
    expect((await photoBookings(db(), s.event.id)).map((b) => b.vendorId)).toEqual([lens.vendor.id]);
    await expect(createVendorAlbum(db(), { eventId: s.event.id, vendorId: chef.vendor.id, userId: chef.user.id, functionId: s.sangeet.id, title: "Food" })).rejects.toMatchObject({ code: "not_booked" });
    await expect(createVendorAlbum(db(), { eventId: s.event.id, vendorId: lens.vendor.id, userId: lens.user.id, functionId: s.mehendi.id, title: "X" })).rejects.toMatchObject({ code: "not_booked" });
    const album = await createVendorAlbum(db(), { eventId: s.event.id, vendorId: lens.vendor.id, userId: lens.user.id, functionId: s.sangeet.id, title: "Sneak peek" });
    expect(album.bookingId).toBe(lens.booking.id);
    const chefUp: Uploader = { kind: "vendor", vendorId: chef.vendor.id, userId: chef.user.id };
    await expect(beginUpload(db(), store, s.event.id, chefUp, { functionId: s.sangeet.id, albumId: album.id, clientKey: randomUUID(), filename: "a", mime: "image/jpeg", size: 10 })).rejects.toMatchObject({ code: "not_found" });
    const lensUp: Uploader = { kind: "vendor", vendorId: lens.vendor.id, userId: lens.user.id };
    await expect(beginUpload(db(), store, s.event.id, lensUp, { functionId: s.sangeet.id, albumId: album.id, clientKey: randomUUID(), filename: "v.mp4", mime: "video/mp4", size: 3 * 1024 * MB })).resolves.toHaveProperty("grant");
  });
});

describe("renditions (ADR-0032)", () => {
  it("reads the EXIF capture time, with or without an offset", async () => {
    const meta = await sharp(await jpeg({ taken: "2026:12:10 19:30:15" })).metadata();
    const exif = readExifDate(meta.exif);
    expect(exif).toEqual({ date: "2026-12-10", time: "19:30:15", offset: null });
    expect(captureInstant(exif, "Asia/Kolkata")?.toISOString()).toBe("2026-12-10T14:00:15.000Z");
    const withOffset = readExifDate((await sharp(await jpeg({ taken: "2026:12:10 19:30:15", offset: "+04:00" })).metadata()).exif);
    expect(captureInstant(withOffset, "Asia/Kolkata")?.toISOString()).toBe("2026-12-10T15:30:15.000Z");
    expect(readExifDate(Buffer.from("garbage garbage"))).toBeNull();
  });

  it("makes a 480px thumb and a 2048px web copy, sets the capture time, and approves member uploads", async () => {
    const s = await setup();
    const item = await upload(s.event.id, s.member, { functionId: s.sangeet.id, bytes: await jpeg({ w: 3000, h: 2000, taken: "2026:12:10 21:05:00" }) });
    const res = await processRenditions(db(), store, { ids: [item.id] });
    expect(res.processed).toBe(1);
    const [row] = await db().select().from(mediaItems).where(eq(mediaItems.id, item.id));
    expect(row.status).toBe("approved");
    expect(row.width).toBe(3000);
    expect(row.takenAt.toISOString()).toBe("2026-12-10T15:35:00.000Z");
    const thumb = await sharp((await store.getBytes(row.thumbKey!))!).metadata();
    const web = await sharp((await store.getBytes(row.webKey!))!).metadata();
    expect([thumb.format, thumb.width]).toEqual(["webp", 480]);
    expect([web.format, web.width]).toEqual(["webp", 2048]);
  });

  it("guest uploads wait for moderation unless auto-approve is on; undecodable photos keep their original but are never auto-approved", async () => {
    const s = await setup();
    const sharma = await s.family("Sharma", [s.sangeet.id]);
    const g: Uploader = { kind: "guest", householdId: sharma.id };
    await updateGallerySettings(db(), s.event.id, s.actor, { guestUploads: true, autoApprove: false, guestOriginals: false, reactions: true, watermarkText: null });
    const a = await upload(s.event.id, g, { functionId: s.sangeet.id, bytes: await jpeg() });
    // A real HEIC header with a broken body: accepted as HEIC, but no preview.
    const tiny = await readFile(HEIC_FIXTURE);
    const broken = await upload(s.event.id, s.member, { functionId: s.sangeet.id, bytes: Buffer.concat([tiny.subarray(0, 40), Buffer.alloc(200)]), mime: "image/heic", filename: "IMG.HEIC" });
    await processRenditions(db(), store);
    const rows = await db().select().from(mediaItems);
    expect(rows.find((r) => r.id === a.id)?.status).toBe("pending");
    const b = rows.find((r) => r.id === broken.id)!;
    expect(b).toMatchObject({ status: "approved", previewError: "decode", thumbKey: null });
    expect(variantFor({ kind: "member" }, b, "original", { guestOriginals: false })?.key).toBe(b.originalKey);

    await updateGallerySettings(db(), s.event.id, s.actor, { guestUploads: true, autoApprove: true, guestOriginals: false, reactions: true, watermarkText: null });
    const c = await upload(s.event.id, g, { functionId: s.sangeet.id, bytes: await jpeg() });
    // JPEG magic bytes but garbage after: never auto-approved.
    const d = await upload(s.event.id, g, { functionId: s.sangeet.id, bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 7)]) });
    await processRenditions(db(), store);
    expect((await db().select().from(mediaItems).where(eq(mediaItems.id, c.id)))[0].status).toBe("approved");
    expect((await db().select().from(mediaItems).where(eq(mediaItems.id, d.id)))[0]).toMatchObject({ status: "pending", previewError: "decode" });
  });

  it("decodes HEIC (iPhone) photos into renditions and a clean JPEG copy for guests", async () => {
    const s = await setup();
    const item = await upload(s.event.id, s.member, { functionId: s.sangeet.id, bytes: await readFile(HEIC_FIXTURE), mime: "image/heif", filename: "IMG_1.HEIC" });
    expect(item.mime).toBe("image/heic"); // the verified type
    await processRenditions(db(), store);
    const [row] = await db().select().from(mediaItems).where(eq(mediaItems.id, item.id));
    expect(row).toMatchObject({ status: "approved", previewError: null, width: 64, height: 48 });
    const web = await sharp((await store.getBytes(row.webKey!))!).metadata();
    expect([web.format, web.width]).toEqual(["webp", 64]);
    const share = await sharp((await store.getBytes(row.shareKey!))!).metadata();
    expect([share.format, share.width, share.height]).toEqual(["jpeg", 64, 48]);
  });

  it("two workers never process the same item (SKIP LOCKED)", async () => {
    const s = await setup();
    for (let i = 0; i < 4; i++) await upload(s.event.id, s.member, { functionId: s.sangeet.id, bytes: await jpeg({ w: 400, h: 300 }) });
    const [a, b] = await Promise.all([processRenditions(db(), store), processRenditions(db(), store)]);
    expect(a.processed + b.processed).toBe(4);
    const rows = await db().select().from(mediaItems);
    expect(rows.every((r) => r.status === "approved" && r.processingAttempts === 1)).toBe(true);
  });

  it("watermarks the guest download copy", async () => {
    const out = await watermark(await jpeg({ w: 800, h: 600 }), "Priya & Arjun");
    const meta = await sharp(out).metadata();
    expect([meta.format, meta.width]).toEqual(["jpeg", 800]);
  });
});

describe("who sees what (GAL-05)", () => {
  const base = { status: "approved" as const, uploaderKind: "vendor" as const, vendorId: "v1", householdId: null, functionId: "f1", albumReleased: true };
  const guest: Viewer = { kind: "guest", householdId: "h1", functionIds: ["f1"] };

  it("canViewMedia matrix", () => {
    expect(canViewMedia({ kind: "member" }, { ...base, status: "hidden", albumReleased: false })).toBe(true);
    expect(canViewMedia({ kind: "member" }, { ...base, status: "uploading" })).toBe(false);
    expect(canViewMedia({ kind: "vendor", vendorId: "v1" }, base)).toBe(true);
    expect(canViewMedia({ kind: "vendor", vendorId: "v2" }, base)).toBe(false);
    expect(canViewMedia({ kind: "vendor", vendorId: "v2" }, { ...base, uploaderKind: "member", vendorId: null, sharedWithVendorIds: ["v2"] })).toBe(true);
    expect(canViewMedia(guest, base)).toBe(true);
    expect(canViewMedia(guest, { ...base, albumReleased: false })).toBe(false);
    expect(canViewMedia(guest, { ...base, status: "pending" })).toBe(false);
    expect(canViewMedia(guest, { ...base, status: "hidden" })).toBe(false);
    expect(canViewMedia(guest, { ...base, functionId: "f2" })).toBe(false);
    expect(canViewMedia(guest, { ...base, uploaderKind: "household", vendorId: null, householdId: "h1", status: "pending", albumReleased: true, functionId: "f1" })).toBe(true);
    expect(canViewMedia(guest, { ...base, uploaderKind: "household", vendorId: null, householdId: "h2", status: "pending" })).toBe(false);
  });

  it("guests see released, approved items of invited functions only — private functions stay private", async () => {
    const s = await setup();
    const sharma = await s.family("Sharma", [s.sangeet.id], "+919876500001");
    const verma = await s.family("Verma", [s.mehendi.id], "+919876500002");
    const sangeetAlbum = await createAlbum(db(), { eventId: s.event.id, actor: s.actor, functionId: s.sangeet.id, title: "Dance" });
    const mehendiAlbum = await createAlbum(db(), { eventId: s.event.id, actor: s.actor, functionId: s.mehendi.id, title: "Henna" });
    const a = await upload(s.event.id, s.member, { functionId: s.sangeet.id, albumId: sangeetAlbum.id, bytes: await jpeg() });
    const b = await upload(s.event.id, s.member, { functionId: s.mehendi.id, albumId: mehendiAlbum.id, bytes: await jpeg() });
    await processRenditions(db(), store);
    const vSharma: Viewer = { kind: "guest", householdId: sharma.id, functionIds: [s.sangeet.id] };
    const vVerma: Viewer = { kind: "guest", householdId: verma.id, functionIds: [s.mehendi.id] };
    // Unreleased: nobody outside the team.
    expect(await loadMediaForViewer(db(), s.event.id, a.id, vSharma)).toBeNull();
    expect((await listGuestMedia(db(), s.event.id, vSharma, s.sangeet.id, null)).items).toHaveLength(0);
    await releaseAlbum(db(), { eventId: s.event.id, actor: s.actor, albumId: sangeetAlbum.id, release: true, appUrl: "http://x" });
    await releaseAlbum(db(), { eventId: s.event.id, actor: s.actor, albumId: mehendiAlbum.id, release: true, appUrl: "http://x" });
    expect(await loadMediaForViewer(db(), s.event.id, a.id, vSharma)).not.toBeNull();
    expect(await loadMediaForViewer(db(), s.event.id, b.id, vSharma)).toBeNull();
    expect(await loadMediaForViewer(db(), s.event.id, a.id, vVerma)).toBeNull();
    expect((await listGuestMedia(db(), s.event.id, vSharma, s.mehendi.id, null)).items).toHaveLength(0);
    // Hidden items vanish for guests.
    await moderate(db(), { eventId: s.event.id, actor: s.actor, mediaIds: [a.id], action: "hide" });
    expect(await loadMediaForViewer(db(), s.event.id, a.id, vSharma)).toBeNull();
    // Another event's viewer can't load it via this event either.
    const other = await createEvent(db(), s.actor, { name: "Other" });
    expect(await loadMediaForViewer(db(), other.id, b.id, { kind: "member" })).toBeNull();
  });

  it("a family sees its own pending uploads but not other families' ones", async () => {
    const s = await setup();
    const sharma = await s.family("Sharma", [s.sangeet.id], "+919876500001");
    const verma = await s.family("Verma", [s.sangeet.id], "+919876500002");
    await updateGallerySettings(db(), s.event.id, s.actor, { guestUploads: true, autoApprove: false, guestOriginals: false, reactions: true, watermarkText: null });
    const mine = await upload(s.event.id, { kind: "guest", householdId: sharma.id }, { functionId: s.sangeet.id, bytes: await jpeg() });
    await processRenditions(db(), store);
    const vSharma: Viewer = { kind: "guest", householdId: sharma.id, functionIds: [s.sangeet.id] };
    const vVerma: Viewer = { kind: "guest", householdId: verma.id, functionIds: [s.sangeet.id] };
    expect((await listGuestMedia(db(), s.event.id, vSharma, s.sangeet.id, null)).items.map((i) => i.id)).toEqual([mine.id]);
    expect((await listGuestMedia(db(), s.event.id, vVerma, s.sangeet.id, null)).items).toHaveLength(0);
    // After approval, others see it (guest albums are released from the start).
    expect((await moderationQueue(db(), s.event.id, null)).items.map((i) => i.id)).toEqual([mine.id]);
    await moderate(db(), { eventId: s.event.id, actor: s.actor, mediaIds: [mine.id], action: "approve" });
    expect((await listGuestMedia(db(), s.event.id, vVerma, s.sangeet.id, null)).items).toHaveLength(1);
    expect((await moderationQueue(db(), s.event.id, null)).items).toHaveLength(0);
  });

  it("variants: guests get web resolution, clean originals only when allowed, watermarked copies when set (S2, S4)", () => {
    const item = { kind: "photo" as const, mime: "image/jpeg", householdId: null, thumbKey: "t", webKey: "w", originalKey: "o", shareKey: null };
    const g: Viewer = { kind: "guest", householdId: "h1", functionIds: [] };
    const off = { guestOriginals: false, watermarkText: null };
    const on = { guestOriginals: true, watermarkText: null };
    expect(variantFor(g, item, "original", off)).toBeNull();
    expect(variantFor(g, item, "web", off)).toMatchObject({ key: "w", watermark: false });
    expect(variantFor(g, item, "download", off)).toMatchObject({ key: "w", watermark: false, mime: "image/webp" });
    // Someone else's JPEG original: metadata stripped.
    expect(variantFor(g, item, "download", on)).toMatchObject({ key: "o", strip: true, mime: "image/jpeg" });
    // A HEIC original: the clean JPEG copy, or nothing original without one.
    const heic = { ...item, mime: "image/heic", shareKey: "s" };
    expect(variantFor(g, heic, "original", on)).toMatchObject({ key: "s", strip: false, mime: "image/jpeg" });
    expect(variantFor(g, { ...heic, shareKey: null }, "original", on)).toBeNull();
    // A watermark wins over originals: web and download are the watermarked copy.
    const wm = { guestOriginals: true, watermarkText: "P & A" };
    expect(variantFor(g, item, "web", wm)).toMatchObject({ key: "w", watermark: true, mime: "image/jpeg" });
    expect(variantFor(g, item, "download", wm)).toMatchObject({ watermark: true });
    expect(variantFor(g, item, "original", wm)).toBeNull();
    // Own uploads and the team: true originals.
    expect(variantFor(g, { ...item, householdId: "h1" }, "original", wm)).toMatchObject({ key: "o", strip: false, watermark: false });
    expect(variantFor({ kind: "member" }, item, "original", wm)).toMatchObject({ key: "o", strip: false });
    expect(variantFor({ kind: "member" }, item, "download", wm)).toMatchObject({ key: "o", watermark: false });
    expect(variantFor(g, { ...item, kind: "video", mime: "video/mp4", thumbKey: null, webKey: null }, "web", off)?.key).toBe("o");
  });

  it("pages with a keyset cursor in capture order", async () => {
    const s = await setup();
    const album = await createAlbum(db(), { eventId: s.event.id, actor: s.actor, functionId: s.sangeet.id, title: "All" });
    for (const tm of ["20:00:00", "19:00:00", "21:00:00"]) await upload(s.event.id, s.member, { functionId: s.sangeet.id, albumId: album.id, bytes: await jpeg({ w: 300, h: 200, taken: `2026:12:10 ${tm}` }) });
    await processRenditions(db(), store);
    const p1 = await listAlbumMedia(db(), s.event.id, album.id, null, { limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.next).not.toBeNull();
    const p2 = await listAlbumMedia(db(), s.event.id, album.id, decodeCursor(p1.next), { limit: 2 });
    expect(p2.items).toHaveLength(1);
    expect(p2.next).toBeNull();
    const times = [...p1.items, ...p2.items].map((i) => i.takenAt.toISOString());
    expect(times).toEqual([...times].sort());
    expect(decodeCursor(encodeCursor(p2.items[0]))?.id).toBe(p2.items[0].id);
    expect(decodeCursor("1;drop table")).toBeNull();
  });
});

describe("release and 'photos are ready' (GAL-02, GAL-11)", () => {
  it("messages invited families once per function, and not for empty albums", async () => {
    const s = await setup();
    const sharma = await s.family("Sharma", [s.sangeet.id], "+919876500001");
    await s.family("Verma", [s.mehendi.id], "+919876500002");
    const { vendor, user } = await s.book("Lens", "lens@example.com", "photography", s.sangeet.id);
    const peek = await createVendorAlbum(db(), { eventId: s.event.id, vendorId: vendor.id, userId: user.id, functionId: s.sangeet.id, title: "Sneak peek" });
    const full = await createVendorAlbum(db(), { eventId: s.event.id, vendorId: vendor.id, userId: user.id, functionId: s.sangeet.id, title: "Full" });
    const v: Uploader = { kind: "vendor", vendorId: vendor.id, userId: user.id };

    const empty = await releaseAlbum(db(), { eventId: s.event.id, actor: s.actor, albumId: peek.id, release: true, appUrl: "http://x" });
    expect(empty.notified).toBe(0);
    await releaseAlbum(db(), { eventId: s.event.id, actor: s.actor, albumId: peek.id, release: false, appUrl: "http://x" });

    await upload(s.event.id, v, { functionId: s.sangeet.id, albumId: peek.id, bytes: await jpeg() });
    await upload(s.event.id, v, { functionId: s.sangeet.id, albumId: full.id, bytes: await jpeg() });
    await processRenditions(db(), store);
    const r1 = await releaseAlbum(db(), { eventId: s.event.id, actor: s.actor, albumId: peek.id, release: true, appUrl: "http://x" });
    expect(r1.notified).toBe(1);
    const r2 = await releaseAlbum(db(), { eventId: s.event.id, actor: s.actor, albumId: full.id, release: true, appUrl: "http://x" });
    expect(r2.notified).toBe(0);
    const msgs = await db().select().from(outboundMessages).where(eq(outboundMessages.templateKey, "gallery_ready"));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ householdId: sharma.id, bulk: true, purpose: "broadcast" });
  });
});

describe("favourites, selections, highlights (GAL-05, GAL-07)", () => {
  it("builds a selection from favourites and shares it with the photographer, who can then see those items", async () => {
    const s = await setup();
    const { vendor, user } = await s.book("Lens", "lens@example.com", "photography", s.sangeet.id);
    const a = await upload(s.event.id, s.member, { functionId: s.sangeet.id, bytes: await jpeg() });
    const b = await upload(s.event.id, s.member, { functionId: s.sangeet.id, bytes: await jpeg() });
    await processRenditions(db(), store);
    expect(await toggleFavourite(db(), { eventId: s.event.id, userId: s.host.id, mediaId: a.id })).toBe(true);
    expect(await toggleFavourite(db(), { eventId: s.event.id, userId: s.host.id, mediaId: b.id })).toBe(true);
    expect(await toggleFavourite(db(), { eventId: s.event.id, userId: s.host.id, mediaId: b.id })).toBe(false);

    const vendorViewer: Viewer = { kind: "vendor", vendorId: vendor.id };
    expect(await loadMediaForViewer(db(), s.event.id, a.id, vendorViewer)).toBeNull();
    const sel = await createSelection(db(), s.event.id, s.actor, { bookingId: (await photoBookings(db(), s.event.id))[0].bookingId, title: "Album 1", deadline: "2027-01-15", note: null });
    expect(await addToSelection(db(), { eventId: s.event.id, selectionId: sel.id, favourites: true })).toBe(1);
    // Not visible to the vendor until shared.
    await expect(getSelection(db(), s.event.id, sel.id, { vendorId: vendor.id })).rejects.toMatchObject({ code: "not_found" });
    expect(await loadMediaForViewer(db(), s.event.id, a.id, vendorViewer)).toBeNull();
    await shareSelection(db(), { eventId: s.event.id, actor: s.actor, selectionId: sel.id });
    expect((await getSelection(db(), s.event.id, sel.id, { vendorId: vendor.id })).deadline).toBe("2027-01-15");
    expect(await loadMediaForViewer(db(), s.event.id, a.id, vendorViewer)).not.toBeNull();
    expect(await loadMediaForViewer(db(), s.event.id, b.id, vendorViewer)).toBeNull();
    const notes = await db().select().from(notifications).where(eq(notifications.userId, user.id));
    expect(notes.map((n) => n.kind)).toContain("vendor.gallery_selection");
  });

  it("selections only for photography/videography bookings", async () => {
    const s = await setup();
    const chef = await s.book("Chef", "chef@example.com", "catering", s.sangeet.id);
    await expect(createSelection(db(), s.event.id, s.actor, { bookingId: chef.booking.id, title: "X", deadline: null, note: null })).rejects.toMatchObject({ code: "not_booked" });
  });

  it("highlights only approved photos from released albums of public functions, and they go when that stops (S5)", async () => {
    const s = await setup();
    const { auditLogs } = await import("@/db/schema");
    const album = await createAlbum(db(), { eventId: s.event.id, actor: s.actor, functionId: s.sangeet.id, title: "Dance" });
    const a = await upload(s.event.id, s.member, { functionId: s.sangeet.id, albumId: album.id, bytes: await jpeg() });
    const on = () => setHighlight(db(), { eventId: s.event.id, actor: s.actor, mediaId: a.id, on: true });
    await expect(on()).rejects.toMatchObject({ code: "not_public" }); // still processing
    await processRenditions(db(), store);
    await expect(on()).rejects.toMatchObject({ code: "not_public" }); // album not released
    await releaseAlbum(db(), { eventId: s.event.id, actor: s.actor, albumId: album.id, release: true, appUrl: "" });
    await expect(on()).rejects.toMatchObject({ code: "not_public" }); // function private
    await updateFunction(db(), s.event.id, s.sangeet.id, s.actor, { name: "Sangeet", date: "2026-12-10", ...blank, isPublic: true });
    await on();
    expect((await listHighlights(db(), s.event.id)).map((h) => h.id)).toEqual([a.id]);
    expect(await highlightWebKey(db(), s.event.id, a.id)).toBeTruthy();
    const audits = await db().select().from(auditLogs).where(eq(auditLogs.eventId, s.event.id));
    expect(audits.map((x) => x.action)).toContain("gallery.highlight_added");

    // Withdrawing the album clears it.
    await releaseAlbum(db(), { eventId: s.event.id, actor: s.actor, albumId: album.id, release: false, appUrl: "" });
    expect((await db().select().from(mediaItems).where(eq(mediaItems.id, a.id)))[0].highlight).toBe(false);
    expect(await highlightWebKey(db(), s.event.id, a.id)).toBeNull();
    // Making the function private clears it too.
    await releaseAlbum(db(), { eventId: s.event.id, actor: s.actor, albumId: album.id, release: true, appUrl: "" });
    await on();
    await updateFunction(db(), s.event.id, s.sangeet.id, s.actor, { name: "Sangeet", date: "2026-12-10", ...blank, isPublic: false });
    expect(await listHighlights(db(), s.event.id)).toHaveLength(0);
    expect((await db().select().from(mediaItems).where(eq(mediaItems.id, a.id)))[0].highlight).toBe(false);
    // Hiding clears it.
    await updateFunction(db(), s.event.id, s.sangeet.id, s.actor, { name: "Sangeet", date: "2026-12-10", ...blank, isPublic: true });
    await on();
    await moderate(db(), { eventId: s.event.id, actor: s.actor, mediaIds: [a.id], action: "hide" });
    expect(await listHighlights(db(), s.event.id)).toHaveLength(0);
  });
});

describe("likes, comments, removal requests (GAL-04, GAL-08)", () => {
  async function released() {
    const s = await setup();
    const sharma = await s.family("Sharma", [s.sangeet.id], "+919876500001");
    const album = await createAlbum(db(), { eventId: s.event.id, actor: s.actor, functionId: s.sangeet.id, title: "Dance" });
    const item = await upload(s.event.id, s.member, { functionId: s.sangeet.id, albumId: album.id, bytes: await jpeg() });
    await processRenditions(db(), store);
    await releaseAlbum(db(), { eventId: s.event.id, actor: s.actor, albumId: album.id, release: true, appUrl: "http://x" });
    const viewer: Viewer & { kind: "guest" } = { kind: "guest", householdId: sharma.id, functionIds: [s.sangeet.id] };
    return { ...s, sharma, album, item, viewer };
  }

  it("likes and comments follow the reactions switch; guests don't see other families' names", async () => {
    const s = await released();
    expect(await toggleLike(db(), s.event.id, s.viewer, s.item.id)).toBe(true);
    const c = await addComment(db(), s.event.id, s.viewer, s.item.id, "Beautiful!");
    const verma = await s.family("Verma", [s.sangeet.id], "+919876500002");
    const asVerma = await reactionsFor(db(), s.item.id, { householdId: verma.id });
    expect(asVerma).toMatchObject({ likes: 1, liked: false });
    expect(asVerma.comments[0]).toMatchObject({ body: "Beautiful!", mine: false, family: null });
    expect((await reactionsFor(db(), s.item.id, { member: true })).comments[0].family).toBe("Sharma");
    await hideComment(db(), { eventId: s.event.id, actor: s.actor, commentId: c.id, hidden: true });
    expect((await reactionsFor(db(), s.item.id, { householdId: verma.id })).comments).toHaveLength(0);
    await updateGallerySettings(db(), s.event.id, s.actor, { guestUploads: false, autoApprove: false, guestOriginals: false, reactions: false, watermarkText: null });
    await expect(toggleLike(db(), s.event.id, s.viewer, s.item.id)).rejects.toMatchObject({ code: "reactions_off" });
    // Not invited → not found, whether or not the item exists.
    const outsider: Viewer & { kind: "guest" } = { kind: "guest", householdId: verma.id, functionIds: [] };
    await updateGallerySettings(db(), s.event.id, s.actor, { guestUploads: false, autoApprove: false, guestOriginals: false, reactions: true, watermarkText: null });
    await expect(addComment(db(), s.event.id, outsider, s.item.id, "hi")).rejects.toMatchObject({ code: "not_found" });
    await expect(addComment(db(), s.event.id, outsider, randomUUID(), "hi")).rejects.toMatchObject({ code: "not_found" });
  });

  it("removal: the family is notified; removing deletes the photo and frees its space", async () => {
    const s = await released();
    await requestRemoval(db(), s.event.id, s.viewer, s.item.id, "I'm in this one");
    await expect(requestRemoval(db(), s.event.id, s.viewer, s.item.id, "")).rejects.toMatchObject({ code: "already_requested" });
    const notes = await db().select().from(notifications).where(eq(notifications.userId, s.host.id));
    expect(notes.map((n) => n.kind)).toContain("gallery.removal_requested");
    const [req] = await db().select().from(mediaRemovalRequests);
    const used = (await usage(s.event.id)).usedBytes;
    await decideRemoval(db(), { eventId: s.event.id, actor: s.actor, requestId: req.id, decision: "remove" });
    expect(await db().select().from(mediaItems)).toHaveLength(0);
    expect((await usage(s.event.id)).usedBytes).toBe(used - s.item.originalBytes);
    const [after] = await db().select().from(mediaRemovalRequests);
    expect(after).toMatchObject({ status: "removed", mediaId: null });
    const queued = await db().select().from(storageDeletions);
    expect(queued.map((q) => q.prefix)).toContain(`events/${s.event.id}/gallery/${s.item.id}/`);
    await processStorageDeletions(db(), store);
    expect(await store.head(s.item.originalKey)).toBeNull();
  });
});

describe("downloads, archive and erasure (GAL-06, EVT-08/09)", () => {
  it("splits ZIP parts by size and lists them in the archive", async () => {
    expect(splitParts([{ originalBytes: 5 }, { originalBytes: 5 }, { originalBytes: 20 }, { originalBytes: 1 }], 10).map((p) => p.length)).toEqual([2, 1, 1]);
    const s = await setup();
    const a = await upload(s.event.id, s.member, { functionId: s.sangeet.id, bytes: await jpeg(), filename: "one.jpg" });
    const { createTranslator } = await import("@/i18n/core");
    const t = createTranslator("en");
    const parts = await listArchiveParts(db(), s.event.id, t);
    expect(parts.map((p) => p.id)).toEqual(["main", "gallery-1"]);
    const entries = await partEntries({ db: db(), event: s.event, t, locale: "en", subject: hostS, actor: s.actor, now: new Date() }, "gallery-1");
    const paths: string[] = [];
    for await (const e of entries!) paths.push(e.path);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("Sangeet/");
    expect(paths[0]).toContain(`${a.id.slice(0, 8)}-one.jpg`);
  });

  it("guests' ZIP only includes what they may see", async () => {
    const s = await setup();
    const sharma = await s.family("Sharma", [s.sangeet.id]);
    const album = await createAlbum(db(), { eventId: s.event.id, actor: s.actor, functionId: s.sangeet.id, title: "Dance" });
    await upload(s.event.id, s.member, { functionId: s.sangeet.id, albumId: album.id, bytes: await jpeg() });
    await upload(s.event.id, s.member, { functionId: s.mehendi.id, bytes: await jpeg() });
    await processRenditions(db(), store);
    const viewer: Viewer & { kind: "guest" } = { kind: "guest", householdId: sharma.id, functionIds: [s.sangeet.id] };
    expect(await zipItems(db(), s.event.id, { guest: viewer })).toHaveLength(0);
    await releaseAlbum(db(), { eventId: s.event.id, actor: s.actor, albumId: album.id, release: true, appUrl: "" });
    expect(await zipItems(db(), s.event.id, { guest: viewer })).toHaveLength(1);
    expect(await zipItems(db(), s.event.id)).toHaveLength(2);
  });

  it("allows 5 full downloads per event per day, counting every part", async () => {
    const s = await setup();
    const now = new Date("2026-12-12T10:00:00Z");
    for (let i = 0; i < FULL_DOWNLOADS_PER_DAY; i++) expect(await allowFullDownload(db(), s.event.id, 2, now)).toBe(true);
    // Part 2 is used up even though part 1 was never fetched.
    expect(await allowFullDownload(db(), s.event.id, 2, now)).toBe(false);
    expect(await allowFullDownload(db(), s.event.id, 1, now)).toBe(true);
    expect(await allowFullDownload(db(), s.event.id, 2, new Date(now.getTime() + 25 * 3600_000))).toBe(true);
  });

  it("guest ZIP parts count per family and per event (S3)", async () => {
    const s = await setup();
    const now = new Date("2026-12-12T10:00:00Z");
    const fam = await Promise.all(["A", "B", "C", "D", "E", "F"].map((n, i) => s.family(n, [s.sangeet.id], `+91987650010${i}`)));
    const part = (h: string, p = 1) => allowGuestZipPart(db(), { eventId: s.event.id, householdId: h, functionId: s.sangeet.id, part: p }, now);
    // Event-wide: the same part at most 5 times a day across families.
    for (let i = 0; i < FULL_DOWNLOADS_PER_DAY; i++) expect(await part(fam[i].id)).toBe(true);
    expect(await part(fam[5].id)).toBe(false);
    // Per family: every part counts.
    for (let p = 2; p < 2 + GUEST_ZIP_PARTS_PER_DAY - 1; p++) expect(await part(fam[0].id, p)).toBe(true);
    expect(await part(fam[0].id, 50)).toBe(false);
  });

  it("ZIP parts stay small enough for one request; paths use the event's day and hide other families' names", async () => {
    const many = Array.from({ length: ZIP_PART_FILES + 1 }, () => ({ originalBytes: 1 }));
    expect(splitParts(many).map((p) => p.length)).toEqual([ZIP_PART_FILES, 1]);
    expect(splitParts([{ originalBytes: 300 * MB }, { originalBytes: 300 * MB }]).length).toBe(2);
    const it0 = {
      id: "0a1b2c3d-0000-4000-8000-000000000000",
      filename: "Rahul's GPS photo.JPG",
      originalKey: "k",
      originalBytes: 1,
      // 20:00 UTC on the 10th is already the 11th in India.
      takenAt: new Date("2026-12-10T20:00:00Z"),
      kind: "photo" as const,
      mime: "image/jpeg",
      householdId: "h-other",
      shareKey: null,
      previewError: null,
      functionName: "Sangeet",
      albumTitle: "",
      albumKind: "guest" as const,
    };
    const label = () => "Guest photos";
    expect(zipPath(it0, label, "Asia/Kolkata")).toBe("Sangeet/Guest photos/2026-12-11-0a1b2c3d-Rahul's GPS photo.jpg");
    expect(zipPath(it0, label, "UTC")).toContain("/2026-12-10-");
    expect(zipPath(it0, label, "Asia/Kolkata", { forHousehold: "h-mine" })).toBe("Sangeet/Guest photos/2026-12-11-0a1b2c3d.jpg");
    expect(zipPath(it0, label, "Asia/Kolkata", { forHousehold: "h-other" })).toContain("Rahul");
    // The extension comes from the verified type, never the file name.
    expect(zipPath({ ...it0, filename: "evil.html", mime: "image/heic" }, label, "UTC")).toMatch(/evil\.heic$/);
    expect(zipPath({ ...it0, mime: "image/heic" }, label, "UTC", { mime: "image/jpeg", forHousehold: "x" })).toMatch(/0a1b2c3d\.jpg$/);
    expect(guestZipFile(it0, "h-mine")).toEqual({ key: "k", strip: true, mime: "image/jpeg" });
    expect(guestZipFile({ ...it0, previewError: "decode" }, "h-mine")).toBeNull();
    expect(guestZipFile({ ...it0, previewError: "decode" }, "h-other")).toEqual({ key: "k", strip: false, mime: "image/jpeg" });
  });

  it("erasing a family gives back its storage at once (EVT-09)", async () => {
    const s = await setup();
    const sharma = await s.family("Sharma", [s.sangeet.id]);
    await updateGallerySettings(db(), s.event.id, s.actor, { guestUploads: true, autoApprove: true, guestOriginals: false, reactions: true, watermarkText: null });
    const g: Uploader = { kind: "guest", householdId: sharma.id };
    await upload(s.event.id, g, { functionId: s.sangeet.id, bytes: await jpeg() });
    await beginUpload(db(), store, s.event.id, g, { functionId: s.sangeet.id, clientKey: randomUUID(), filename: "b.jpg", mime: "image/jpeg", size: 4321 });
    const team = await upload(s.event.id, s.member, { functionId: s.sangeet.id, bytes: await jpeg() });
    await deleteHousehold(db(), s.event.id, sharma.id, s.actor);
    const u = await usage(s.event.id);
    expect(u.usedBytes).toBe(team.originalBytes);
    expect(u.reservedBytes).toBe(0);
  });

  it("erasing a family removes its media rows and files; usage is reconciled", async () => {
    const s = await setup();
    const sharma = await s.family("Sharma", [s.sangeet.id]);
    await updateGallerySettings(db(), s.event.id, s.actor, { guestUploads: true, autoApprove: true, guestOriginals: false, reactions: true, watermarkText: null });
    const g: Uploader = { kind: "guest", householdId: sharma.id };
    const mine = await upload(s.event.id, g, { functionId: s.sangeet.id, bytes: await jpeg() });
    const open = await beginUpload(db(), store, s.event.id, g, { functionId: s.sangeet.id, clientKey: randomUUID(), filename: "b.jpg", mime: "image/jpeg", size: 4321 });
    const team = await upload(s.event.id, s.member, { functionId: s.sangeet.id, bytes: await jpeg() });
    await processRenditions(db(), store);
    void open;
    await deleteHousehold(db(), s.event.id, sharma.id, s.actor);
    const rows = await db().select().from(mediaItems);
    expect(rows.map((r) => r.id)).toEqual([team.id]);
    await processStorageDeletions(db(), store);
    expect(await store.head(mine.originalKey)).toBeNull();
    // The open reservation and the used bytes come back with the nightly jobs.
    await sweepUploads(db(), store);
    await db().transaction((tx) => reconcileUsage(tx, s.event.id));
    const u = await getStorageUsage(db(), s.event.id);
    expect(u.reserved).toBe(0);
    expect(u.used).toBe(team.originalBytes);
    expect(u.breakdown.find((b) => b.key === "gallery.member")?.bytes).toBe(team.originalBytes);
  });

  it("deleting items frees quota; the orphan sweep removes files whose rows went with a cascade", async () => {
    const s = await setup();
    const a = await upload(s.event.id, s.member, { functionId: s.sangeet.id, bytes: await jpeg() });
    const b = await upload(s.event.id, s.member, { functionId: s.mehendi.id, bytes: await jpeg() });
    await processRenditions(db(), store);
    const ids = await deleteMedia(db(), { eventId: s.event.id, actor: s.actor, mediaIds: [a.id] });
    expect(ids).toHaveLength(1);
    expect((await usage(s.event.id)).usedBytes).toBe(b.originalBytes);
    // Deleting the Mehendi function cascades its rows; its files are orphans now.
    const { functions } = await import("@/db/schema");
    await db().delete(functions).where(and(eq(functions.id, s.mehendi.id), eq(functions.eventId, s.event.id)));
    expect(await sweepOrphanObjects(db(), store, new Date())).toBe(0); // younger than a day
    expect(await sweepOrphanObjects(db(), store, new Date(Date.now() + 2 * 86_400_000))).toBeGreaterThanOrEqual(3);
    expect(await store.head(b.originalKey)).toBeNull();
  });

  it("the orphan sweep stops at its time budget and resumes where it left off", async () => {
    const s = await setup();
    const kept = await upload(s.event.id, s.member, { functionId: s.sangeet.id, bytes: await jpeg({ w: 50, h: 50 }) });
    // Orphans spread over several prefixes (first hex digit of the id).
    const orphans = ["0", "7", "f"].map((d) => `events/${s.event.id}/gallery/${d}${randomUUID().slice(1)}/original`);
    for (const k of orphans) await store.put(k, Buffer.from("x"), "image/jpeg");
    const later = new Date(Date.now() + 2 * 86_400_000);
    let tick = 0;
    const clock = () => tick++;
    // A tiny budget: only a few steps fit.
    await sweepOrphanObjects(db(), store, later, { budgetMs: 4, clock });
    const { gallerySettings } = await import("@/db/schema");
    const [mid] = await db().select().from(gallerySettings).where(eq(gallerySettings.eventId, s.event.id));
    expect(mid.sweepStep).toBeGreaterThan(0);
    expect(mid.sweepStep).toBeLessThan(SWEEP_STEPS);
    expect(mid.sweptAt).toBeNull();
    await sweepOrphanObjects(db(), store, later);
    const [done] = await db().select().from(gallerySettings).where(eq(gallerySettings.eventId, s.event.id));
    expect(done).toMatchObject({ sweepStep: 0 });
    expect(done.sweptAt).not.toBeNull();
    for (const k of orphans) expect(await store.head(k)).toBeNull();
    expect(await store.head(kept.originalKey)).not.toBeNull();
  });
});

describe("review fixes: quota, retries, content checks", () => {
  it("an upload whose reservation expired is committed as new usage without touching another upload's reservation", async () => {
    const s = await setup();
    const sharma = await s.family("Sharma", [s.sangeet.id]);
    await updateGallerySettings(db(), s.event.id, s.actor, { guestUploads: true, autoApprove: false, guestOriginals: false, reactions: true, watermarkText: null });
    const g: Uploader = { kind: "guest", householdId: sharma.id };
    const bytes = await jpeg();
    const t0 = new Date("2026-12-11T10:00:00Z");
    const begin = (at: Date) =>
      beginUpload(db(), store, s.event.id, g, { functionId: s.sangeet.id, clientKey: randomUUID(), filename: "a.jpg", mime: "image/jpeg", size: bytes.length }, at) as Promise<Extract<BeginResult, { grant: unknown }>>;
    const a = await begin(t0);
    await store.put(a.grant.key, bytes, "image/jpeg");
    // A second upload of the same size, later: A's reservation (30 min + 1 h) is given back first.
    const b = await begin(new Date(t0.getTime() + 110 * 60_000));
    const hh = async () => (await db().select().from(storageHouseholdUsage).where(eq(storageHouseholdUsage.householdId, sharma.id)))[0];
    expect((await usage(s.event.id)).reservedBytes).toBe(bytes.length);
    expect(await hh()).toMatchObject({ items: 1, bytes: bytes.length });
    // A's row still names its (gone) reservation: it's counted as new usage, B's stays reserved.
    const [aRow] = await db().select().from(mediaItems).where(eq(mediaItems.id, a.mediaId));
    expect(aRow.reservationId).not.toBeNull();
    await completeUpload(db(), store, s.event.id, g, a.mediaId);
    expect(await usage(s.event.id)).toMatchObject({ reservedBytes: bytes.length, usedBytes: bytes.length });
    expect(await hh()).toMatchObject({ items: 2, bytes: 2 * bytes.length });
    // An old row whose id was nulled (former FK) is treated as already given back too.
    const c = await begin(new Date(t0.getTime() + 111 * 60_000));
    const [cRow] = await db().select().from(mediaItems).where(eq(mediaItems.id, c.mediaId));
    await db().update(mediaItems).set({ reservationId: null }).where(eq(mediaItems.id, c.mediaId));
    // As if C's reservation had expired and been given back by the daily job.
    await db().delete(storageReservations).where(eq(storageReservations.id, cRow.reservationId!));
    await db().update(storageUsage).set({ reservedBytes: bytes.length }).where(eq(storageUsage.eventId, s.event.id));
    await db().update(storageHouseholdUsage).set({ items: 2, bytes: 2 * bytes.length }).where(eq(storageHouseholdUsage.householdId, sharma.id));
    await abortUpload(db(), store, s.event.id, g, c.mediaId);
    expect((await usage(s.event.id)).reservedBytes).toBe(bytes.length); // B's reservation untouched
    // B completes normally.
    await store.put(b.grant.key, bytes, "image/jpeg");
    await completeUpload(db(), store, s.event.id, g, b.mediaId);
    expect(await usage(s.event.id)).toMatchObject({ reservedBytes: 0, usedBytes: 2 * bytes.length });
    expect(await hh()).toMatchObject({ items: 2, bytes: 2 * bytes.length });
  });

  it("a retried begin after a lost 'complete' finishes the upload instead of failing for ever", async () => {
    const s = await setup();
    const bytes = await jpeg();
    const input = { functionId: s.sangeet.id, clientKey: randomUUID(), filename: "a.jpg", mime: "image/jpeg", size: bytes.length };
    const first = (await beginUpload(db(), store, s.event.id, s.member, input)) as Extract<BeginResult, { grant: unknown }>;
    await store.put(first.grant.key, bytes, "image/jpeg");
    const again = await beginUpload(db(), store, s.event.id, s.member, input);
    expect(again).toEqual({ mediaId: first.mediaId, done: true, status: "processing" });
    expect(await usage(s.event.id)).toMatchObject({ reservedBytes: 0, usedBytes: bytes.length });
  });

  it("checks the real file type from its first bytes and drops mismatches (S1)", async () => {
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMime(Buffer.from("\x89PNG\r\n\x1a\n0000", "latin1"))).toBe("image/png");
    expect(sniffMime(Buffer.from("RIFF0000WEBPVP8 ", "latin1"))).toBe("image/webp");
    expect(sniffMime(Buffer.from("\0\0\0\x18ftypheic\0\0\0\0", "latin1"))).toBe("image/heic");
    expect(sniffMime(Buffer.from("\0\0\0\x18ftypisom\0\0\0\0", "latin1"))).toBe("video/mp4");
    expect(sniffMime(Buffer.from("\0\0\0\x14ftypqt  \0\0\0\0", "latin1"))).toBe("video/quicktime");
    expect(sniffMime(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBe("video/webm");
    expect(sniffMime(Buffer.from("<html><script>", "latin1"))).toBeNull();
    expect(sniffMime(Buffer.from("\0\0\0\x18ftypavif\0\0\0\0", "latin1"))).toBeNull();

    const s = await setup();
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).png().toBuffer();
    // Declared JPEG, really PNG.
    await expect(upload(s.event.id, s.member, { functionId: s.sangeet.id, bytes: png, mime: "image/jpeg" })).rejects.toMatchObject({ code: "bad_type" });
    // Declared video, really a web page.
    await expect(upload(s.event.id, s.member, { functionId: s.sangeet.id, bytes: Buffer.from("<html><script>alert(1)</script></html>"), mime: "video/mp4" })).rejects.toMatchObject({ code: "bad_type" });
    expect(await db().select().from(mediaItems)).toHaveLength(0);
    expect(await usage(s.event.id)).toMatchObject({ reservedBytes: 0, usedBytes: 0 });
    // A PNG declared as PNG is fine.
    expect((await upload(s.event.id, s.member, { functionId: s.sangeet.id, bytes: png, mime: "image/png" })).mime).toBe("image/png");
  });

  it("strips location and camera metadata from JPEGs for guests, keeping orientation and capture time (S2)", async () => {
    const withGps = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#c33" } })
      .withExif({
        IFD0: { Make: "Phone", Model: "Secret 1" },
        IFD2: { DateTimeOriginal: "2026:12:10 19:30:15", OffsetTimeOriginal: "+05:30", BodySerialNumber: "SN123" },
        IFD3: { GPSLatitudeRef: "N", GPSLatitude: "28/1 36/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "77/1 12/1 0/1" },
      })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const before = await sharp(withGps).metadata();
    expect(before.orientation).toBe(6);
    expect(before.exif!.includes(Buffer.from("Secret 1"))).toBe(true);
    const out = stripJpegMetadata(withGps);
    const meta = await sharp(out).metadata();
    expect([meta.format, meta.width, meta.height, meta.orientation]).toEqual(["jpeg", 40, 20, 6]);
    expect(readExifDate(meta.exif)).toEqual({ date: "2026-12-10", time: "19:30:15", offset: "+05:30" });
    for (const secret of ["Secret 1", "SN123", "Phone"]) expect(meta.exif!.includes(Buffer.from(secret))).toBe(false);
    const tags = parseExif(meta.exif)!;
    expect(tags.ifd0.has(0x8825)).toBe(false); // no GPS IFD
    // Pixels survive untouched (lossless copy).
    const [a, b] = await Promise.all([sharp(withGps).raw().toBuffer(), sharp(out).raw().toBuffer()]);
    expect(a.equals(b)).toBe(true);
    expect(() => stripJpegMetadata(Buffer.from("nope"))).toThrow(NotJpegError);
  });

  it("a temporary failure retries after a short backoff, and the drain knows to come back", async () => {
    const s = await setup();
    const item = await upload(s.event.id, s.member, { functionId: s.sangeet.id, bytes: await jpeg({ w: 100, h: 100 }) });
    const flaky = Object.create(store) as typeof store;
    flaky.getBytes = async () => null;
    const t0 = new Date();
    const r1 = await processRenditions(db(), flaky, { now: () => t0 });
    expect(r1).toMatchObject({ processed: 1, remaining: 0 });
    const [row] = await db().select().from(mediaItems).where(eq(mediaItems.id, item.id));
    expect(row.status).toBe("processing");
    expect(row.lockedUntil!.getTime() - t0.getTime()).toBe(RETRY_BASE_MS);
    const delay = nextRenditionsDelay(r1, t0);
    expect(delay).toBe(RETRY_BASE_MS);
    expect(nextRenditionsDelay({ processed: 0, remaining: 0, nextDueAt: new Date(t0.getTime() + 3600_000) }, t0)).toBeNull();
    expect(nextRenditionsDelay({ processed: 0, remaining: 2, nextDueAt: null }, t0)).toBe(0);
    // After the backoff, it goes through.
    const r2 = await processRenditions(db(), store, { now: () => new Date(t0.getTime() + RETRY_BASE_MS + 1000) });
    expect(r2.processed).toBe(1);
    expect((await db().select().from(mediaItems).where(eq(mediaItems.id, item.id)))[0].status).toBe("approved");
  });

  it("watermarked guest copies are made once per watermark text (S4)", async () => {
    const s = await setup();
    const item = await upload(s.event.id, s.member, { functionId: s.sangeet.id, bytes: await jpeg({ w: 300, h: 200 }) });
    await processRenditions(db(), store);
    const [row] = await db().select().from(mediaItems).where(eq(mediaItems.id, item.id));
    const k1 = await watermarkedCopy(store, row, "Priya & Arjun");
    expect(k1).toBe(watermarkKey(row, "Priya & Arjun"));
    const meta = await sharp((await store.getBytes(k1!))!).metadata();
    expect([meta.format, meta.width]).toEqual(["jpeg", 300]);
    const spy = Object.create(store) as typeof store;
    let reads = 0;
    spy.getBytes = async (k) => {
      reads++;
      return store.getBytes(k);
    };
    expect(await watermarkedCopy(spy, row, "Priya & Arjun")).toBe(k1);
    expect(reads).toBe(0); // cached
    expect(await watermarkedCopy(spy, row, "P & A")).not.toBe(k1);
  });
});

describe("'photos are ready' after processing, and when the limit refuses it (GAL-11)", () => {
  it("sends once the released album's photos finish processing; quota leaves a 'Send now' state", async () => {
    const s = await setup();
    const sharma = await s.family("Sharma", [s.sangeet.id, s.mehendi.id], "+919876500001");
    const { vendor, user } = await s.book("Lens", "lens@example.com", "photography", s.sangeet.id);
    const v: Uploader = { kind: "vendor", vendorId: vendor.id, userId: user.id };
    const album = await createVendorAlbum(db(), { eventId: s.event.id, vendorId: vendor.id, userId: user.id, functionId: s.sangeet.id, title: "Full" });
    await upload(s.event.id, v, { functionId: s.sangeet.id, albumId: album.id, bytes: await jpeg() });
    // Released while the photo is still processing: nothing to announce yet.
    const r = await releaseAlbum(db(), { eventId: s.event.id, actor: s.actor, albumId: album.id, release: true, appUrl: "http://x" });
    expect(r.notified).toBe(0);
    expect(await readyNotice(db(), s.event.id, s.sangeet.id)).toBeNull();
    await processRenditions(db(), store, { appUrl: "http://x" });
    const sent = await db().select().from(outboundMessages).where(eq(outboundMessages.templateKey, "gallery_ready"));
    expect(sent.map((m) => m.householdId)).toEqual([sharma.id]);
    expect((await readyNotice(db(), s.event.id, s.sangeet.id))?.status).toBe("sent");
    // More photos later don't message again.
    await upload(s.event.id, s.member, { functionId: s.sangeet.id, albumId: null, bytes: await jpeg() });
    await processRenditions(db(), store);
    expect(await db().select().from(outboundMessages).where(eq(outboundMessages.templateKey, "gallery_ready"))).toHaveLength(1);

    // Mehendi: the WhatsApp limit is used up, so it's kept as "not sent".
    await db().insert(eventLimitOverrides).values({ eventId: s.event.id, channel: "whatsapp", limit: 0 });
    const henna = await createAlbum(db(), { eventId: s.event.id, actor: s.actor, functionId: s.mehendi.id, title: "Henna" });
    await upload(s.event.id, s.member, { functionId: s.mehendi.id, albumId: henna.id, bytes: await jpeg() });
    await processRenditions(db(), store);
    const q = await releaseAlbum(db(), { eventId: s.event.id, actor: s.actor, albumId: henna.id, release: true, appUrl: "http://x" });
    expect(q).toMatchObject({ notified: 0, quota: "whatsapp" });
    expect(await readyNotice(db(), s.event.id, s.mehendi.id)).toMatchObject({ status: "quota", channel: "whatsapp" });
    // Not retried automatically (no repeated quota errors on every photo)...
    expect(await db().transaction((tx) => notifyFunctionReady(tx, { eventId: s.event.id, functionId: s.mehendi.id, appUrl: "" }))).toMatchObject({ notified: 0, quota: "whatsapp" });
    // ...but a Host can send it once there's room.
    await db().update(eventLimitOverrides).set({ limit: 100 }).where(eq(eventLimitOverrides.eventId, s.event.id));
    expect(await sendReadyNow(db(), { eventId: s.event.id, actor: s.actor, albumId: henna.id, appUrl: "http://x" })).toMatchObject({ notified: 1, quota: null });
    expect((await readyNotice(db(), s.event.id, s.mehendi.id))?.status).toBe("sent");
  });
});
