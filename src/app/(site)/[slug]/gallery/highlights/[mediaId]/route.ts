import { getDb } from "@/db";
import { highlightWebKey } from "@/lib/gallery";
import { isUuid } from "@/lib/ids";
import { getSiteContext } from "@/lib/server/site-context";
import { getStore } from "@/lib/storage";

/**
 * Website highlights (GAL-05): the web copy of a photo the family picked, only while the site is
 * published with the gallery section's highlights switched on, and only while the photo is still
 * in a released album of a public function (S5). Cached publicly for at most 5 minutes on a
 * non-passcode site (S7), so un-highlighting, withdrawing or unpublishing takes effect quickly;
 * on a passcode site only for visitors who unlocked it, invited families and the team, privately.
 */
export async function GET(_req: Request, { params }: RouteContext<"/[slug]/gallery/highlights/[mediaId]">) {
  const { slug, mediaId } = await params;
  const ctx = await getSiteContext(slug);
  if (!ctx || !isUuid(mediaId)) return new Response("Not found", { status: 404 });
  const published = ctx.website.published;
  const on = !!published && published.sections.gallery.visible && !!published.sections.gallery.highlights;
  // The team also sees them in the draft preview, before publishing.
  if (!ctx.isMember && !(on && (ctx.unlocked || ctx.guest))) return new Response("Not found", { status: 404 });
  const webKey = await highlightWebKey(getDb(), ctx.event.id, mediaId);
  if (!webKey) return new Response("Not found", { status: 404 });
  const obj = await getStore().get(webKey);
  if (!obj) return new Response("Not found", { status: 404 });
  const isPublic = on && ctx.website.visibility !== "passcode";
  return new Response(obj.stream, {
    headers: {
      "Content-Type": "image/webp",
      ...(obj.size != null ? { "Content-Length": String(obj.size) } : {}),
      "Cache-Control": isPublic ? "public, max-age=60, s-maxage=300" : "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
