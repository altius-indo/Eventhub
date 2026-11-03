import { cookies } from "next/headers";
import { getDb } from "@/db";
import { getMembership } from "@/lib/events";
import { resolveGuestToken } from "@/lib/guest-links";
import { getSessionContext } from "@/lib/server/session";
import { guestCookieName, siteCookieName } from "@/lib/server/site-context";
import { contentImageIds, getSiteImage, getWebsite, passcodeCookieValue } from "@/lib/website";
import { safeEqual } from "@/lib/crypto";

/**
 * Website images. Images on a published, non-passcode site are public and
 * cacheable; anything else needs a team member, the family's guest link, or the passcode.
 */
export async function GET(_req: Request, { params }: RouteContext<"/site-images/[id]">) {
  const { id } = await params;
  const db = getDb();
  const img = await getSiteImage(db, id);
  if (!img) return new Response("Not found", { status: 404 });
  const site = await getWebsite(db, img.eventId);
  const publiclyUsed = !!site?.published && contentImageIds(site.published).has(id);

  let allowed = publiclyUsed && site!.visibility !== "passcode";
  let cacheable = allowed;
  if (!allowed) {
    const jar = await cookies();
    const session = await getSessionContext();
    const member = !!session && (session.user.isAppAdmin || !!(await getMembership(db, img.eventId, session.user.id)));
    const token = jar.get(guestCookieName(img.eventId))?.value;
    const guest = !!token && (await resolveGuestToken(db, token))?.event.id === img.eventId;
    const unlocked = !!site && (jar.get(siteCookieName(site.id))?.value ?? "") !== "" && safeEqual(jar.get(siteCookieName(site.id))!.value, passcodeCookieValue(site));
    allowed = member || ((guest || unlocked) && publiclyUsed) || (guest && !!site && contentImageIds(site.draft).has(id) && !site.published);
    cacheable = false;
  }
  if (!allowed) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(img.data), {
    headers: {
      "Content-Type": img.mime,
      "Content-Length": String(img.bytes),
      "Cache-Control": cacheable ? "public, max-age=31536000, immutable" : "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
