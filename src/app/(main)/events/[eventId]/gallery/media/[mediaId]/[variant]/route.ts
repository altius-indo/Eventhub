import { getDb } from "@/db";
import { getGallerySettings, loadMediaForViewer } from "@/lib/gallery";
import { getEventContext } from "@/lib/server/event-context";
import { parseVariant, serveMedia } from "@/lib/server/gallery";
import { getTranslator } from "@/lib/server/session";

/** A thumbnail, web copy, original or download for the team (GAL-06). */
export async function GET(_req: Request, { params }: RouteContext<"/events/[eventId]/gallery/media/[mediaId]/[variant]">) {
  const { eventId, mediaId, variant: raw } = await params;
  const ctx = await getEventContext(eventId);
  const variant = parseVariant(raw);
  if (!ctx.can("gallery.view") || !variant) return new Response("Not found", { status: 404 });
  const db = getDb();
  const item = await loadMediaForViewer(db, eventId, mediaId, { kind: "member" });
  if (!item) return new Response("Not found", { status: 404 });
  const { t } = await getTranslator();
  return serveMedia(item, variant, { kind: "member" }, await getGallerySettings(db, eventId), t("gallery.item.noPreview"));
}
