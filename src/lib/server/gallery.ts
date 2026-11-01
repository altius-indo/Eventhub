import "server-only";
import { after } from "next/server";
import { getDb } from "@/db";
import type { GallerySettings } from "@/db/schema";
import type { Translator } from "@/i18n/core";
import type { ArchiveEntry } from "../archive";
import { zipStream } from "../archive";
import {
  abortUpload,
  beginUpload,
  completeUpload,
  GalleryError,
  getGallerySettings,
  householdFunctionIds,
  PHOTO_TYPES,
  VIDEO_TYPES,
  variantFor,
  VARIANTS,
  type LoadedMedia,
  type Uploader,
  type Variant,
  type Viewer,
} from "../gallery";
import { processRenditions, watermark } from "../renditions";
import { getStore, StorageError } from "../storage";
import { appUrl } from "./session";
import { getSiteContext } from "./site-context";

/**
 * Next glue for the gallery: the JSON upload endpoints shared by the three audiences, serving
 * media variants, and kicking off renditions after the response (ADR-0031/0032).
 */

/** After the response: make renditions for these items, then hand leftovers to the drain route. */
export function renditionsSoon(ids: string[]) {
  after(async () => {
    const db = getDb();
    const res = await processRenditions(db, getStore(), { ids, budgetMs: 40_000 });
    const secret = process.env.CRON_SECRET;
    if (res.remaining > 0 && secret) {
      await fetch(`${appUrl()}/api/gallery/renditions/drain`, { method: "POST", headers: { authorization: `Bearer ${secret}` } }).catch(() => undefined);
    }
  });
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

export function galleryErrorMessage(t: Translator, e: GalleryError) {
  return t(`gallery.errors.${e.code}`);
}

/**
 * `POST` body `{ action: "begin", functionId, albumId?, clientKey, filename, mime, size }`,
 * `{ action: "complete", mediaId }` or `{ action: "abort", mediaId }`. Permissions are decided by
 * the caller (who builds `uploader`) and re-checked in the domain functions.
 */
export async function handleUploadRequest(req: Request, eventId: string, uploader: Uploader, t: Translator) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: t("gallery.errors.invalid") }, 400);
  }
  const db = getDb();
  const store = getStore();
  try {
    if (body.action === "begin") {
      const res = await beginUpload(db, store, eventId, uploader, {
        functionId: String(body.functionId ?? ""),
        albumId: body.albumId ? String(body.albumId) : null,
        clientKey: String(body.clientKey ?? ""),
        filename: String(body.filename ?? ""),
        mime: String(body.mime ?? ""),
        size: Number(body.size),
      });
      return json(res);
    }
    if (body.action === "complete") {
      const item = await completeUpload(db, store, eventId, uploader, String(body.mediaId ?? ""));
      if (item.status === "processing") renditionsSoon([item.id]);
      return json({ mediaId: item.id, status: item.status });
    }
    if (body.action === "abort") {
      await abortUpload(db, store, eventId, uploader, String(body.mediaId ?? ""));
      return json({ ok: true });
    }
    return json({ error: t("gallery.errors.invalid") }, 400);
  } catch (e) {
    if (e instanceof GalleryError) return json({ error: galleryErrorMessage(t, e), code: e.code }, e.code === "not_found" ? 404 : 400);
    if (e instanceof StorageError) return json({ error: t("gallery.errors.invalid"), code: e.code }, 400);
    throw e;
  }
}

