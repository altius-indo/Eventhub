import { getDb } from "@/db";
import { createTranslator, isLocale } from "@/i18n/core";
import type { ArchiveEntry } from "@/lib/archive";
import { allowGuestZipPart, guestZipParts, zipPath } from "@/lib/gallery";
import { isUuid } from "@/lib/ids";
import { guestGallery, zipData, zipResponse } from "@/lib/server/gallery";

export const maxDuration = 300;

/**
 * A family's ZIP of one function's photos (GAL-06), only when the family allowed guest originals
 * and set no watermark. `?fn=<id>&part=<n>`. Every part counts: per family a day, and per event
 * and part with the same 5-a-day cap as full downloads (§4.1, S3). Other families' photos come
 * without location/camera metadata and under id-based names (S2, S6).
 */
export async function GET(req: Request, { params }: RouteContext<"/[slug]/gallery/download">) {
  const { slug } = await params;
  const g = await guestGallery(slug);
  const q = new URL(req.url).searchParams;
  const fn = q.get("fn") ?? "";
  if (!g || !g.settings.guestOriginals || g.settings.watermarkText || !isUuid(fn) || !g.viewer.functionIds.includes(fn)) return new Response("Not found", { status: 404 });
  const db = getDb();
  const n = Number(q.get("part") ?? "1");
  const householdId = g.guest.household.id;
  const parts = await guestZipParts(db, g.event.id, g.viewer, fn);
  if (!Number.isInteger(n) || n < 1 || n > parts.length) return new Response("Not found", { status: 404 });
  const t = createTranslator(isLocale(g.guest.household.locale) ? g.guest.household.locale : "en");
  if (!(await allowGuestZipPart(db, { eventId: g.event.id, householdId, functionId: fn, part: n }))) {
    return new Response(t("gallery.site.zipLimit"), { status: 429, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" } });
  }
  const tz = g.event.timezone;
  async function* entries(): AsyncIterable<ArchiveEntry> {
    for (const { it, file } of parts[n - 1]) {
      yield { path: zipPath(it, (k) => t(`gallery.albumKinds.${k}`), tz, { mime: file.mime, forHousehold: householdId }), data: zipData(file.key, file.strip), mtime: it.takenAt };
    }
  }
  return zipResponse(entries(), `photos-${n}`);
}
