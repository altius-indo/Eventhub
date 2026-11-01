import { redirect } from "next/navigation";
import { getDb } from "@/db";
import type { ArchiveEntry } from "@/lib/archive";
import { allowFullDownload, getAlbum, GalleryError, splitParts, zipItems, zipPath, type ZipItem } from "@/lib/gallery";
import { isUuid } from "@/lib/ids";
import { getEventContext } from "@/lib/server/event-context";
import { zipResponse } from "@/lib/server/gallery";
import { getTranslator } from "@/lib/server/session";
import { getStore } from "@/lib/storage";

/** Streams for a while; each part stays under ~2 GB (GAL-06). */
export const maxDuration = 300;

/**
 * Family ZIP downloads of originals (GAL-06): `?album=<id>` for one album, or `?part=<n>` for
 * part n of everything. Full downloads count once (on part 1) against 5 per event per day.
 */
export async function GET(req: Request, { params }: RouteContext<"/events/[eventId]/gallery/download">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gallery.view")) return new Response("Not found", { status: 404 });
  const { t } = await getTranslator();
  const db = getDb();
  const q = new URL(req.url).searchParams;
  const albumId = q.get("album");
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
    items = await zipItems(db, eventId, { albumId });
  } else {
    const n = Number(q.get("part") ?? "1");
    const parts = splitParts(await zipItems(db, eventId));
    if (!Number.isInteger(n) || n < 1 || n > parts.length) return new Response("Not found", { status: 404 });
    if (n === 1 && !(await allowFullDownload(db, eventId))) redirect(`/events/${eventId}/gallery?limit=1`);
    items = parts[n - 1];
    name = `${ctx.event.name}-gallery-${n}`;
  }
  const store = getStore();
  async function* entries(): AsyncIterable<ArchiveEntry> {
    for (const it of items) {
      yield { path: zipPath(it, (k) => t(`gallery.albumKinds.${k}`)), data: async () => (await store.get(it.originalKey))?.stream ?? null, mtime: it.takenAt };
    }
  }
  return zipResponse(entries(), name);
}
