import { getDb } from "@/db";
import { createTranslator, isLocale } from "@/i18n/core";
import type { ArchiveEntry } from "@/lib/archive";
import { splitParts, zipItems, zipPath } from "@/lib/gallery";
import { isUuid } from "@/lib/ids";
import { guestGallery, zipResponse } from "@/lib/server/gallery";
import { getStore } from "@/lib/storage";
import { allowAttempt } from "@/lib/website";

export const maxDuration = 300;

/**
 * A family's ZIP of one function's photos (GAL-06), only when the family allowed guest originals.
 * `?fn=<id>&part=<n>`; rate-limited per family (5 a day).
 */
export async function GET(req: Request, { params }: RouteContext<"/[slug]/gallery/download">) {
  const { slug } = await params;
  const g = await guestGallery(slug);
  const q = new URL(req.url).searchParams;
  const fn = q.get("fn") ?? "";
  if (!g || !g.settings.guestOriginals || !isUuid(fn) || !g.viewer.functionIds.includes(fn)) return new Response("Not found", { status: 404 });
  const db = getDb();
  const n = Number(q.get("part") ?? "1");
  const parts = splitParts(await zipItems(db, g.event.id, { functionId: fn, guest: g.viewer }));
  if (!Number.isInteger(n) || n < 1 || n > parts.length) return new Response("Not found", { status: 404 });
  if (n === 1 && !(await allowAttempt(db, "gallery-zip-guest", g.guest.household.id, 5, 24 * 3600_000))) return new Response("Too many requests", { status: 429 });
  const t = createTranslator(isLocale(g.guest.household.locale) ? g.guest.household.locale : "en");
  const store = getStore();
  async function* entries(): AsyncIterable<ArchiveEntry> {
    for (const it of parts[n - 1]) yield { path: zipPath(it, (k) => t(`gallery.albumKinds.${k}`)), data: async () => (await store.get(it.originalKey))?.stream ?? null, mtime: it.takenAt };
  }
  return zipResponse(entries(), `photos-${n}`);
}
