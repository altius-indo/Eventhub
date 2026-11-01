import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { resolveGuestToken } from "@/lib/guest-links";
import { appUrl } from "@/lib/server/session";
import { GUEST_COOKIE_MAX_AGE, guestCookieName } from "@/lib/server/site-context";
import { getOrCreateWebsite } from "@/lib/website";

/** Guest link: remembers the family on this device, then opens their personalised page. */
export async function GET(_req: Request, { params }: RouteContext<"/g/[token]">) {
  const { token } = await params;
  const db = getDb();
  const resolved = await resolveGuestToken(db, token);
  if (!resolved) return NextResponse.redirect(`${appUrl()}/g`, 303);
  const site = await getOrCreateWebsite(db, resolved.event);
  const res = NextResponse.redirect(`${appUrl()}/${site.slug}`, 303);
  res.cookies.set(guestCookieName(resolved.event.id), token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: GUEST_COOKIE_MAX_AGE,
  });
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}
