import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/db";
import { mediaItems } from "@/db/schema";
import { isUuid } from "@/lib/ids";
import { getSiteContext } from "@/lib/server/site-context";
import { getStore } from "@/lib/storage";

/**
 * Website highlights (GAL-05): the web copy of a photo the family picked, only while the site is
 * published with the gallery section's highlights switched on. Public and cacheable on a
 * non-passcode site (same rule as site images, ADR-0009); on a passcode site only for visitors
 * who unlocked it, invited families and the team, privately cached.
 */
export async function GET(_req: Request, { params }: RouteContext<"/[slug]/gallery/highlights/[mediaId]">) {
  const { slug, mediaId } = await params;
  const ctx = await getSiteContext(slug);
  if (!ctx || !isUuid(mediaId)) return new Response("Not found", { status: 404 });
  const published = ctx.website.published;
  const on = !!published && published.sections.gallery.visible && !!published.sections.gallery.highlights;
  // The team also sees them in the draft preview, before publishing.
  if (!ctx.isMember && !(on && (ctx.unlocked || ctx.guest))) return new Response("Not found", { status: 404 });
  const [item] = await getDb()
    .select({ webKey: mediaItems.webKey })
    .from(mediaItems)
    .where(and(eq(mediaItems.id, mediaId), eq(mediaItems.eventId, ctx.event.id), eq(mediaItems.highlight, true), eq(mediaItems.status, "approved"), isNotNull(mediaItems.webKey)));
  if (!item?.webKey) return new Response("Not found", { status: 404 });
  const obj = await getStore().get(item.webKey);
  if (!obj) return new Response("Not found", { status: 404 });
  const isPublic = on && ctx.website.visibility !== "passcode";
  return new Response(obj.stream, {
    headers: {
      "Content-Type": "image/webp",
      ...(obj.size != null ? { "Content-Length": String(obj.size) } : {}),
      // Short public caching: un-highlighting or unpublishing should take effect within the hour.
      "Cache-Control": isPublic ? "public, max-age=3600" : "private, max-age=600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
