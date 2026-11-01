import sharp from "sharp";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "@/db";
import { events, gallerySettings, mediaItems, type MediaItem } from "@/db/schema";
import { zonedInstant } from "./caterer-headcount";
import type { ObjectStore } from "./storage";

/**
 * Thumbnails and web renditions for gallery photos (ADR-0032).
 *
 * Items arrive here in `processing` once their upload is confirmed. A worker claims up to two at
 * a time with `FOR UPDATE SKIP LOCKED` (so the after-response hook, the drain route and the
 * daily cron never process the same item twice), and with sharp: auto-rotates by EXIF, writes a
 * 480 px WebP thumbnail and a 2048 px WebP web copy, and reads the EXIF capture time. Then the
 * item becomes visible: guest uploads `pending` (or `approved` with auto-approve, GAL-04),
 * family and vendor uploads `approved`.
 *
 * Videos aren't transcoded (no thumbnail; the browser streams the original). A photo sharp can't
 * decode (some HEIC files) keeps a `preview_error`: it shows a placeholder but still downloads.
 */

export const THUMB_PX = 480;
export const WEB_PX = 2048;
const LOCK_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// EXIF capture time
// ---------------------------------------------------------------------------

/**
 * Reads DateTimeOriginal (or DateTime) and OffsetTimeOriginal from a raw EXIF block (sharp's
 * `metadata().exif`, starting with "Exif\0\0"). Returns local date/time parts and an optional
 * UTC offset, or null.
 */
