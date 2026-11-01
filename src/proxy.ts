import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "eh_session";
/** App areas that need a signed-in team member. Everything else (login, wedding sites, guest links) is public. */
const PROTECTED_PREFIXES = ["/events", "/account", "/admin", "/welcome", "/step-up", "/vendor", "/notifications"];
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

/**
 * Optimistic gate: sends visitors without a session cookie to /login. The real
 * session check happens on the server for every page and action. Also renews
 * the cookie's lifetime so active users stay signed in (sliding 30 days).
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const isProtected = pathname === "/" || PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (!token && isProtected) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  const response = NextResponse.next();
  if (token && request.method === "GET" && isProtected) {
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE,
    });
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icons/|manifest.webmanifest|sw.js|robots.txt|site-images/|api/dev-blob/).*)"],
};
