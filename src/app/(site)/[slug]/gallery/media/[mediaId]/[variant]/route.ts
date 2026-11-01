import { getDb } from "@/db";
import { createTranslator } from "@/i18n/core";
import { loadMediaForViewer } from "@/lib/gallery";
import { guestGallery, parseVariant, serveMedia } from "@/lib/server/gallery";

/** A family's view of one item: same rules as the gallery page (GAL-05/06/10). */
export async function GET(_req: Request, { params }: RouteContext<"/[slug]/gallery/media/[mediaId]/[variant]">) {
  const { slug, mediaId, variant: raw } = await params;
  const g = await guestGallery(slug);
  const variant = parseVariant(raw);
  if (!g || !variant) return new Response("Not found", { status: 404 });
  const item = await loadMediaForViewer(getDb(), g.event.id, mediaId, g.viewer);
  if (!item) return new Response("Not found", { status: 404 });
  return serveMedia(item, variant, g.viewer, g.settings, createTranslator("en")("gallery.item.noPreview"));
}
