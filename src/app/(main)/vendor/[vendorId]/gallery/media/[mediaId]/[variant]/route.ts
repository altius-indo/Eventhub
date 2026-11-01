import { getDb } from "@/db";
import { getGallerySettings, loadMediaForViewer } from "@/lib/gallery";
import { parseVariant, serveMedia } from "@/lib/server/gallery";
import { getTranslator } from "@/lib/server/session";
import { getVendorContext } from "@/lib/server/vendor-context";

/** A vendor's own deliveries, and items in album selections shared with them (GAL-05/07). */
export async function GET(_req: Request, { params }: RouteContext<"/vendor/[vendorId]/gallery/media/[mediaId]/[variant]">) {
  const { vendorId, mediaId, variant: raw } = await params;
  const ctx = await getVendorContext(vendorId);
  const variant = parseVariant(raw);
  if (!(ctx.can("portal.gallery") || ctx.viaAdmin) || !variant) return new Response("Not found", { status: 404 });
  const db = getDb();
  const viewer = { kind: "vendor" as const, vendorId };
  const item = await loadMediaForViewer(db, ctx.event.id, mediaId, viewer);
  if (!item) return new Response("Not found", { status: 404 });
  const { t } = await getTranslator();
  return serveMedia(item, variant, viewer, await getGallerySettings(db, ctx.event.id), t("gallery.item.noPreview"));
}