const PLACEHOLDER = (label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480" viewBox="0 0 480 480"><rect width="480" height="480" fill="#8884"/><path d="M200 170v140l110-70z" fill="#fff9"/><text x="240" y="380" text-anchor="middle" font-family="sans-serif" font-size="28" fill="#fffc">${label.replace(/[<>&"']/g, "")}</text></svg>`;

export function parseVariant(raw: string): Variant | null {
  return (VARIANTS as readonly string[]).includes(raw) ? (raw as Variant) : null;
}

const asciiName = (s: string) => s.replace(/[^\w.\- ]+/g, "_").slice(-120) || "photo";

/**
 * Serves one variant of an item the viewer was already allowed to see: views redirect to a
 * 5-minute presigned URL (private caching), downloads stream with an attachment header, and the
 * guest download copy is watermarked when the family set a watermark (GAL-10).
 */
export async function serveMedia(item: LoadedMedia, variant: Variant, viewer: Viewer, settings: GallerySettings, placeholderLabel: string): Promise<Response> {
  const file = variantFor(viewer, item, variant, settings);
  if (!file) {
    if (variant === "thumb") {
      return new Response(PLACEHOLDER(item.kind === "video" ? "" : placeholderLabel), {
        // Not cached while the preview is still being made, or the real thumbnail would never show.
        headers: { "Content-Type": "image/svg+xml", "Cache-Control": item.status === "processing" ? "private, no-store" : "private, max-age=300", "X-Content-Type-Options": "nosniff" },
      });
    }
    return new Response("Not found", { status: 404 });
  }
  const store = getStore();
  if (variant === "download") {
    const wm = file.watermark && settings.watermarkText;
    const base = asciiName(item.filename.replace(/\.[^.]+$/, ""));
    if (wm) {
      const bytes = await store.getBytes(file.key);
      if (!bytes) return new Response("Not found", { status: 404 });
      const out = await watermark(bytes, settings.watermarkText!);
      return new Response(new Uint8Array(out), {
        headers: { "Content-Type": "image/jpeg", "Content-Disposition": `attachment; filename="${base}.jpg"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
      });
    }
    const obj = await store.get(file.key);
    if (!obj) return new Response("Not found", { status: 404 });
    const isWeb = file.key.endsWith(".webp");
    const name = isWeb ? `${base}.webp` : asciiName(item.filename);
    return new Response(obj.stream, {
      headers: {
        "Content-Type": isWeb ? "image/webp" : item.mime,
        ...(obj.size != null ? { "Content-Length": String(obj.size) } : {}),
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  const url = await store.presignedGet(file.key, { ttlSeconds: 300 });
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "private, max-age=240", "Referrer-Policy": "no-referrer" } });
}

/**
 * A family on the wedding site (guest-link cookie only): their viewer (invited functions) and the
 * gallery settings. Null for anyone else, so callers answer 404 / "open your link".
 */
export async function guestGallery(slug: string) {
  const ctx = await getSiteContext(slug);
  if (!ctx?.guest) return null;
  const db = getDb();
  const functionIds = await householdFunctionIds(db, ctx.event.id, ctx.guest.household.id);
  const viewer = { kind: "guest" as const, householdId: ctx.guest.household.id, functionIds };
  return { ...ctx, guest: ctx.guest, viewer, settings: await getGallerySettings(db, ctx.event.id) };
}

export function uploaderLabels(t: Translator) {
  return {
    choose: t("gallery.uploader.choose"),
    progress: t("gallery.uploader.progress"),
    failedCount: t("gallery.uploader.failedCount"),
    retry: t("gallery.uploader.retry"),
    cancel: t("gallery.uploader.cancel"),
    waiting: t("gallery.uploader.waiting"),
    uploading: t("gallery.uploader.uploading"),
    done: t("gallery.uploader.done"),
    failed: t("gallery.uploader.failed"),
    preparing: t("gallery.uploader.preparing"),
    finished: t("gallery.uploader.finished"),
    tooLong: t("gallery.uploader.tooLong"),
    refresh: t("gallery.uploader.refresh"),
    badType: t("gallery.errors.bad_type"),
    tooLarge: t("gallery.errors.too_large"),
  };
}

/** The `accept` attribute for a file input. */
export const ACCEPT_ALL = [...PHOTO_TYPES, ...VIDEO_TYPES, ".heic", ".heif", ".mov"].join(",");
export const ACCEPT_GUEST = ["image/*", ...VIDEO_TYPES, ".mov"].join(",");

export function zipResponse(entries: AsyncIterable<ArchiveEntry>, filename: string) {
  return new Response(zipStream(entries), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${asciiName(filename)}.zip"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
