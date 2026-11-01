import { redirect } from "next/navigation";
import { getDb } from "@/db";
import type { ArchiveEntry } from "@/lib/archive";
import { allowFullDownload, getAlbum, GalleryError, splitParts, zipItems, zipPath, type ZipItem } from "@/lib/gallery";
import { isUuid } from "@/lib/ids";
import { getEventContext } from "@/lib/server/event-context";
import { zipData, zipResponse } from "@/lib/server/gallery";
import { getTranslator } from "@/lib/server/session";

/** Streams for a while; parts are sized (400 MB / 500 files) to finish well inside this (ADR-0031). */
export const maxDuration = 300;

/**
 * Family ZIP downloads of originals (GAL-06): `?album=<id>` for one album (split the same way,
 * `&part=<n>`), or `?part=<n>` for part n of everything. Every part of a full download counts
 * when it starts (5 per event, per part, per day, §4.1).
 */
export async function GET(req: Request, { params }: RouteContext<"/events/[eventId]/gallery/download">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gallery.view")) return new Response("Not found", { status: 404 });
  const { t } = await getTranslator();
  const db = getDb();
  const q = new URL(req.url).searchParams;
  const albumId = q.get("album");
  const n = Number(q.get("part") ?? "1");
  if (!Number.isInteger(n) || n < 1) return new Response("Not found", { status: 404 });
  let items: ZipItem[];
  let name: string;
  if (albumId) {
    if (!isUuid(albumId)) return new Response("Not found", { status: 404 });
    try {
      const album = await getAlbum(db, eventId, albumId);
      name = `${ctx.event.name}-${album.title || t(`gallery.albumKinds.${album.kind}`)}`;
    } catch (e) {
      if (e instanceof GalleryError) return new Response("Not found", { status: 404 });
      throw e;
    }
    const parts = splitParts(await zipItems(db, eventId, { albumId }));
    if (n > Math.max(1, parts.length)) return new Response("Not found", { status: 404 });
    items = parts[n - 1] ?? [];
    if (parts.length > 1) name = `${name}-${n}`;
  } else {
    const parts = splitParts(await zipItems(db, eventId));
    if (n > parts.length) return new Response("Not found", { status: 404 });
    if (!(await allowFullDownload(db, eventId, n))) redirect(`/events/${eventId}/gallery?limit=1`);
    items = parts[n - 1];
    name = `${ctx.event.name}-gallery-${n}`;
  }
  const tz = ctx.event.timezone;
  async function* entries(): AsyncIterable<ArchiveEntry> {
    for (const it of items) {
      yield { path: zipPath(it, (k) => t(`gallery.albumKinds.${k}`), tz), data: zipData(it.originalKey, false), mtime: it.takenAt };
    }
  }
  return zipResponse(entries(), name);
}
