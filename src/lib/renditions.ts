import { createHash } from "node:crypto";
import sharp, { type Exif, type Sharp } from "sharp";
import { and, asc, eq, inArray, isNull, lt, min, or, sql } from "drizzle-orm";
import type { Database } from "@/db";
import { events, galleryAlbums, gallerySettings, mediaItems, type MediaItem } from "@/db/schema";
import { zonedInstant } from "./caterer-headcount";
import { notifyFunctionReady } from "./gallery";
import { parseExif, readExifTags } from "./media-files";
import type { ObjectStore } from "./storage";
import { resolveAppUrl } from "@/lib/app-url";

/**
 * Thumbnails and web renditions for gallery photos (ADR-0032).
 *
 * Items arrive here in `processing` once their upload is confirmed. A worker claims one at a time
 * with `FOR UPDATE SKIP LOCKED` (so the drain route, the dev fallback and the daily cron never
 * process the same item twice). Memory is the constraint on a serverless function, so sharp runs
 * with one thread, no cache and a 100 MP input limit, and each photo is decoded once at full size:
 * the 2048 px web copy comes from the original, the 480 px thumbnail from the web copy.
 * HEIC/HEIF (iPhone photos) are decoded with libheif in WebAssembly (`heic-decode`), because the
 * prebuilt sharp has no HEVC decoder. Non-JPEG photos also get a full-size JPEG without metadata
 * (`share.jpg`) for guests (S2); JPEG originals are stripped on the fly instead.
 *
 * Then the item becomes visible: guest uploads `pending` (or `approved` with auto-approve, GAL-04),
 * family and vendor uploads `approved`. A guest upload whose preview failed is never auto-approved.
 * Videos aren't transcoded (no thumbnail; the browser streams the original).
 */

sharp.concurrency(1);
sharp.cache(false);

export const THUMB_PX = 480;
export const WEB_PX = 2048;
/** Refuse to decode bigger images (a 100 MP RGBA frame is already ~400 MB). */
export const MAX_INPUT_PIXELS = 100_000_000;
const LOCK_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 3;
/** Backoff after a temporary failure: 30 s, then 60 s (the drain waits for these, see route). */
export const RETRY_BASE_MS = 30_000;
/** The drain route waits for retries due within this window rather than leaving them to the cron. */
export const DRAIN_WAIT_WINDOW_MS = 2 * 60_000;

// ---------------------------------------------------------------------------
// EXIF capture time
// ---------------------------------------------------------------------------

/**
 * Reads DateTimeOriginal (or DateTimeDigitized / DateTime) and OffsetTimeOriginal from a raw EXIF
 * block (sharp's `metadata().exif`). Returns local date/time parts and an optional UTC offset.
 */