export function readExifDate(exif: Buffer | undefined | null): { date: string; time: string; offset: string | null } | null {
  if (!exif || exif.length < 14) return null;
  let base = 0;
  if (exif.subarray(0, 6).toString("latin1") === "Exif\0\0") base = 6;
  const order = exif.subarray(base, base + 2).toString("latin1");
  const le = order === "II";
  if (!le && order !== "MM") return null;
  const u16 = (o: number) => (o + 2 <= exif.length ? (le ? exif.readUInt16LE(o) : exif.readUInt16BE(o)) : -1);
  const u32 = (o: number) => (o + 4 <= exif.length ? (le ? exif.readUInt32LE(o) : exif.readUInt32BE(o)) : -1);
  if (u16(base + 2) !== 42) return null;

  const readIfd = (offset: number) => {
    const tags = new Map<number, string | number>();
    const start = base + offset;
    const n = u16(start);
    if (n < 0 || n > 500) return tags;
    for (let i = 0; i < n; i++) {
      const e = start + 2 + i * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      const cnt = u32(e + 4);
      if (tag < 0 || cnt < 0) break;
      if (type === 2) {
        const at = cnt > 4 ? base + u32(e + 8) : e + 8;
        if (at < 0 || at + cnt > exif.length) continue;
        tags.set(tag, exif.subarray(at, at + cnt).toString("latin1").replace(/\0+$/, ""));
      } else if (type === 4) tags.set(tag, u32(e + 8));
    }
    return tags;
  };

  const ifd0 = readIfd(u32(base + 4));
  const exifPtr = ifd0.get(0x8769);
  const sub = typeof exifPtr === "number" ? readIfd(exifPtr) : new Map<number, string | number>();
  const raw = (sub.get(0x9003) ?? sub.get(0x9004) ?? ifd0.get(0x0132)) as string | undefined;
  const m = typeof raw === "string" ? raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/) : null;
  if (!m) return null;
  const year = Number(m[1]);
  if (year < 1990 || year > 2100 || m[2] === "00" || m[3] === "00") return null;
  const off = sub.get(0x9011);
  const offset = typeof off === "string" && /^[+-]\d{2}:\d{2}$/.test(off) ? off : null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}:${m[6]}`, offset };
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
  return { thumb: `${dir}thumb.webp`, web: `${dir}web.webp` };
}

export type Rendered = { thumb: Buffer; web: Buffer; width: number; height: number; takenAt: Date | null };

/** Makes the renditions of one photo (throws when sharp can't decode it). */
export async function renderPhoto(bytes: Buffer, timeZone: string): Promise<Rendered> {
  const meta = await sharp(bytes, { failOn: "error" }).metadata();
  const rotated = (meta.orientation ?? 1) >= 5;
  const width = (rotated ? meta.height : meta.width) ?? 0;
  const height = (rotated ? meta.width : meta.height) ?? 0;
  const resize = (px: number) =>
    sharp(bytes, { failOn: "error" })
      .rotate()
      .resize({ width: px, height: px, fit: "inside", withoutEnlargement: true })
      .webp({ quality: px <= THUMB_PX ? 72 : 82 })
      .toBuffer();
  const [thumb, web] = await Promise.all([resize(THUMB_PX), resize(WEB_PX)]);
  return { thumb, web, width, height, takenAt: captureInstant(readExifDate(meta.exif), timeZone) };
}

function finalStatus(item: MediaItem, autoApprove: boolean): "pending" | "approved" {
  return item.uploaderKind === "household" && !autoApprove ? "pending" : "approved";
}

async function processOne(db: Database, store: ObjectStore, item: MediaItem, now: Date) {
  const [ctx] = await db
    .select({ timezone: events.timezone, autoApprove: gallerySettings.autoApprove })
    .from(events)
    .leftJoin(gallerySettings, eq(gallerySettings.eventId, events.id))
    .where(eq(events.id, item.eventId));
  if (!ctx) return;
  const status = finalStatus(item, !!ctx.autoApprove);
  const approved = status === "approved" ? { approvedAt: now } : {};
  const done = (set: Partial<typeof mediaItems.$inferInsert>) =>
    db
      .update(mediaItems)
      .set({ status, lockedUntil: null, ...approved, ...set })
      .where(and(eq(mediaItems.id, item.id), eq(mediaItems.status, "processing")));

  if (item.kind === "video") return done({});

  const bytes = await store.getBytes(item.originalKey).catch(() => null);
  if (!bytes) {
    // Storage hiccup: retry later, give up after a few attempts.
    if (item.processingAttempts >= MAX_ATTEMPTS) {
      await db.update(mediaItems).set({ status: "failed", previewError: "missing", lockedUntil: null }).where(eq(mediaItems.id, item.id));
    } else {
      await db.update(mediaItems).set({ lockedUntil: new Date(now.getTime() + item.processingAttempts * LOCK_MS) }).where(eq(mediaItems.id, item.id));
    }
    return;
  }
  let r: Rendered;
  try {
    r = await renderPhoto(bytes, ctx.timezone);
  } catch {
    // Can't decode (e.g. some HEIC): no preview, but the original is kept and downloadable.
    return done({ previewError: "decode" });
  }
  const keys = renditionKeys(item);
  await store.put(keys.thumb, r.thumb, "image/webp");
  await store.put(keys.web, r.web, "image/webp");
  await done({ thumbKey: keys.thumb, webKey: keys.web, width: r.width || null, height: r.height || null, ...(r.takenAt ? { takenAt: r.takenAt } : {}), previewError: null });
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

/**
 * Processes queued items two at a time until none are left or the time budget runs out.
 * `ids` limits it to particular items (right after their upload). Returns what's left.
 */
export async function processRenditions(db: Database, store: ObjectStore, opts: { budgetMs?: number; ids?: string[]; now?: () => Date; concurrency?: number } = {}) {
  const started = Date.now();
  const clock = opts.now ?? (() => new Date());
  let processed = 0;
  for (;;) {
    if (opts.budgetMs && Date.now() - started > opts.budgetMs) break;
    const batch = await claim(db, clock(), opts.concurrency ?? 2, opts.ids);
    if (batch.length === 0) break;
    await Promise.all(
      batch.map((item) =>
        processOne(db, store, item, clock()).catch(async (err) => {
          console.error("rendition failed", item.id, err);
          if (item.processingAttempts >= MAX_ATTEMPTS) {
            await db.update(mediaItems).set({ status: "failed", previewError: "error", lockedUntil: null }).where(eq(mediaItems.id, item.id));
          }
        }),
      ),
    );
    processed += batch.length;
  }
  const [{ remaining }] = await db
    .select({ remaining: sql<number>`count(*)`.mapWith(Number) })
    .from(mediaItems)
    .where(and(eq(mediaItems.status, "processing"), or(isNull(mediaItems.lockedUntil), lt(mediaItems.lockedUntil, clock()))));
  return { processed, remaining };
}

// ---------------------------------------------------------------------------
// Watermark (GAL-10): applied to the guest download copy only, on the fly
// ---------------------------------------------------------------------------

const XML_ESC: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" };
const xml = (s: string) => s.replace(/[<>&"']/g, (c) => XML_ESC[c]);

/** Stamps `text` in the bottom-right corner and returns a JPEG. */
export async function watermark(bytes: Buffer, text: string): Promise<Buffer> {
  const meta = await sharp(bytes).metadata();
  const rotated = (meta.orientation ?? 1) >= 5;
  const w = (rotated ? meta.height : meta.width) ?? WEB_PX;
  const h = (rotated ? meta.width : meta.height) ?? WEB_PX;
  const size = Math.max(14, Math.round(Math.min(w, h) * 0.035));
  const pad = Math.round(size * 0.8);
  const stroke = Math.max(1, Math.round(size / 18));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><text x="${w - pad}" y="${h - pad}" text-anchor="end" font-family="sans-serif" font-size="${size}" fill="#ffffff" fill-opacity="0.75" stroke="#000000" stroke-opacity="0.35" stroke-width="${stroke}">${xml(text.slice(0, 60))}</text></svg>`;
  return sharp(bytes)
    .rotate()
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}
