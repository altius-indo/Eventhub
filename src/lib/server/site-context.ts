import "server-only";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { getDb } from "@/db";
import { isLocale, LOCALE_COOKIE, type Locale } from "@/i18n/core";
import { getMembership } from "../events";
import { resolveGuestToken } from "../guest-links";
import { getSiteBySlug, passcodeCookieValue } from "../website";
import { safeEqual } from "../crypto";
import { getSessionContext } from "./session";

export const guestCookieName = (eventId: string) => `eh_g_${eventId.replace(/-/g, "")}`;
export const siteCookieName = (websiteId: string) => `eh_s_${websiteId.replace(/-/g, "")}`;
export const GUEST_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

/**
 * Everything a wedding-site request needs: the site, the event, whether the
 * visitor is a signed-in team member, a guest (via their link cookie), and
 * whether they've entered the passcode.
 */
export const getSiteContext = cache(async (slug: string) => {
  const db = getDb();
  const row = await getSiteBySlug(db, slug);
  if (!row) return null;
  const { website, event } = row;
  const jar = await cookies();

  const session = await getSessionContext();
  const isMember = !!session && (session.user.isAppAdmin || !!(await getMembership(db, event.id, session.user.id)));

  const guestToken = jar.get(guestCookieName(event.id))?.value;
  const resolved = guestToken ? await resolveGuestToken(db, guestToken) : null;
  const guest = resolved && resolved.event.id === event.id ? { household: resolved.household, token: guestToken! } : null;

  const unlockedCookie = jar.get(siteCookieName(website.id))?.value;
  const unlocked = website.visibility !== "passcode" || (!!unlockedCookie && safeEqual(unlockedCookie, passcodeCookieValue(website)));

  return { website, event, isMember, guest, unlocked };
});

/** ?lang=, then the site language cookie, then the family's language, then the browser. */
export async function siteLocale(lang: unknown, familyLocale?: string): Promise<Locale> {
  if (isLocale(lang)) return lang;
  const fromCookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(fromCookie)) return fromCookie;
  if (isLocale(familyLocale)) return familyLocale;
  return /^hi\b/i.test((await headers()).get("accept-language") ?? "") ? "hi" : "en";
}