export function readExifDate(exif: Buffer | undefined | null): { date: string; time: string; offset: string | null } | null {
  if (!parseExif(exif)) return null;
  const tags = readExifTags(exif);
  const m = tags.dateTime ? tags.dateTime.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/) : null;
  if (!m) return null;
  const year = Number(m[1]);
  if (year < 1990 || year > 2100 || m[2] === "00" || m[3] === "00") return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}:${m[6]}`, offset: tags.offset };
}

/** The capture instant: with the camera's offset if recorded, else as event-local wall clock. */
export function captureInstant(exif: ReturnType<typeof readExifDate>, timeZone: string): Date | null {
  if (!exif) return null;
  if (exif.offset) {
    const d = new Date(`${exif.date}T${exif.time}${exif.offset}`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = zonedInstant(exif.date, exif.time.slice(0, 5), timeZone);
  return new Date(d.getTime() + Number(exif.time.slice(6, 8)) * 1000);
}

// ---------------------------------------------------------------------------
// One item
// ---------------------------------------------------------------------------

export function renditionKeys(item: Pick<MediaItem, "originalKey">) {
  const dir = item.originalKey.slice(0, item.originalKey.length - "original".length);
  return { thumb: `${dir}thumb.webp`, web: `${dir}web.webp`, share: `${dir}share.jpg` };
}

/** The cached watermarked guest copy for one watermark text (S4); changes with the text. */
export function watermarkKey(item: Pick<MediaItem, "originalKey">, text: string) {
  const dir = item.originalKey.slice(0, item.originalKey.length - "original".length);
  return `${dir}web-wm-${createHash("sha256").update(text).digest("hex").slice(0, 12)}.jpg`;
}

export type Rendered = { thumb: Buffer; web: Buffer; share: Buffer | null; width: number; height: number; takenAt: Date | null };

const isHeif = (mime: string) => mime === "image/heic" || mime === "image/heif";

/** HEIC/HEIF → raw RGBA via libheif (WASM), checking the size before decoding the pixels. */
async function decodeHeif(bytes: Buffer) {
  const { default: decode } = await import("heic-decode");
  const images = await decode.all({ buffer: bytes });
  try {
    const first = images[0];
    if (!first) throw new Error("no image");
    if (first.width * first.height > MAX_INPUT_PIXELS) throw new Error("too many pixels");
    const d = await first.decode();
    return { width: d.width, height: d.height, data: Buffer.from(d.data.buffer, d.data.byteOffset, d.data.byteLength) };
  } finally {
    images.dispose();
  }
}

/** Capture time as EXIF text, for the share copy. */
function exifFor(tags: ReturnType<typeof readExifTags>): Exif | null {
  if (!tags.dateTime) return null;
  return { IFD2: { DateTimeOriginal: tags.dateTime, ...(tags.offset ? { OffsetTimeOriginal: tags.offset } : {}) } };
}

/** Makes the renditions of one photo (throws when it can't be decoded). Sequential, one decode. */
export async function renderPhoto(bytes: Buffer, timeZone: string, mime = "image/jpeg"): Promise<Rendered> {
  const opts = { failOn: "error" as const, limitInputPixels: MAX_INPUT_PIXELS };
  let exif: Buffer | undefined;
  try {
    exif = (await sharp(bytes, opts).metadata()).exif;
  } catch {
    // HEIF containers usually still give their metadata; if not, there's no capture time.
  }
  const tags = readExifTags(exif);

  let full: () => Sharp;
  let width: number;
  let height: number;
  if (isHeif(mime)) {
    // libheif already applies the HEIF rotation/mirroring.
    const raw = await decodeHeif(bytes);
    width = raw.width;
    height = raw.height;
    full = () => sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 }, limitInputPixels: MAX_INPUT_PIXELS });
  } else {
    const meta = await sharp(bytes, opts).metadata();
    const rotated = (meta.orientation ?? 1) >= 5;
    width = (rotated ? meta.height : meta.width) ?? 0;
    height = (rotated ? meta.width : meta.height) ?? 0;
    full = () => sharp(bytes, opts).rotate();
  }
  // One full-size decode for the web copy; the thumbnail is made from the (small) web copy.
  const web = await full().resize({ width: WEB_PX, height: WEB_PX, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  const thumb = await sharp(web).resize({ width: THUMB_PX, height: THUMB_PX, fit: "inside", withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
  let share: Buffer | null = null;
  if (mime !== "image/jpeg") {
    // Guests never get the original file of a HEIC/PNG/WebP (metadata, S2): a clean full-size JPEG.
    let img = full().flatten({ background: "#ffffff" }).jpeg({ quality: 92 });
    const e = exifFor(tags);
    if (e) img = img.withExif(e);
    share = await img.toBuffer();
  }
  const takenAt = captureInstant(readExifDate(exif), timeZone);
  return { thumb, web, share, width, height, takenAt };
}

function finalStatus(item: MediaItem, autoApprove: boolean, previewFailed: boolean): "pending" | "approved" {
  if (item.uploaderKind !== "household") return "approved";
  // A guest upload we couldn't decode is never auto-approved (S1): a person looks at it first.
  return autoApprove && !previewFailed ? "approved" : "pending";
}

async function retryLater(db: Database, item: MediaItem, now: Date, error: string) {
  if (item.processingAttempts >= MAX_ATTEMPTS) {
    await db.update(mediaItems).set({ status: "failed", previewError: error, lockedUntil: null }).where(eq(mediaItems.id, item.id));
    return;
  }
  const backoff = RETRY_BASE_MS * 2 ** Math.max(0, item.processingAttempts - 1);
  await db
    .update(mediaItems)
    .set({ lockedUntil: new Date(now.getTime() + backoff) })
    .where(eq(mediaItems.id, item.id));
}

async function processOne(db: Database, store: ObjectStore, item: MediaItem, now: Date, appUrl: string) {
  const [ctx] = await db
    .select({ timezone: events.timezone, autoApprove: gallerySettings.autoApprove, releasedAt: galleryAlbums.releasedAt, albumKind: galleryAlbums.kind })
    .from(events)
    .leftJoin(gallerySettings, eq(gallerySettings.eventId, events.id))
    .leftJoin(galleryAlbums, eq(galleryAlbums.id, item.albumId))
    .where(eq(events.id, item.eventId));
  if (!ctx) return;
  const done = async (set: Partial<typeof mediaItems.$inferInsert>, previewFailed = false) => {
    const status = finalStatus(item, !!ctx.autoApprove, previewFailed);
    const rows = await db
      .update(mediaItems)
      .set({ status, lockedUntil: null, ...(status === "approved" ? { approvedAt: now } : {}), ...set })
      .where(and(eq(mediaItems.id, item.id), eq(mediaItems.status, "processing")))
      .returning({ id: mediaItems.id });
    // An album released while this was processing: tell invited families now (GAL-11).
    if (rows.length && status === "approved" && ctx.releasedAt && ctx.albumKind !== "guest") {
      await db.transaction((tx) => notifyFunctionReady(tx, { eventId: item.eventId, functionId: item.functionId, appUrl }));
    }
  };

  if (item.kind === "video") return done({});

  const bytes = await store.getBytes(item.originalKey).catch(() => null);
  if (!bytes) return retryLater(db, item, now, "missing");
  let r: Rendered;
  try {
    r = await renderPhoto(bytes, ctx.timezone, item.mime);
  } catch {
    // Can't decode: no preview; the family still has the original (guests get no file of it).
    return done({ previewError: "decode" }, true);
  }
  const keys = renditionKeys(item);
  await store.put(keys.thumb, r.thumb, "image/webp");
  await store.put(keys.web, r.web, "image/webp");
  if (r.share) await store.put(keys.share, r.share, "image/jpeg");
  await done({
    thumbKey: keys.thumb,
    webKey: keys.web,
    shareKey: r.share ? keys.share : null,
    width: r.width || null,
    height: r.height || null,
    ...(r.takenAt ? { takenAt: r.takenAt } : {}),
    previewError: null,
  });
}

/** Claims up to `n` items that need renditions (skipping ones another worker holds). */
async function claim(db: Database, now: Date, n: number, ids?: string[]) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(mediaItems)
      .where(
        and(
          eq(mediaItems.status, "processing"),
          or(isNull(mediaItems.lockedUntil), lt(mediaItems.lockedUntil, now)),
          ids ? inArray(mediaItems.id, ids) : undefined,
        ),
      )
      .orderBy(asc(mediaItems.createdAt))
      .limit(n)
      .for("update", { skipLocked: true });
    if (rows.length) {
      await tx
        .update(mediaItems)
        .set({ lockedUntil: new Date(now.getTime() + LOCK_MS), processingAttempts: sql`${mediaItems.processingAttempts} + 1` })
        .where(inArray(mediaItems.id, rows.map((r) => r.id)));
    }
    return rows.map((r) => ({ ...r, processingAttempts: r.processingAttempts + 1 }));
  });
}

export type RenditionsResult = {
  processed: number;
  /** Items ready to process now. */
  remaining: number;
  /** When the next item waiting on a retry (or another worker's lease) falls due, if any. */
  nextDueAt: Date | null;
};

/**
 * Processes queued items one at a time until none are left or the time budget runs out.
 * `ids` limits it to particular items. Returns what's left and when the next retry is due.
 */
export async function processRenditions(
  db: Database,
  store: ObjectStore,
  opts: { budgetMs?: number; ids?: string[]; now?: () => Date; concurrency?: number; appUrl?: string } = {},
): Promise<RenditionsResult> {
  const started = Date.now();
  const clock = opts.now ?? (() => new Date());
  const appUrl = (opts.appUrl || resolveAppUrl()).replace(/\/$/, "");
  let processed = 0;
  for (;;) {
    if (opts.budgetMs && Date.now() - started > opts.budgetMs) break;
    const batch = await claim(db, clock(), opts.concurrency ?? 1, opts.ids);
    if (batch.length === 0) break;
    for (const item of batch) {
      await processOne(db, store, item, clock(), appUrl).catch(async (err) => {
        console.error("rendition failed", item.id, err);
        await retryLater(db, item, clock(), "error");
      });
    }
    processed += batch.length;
  }
  const now = clock();
  const [r] = await db
    .select({
      remaining: sql<number>`count(*) filter (where ${mediaItems.lockedUntil} is null or ${mediaItems.lockedUntil} < ${now})`.mapWith(Number),
      nextDue: min(mediaItems.lockedUntil),
    })
    .from(mediaItems)
    .where(eq(mediaItems.status, "processing"));
  return { processed, remaining: r?.remaining ?? 0, nextDueAt: r?.nextDue ?? null };
}

/**
 * How long the drain should wait before calling itself again: now when items are ready, the
 * time until the next retry when it's due soon, otherwise null (the daily cron picks it up).
 */
export function nextRenditionsDelay(res: RenditionsResult, now: Date): number | null {
  if (res.remaining > 0) return 0;
  if (!res.nextDueAt) return null;
  const wait = res.nextDueAt.getTime() - now.getTime();
  return wait <= DRAIN_WAIT_WINDOW_MS ? Math.max(0, wait) : null;
}

// ---------------------------------------------------------------------------
// Watermark (GAL-10): applied to the guest copy, cached per watermark text (S4)
// ---------------------------------------------------------------------------

const XML_ESC: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" };
const xml = (s: string) => s.replace(/[<>&"']/g, (c) => XML_ESC[c]);

/** Stamps `text` in the bottom-right corner and returns a JPEG (no metadata). */
export async function watermark(bytes: Buffer, text: string): Promise<Buffer> {
  const meta = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  const rotated = (meta.orientation ?? 1) >= 5;
  const w = (rotated ? meta.height : meta.width) ?? WEB_PX;
  const h = (rotated ? meta.width : meta.height) ?? WEB_PX;
  const size = Math.max(14, Math.round(Math.min(w, h) * 0.035));
  const pad = Math.round(size * 0.8);
  const stroke = Math.max(1, Math.round(size / 18));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><text x="${w - pad}" y="${h - pad}" text-anchor="end" font-family="sans-serif" font-size="${size}" fill="#ffffff" fill-opacity="0.75" stroke="#000000" stroke-opacity="0.35" stroke-width="${stroke}">${xml(text.slice(0, 60))}</text></svg>`;
  return sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

/** The watermarked guest copy of an item's web rendition, made once per watermark text. */
export async function watermarkedCopy(store: ObjectStore, item: Pick<MediaItem, "originalKey" | "webKey">, text: string): Promise<string | null> {
  if (!item.webKey) return null;
  const key = watermarkKey(item, text);
  if (await store.head(key)) return key;
  const web = await store.getBytes(item.webKey);
  if (!web) return null;
  await store.put(key, await watermark(web, text), "image/jpeg");
  return key;
}
