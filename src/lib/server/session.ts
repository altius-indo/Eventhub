import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/db";
import type { User } from "@/db/schema";
import { createTranslator, defaultLocale, isLocale, LOCALE_COOKIE, type Locale } from "@/i18n/core";
import { hasRecentStepUp, SESSION_TTL_MS, validateSessionToken, type SessionRow } from "../auth-core";
import { resolveAppUrl } from "../app-url";

export const SESSION_COOKIE = "eh_session";

const secureCookies = () => process.env.NODE_ENV === "production";

export async function getRequestMeta() {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return { ip: forwarded || h.get("x-real-ip") || null, userAgent: h.get("user-agent") };
}

export type SessionContext = { session: SessionRow; user: User };

/** The signed-in user for this request, or null. Cached per request. */
export const getSessionContext = cache(async (): Promise<SessionContext | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return validateSessionToken(getDb(), token);
});

export async function requireUser(opts: { allowUnnamed?: boolean } = {}): Promise<SessionContext> {
  const ctx = await getSessionContext();
  if (!ctx) redirect("/login");
  if (!opts.allowUnnamed && !ctx.user.name) redirect("/welcome");
  return ctx;
}

export async function requireAppAdmin(): Promise<SessionContext> {
  const ctx = await requireUser();
  if (!ctx.user.isAppAdmin) redirect("/events");
  return ctx;
}

/** Only call from Server Actions or Route Handlers. */
export async function setSessionCookie(token: string) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

/** Short-lived, http-only cookie holding a pending OTP flow. */
export async function setFlowCookie(name: string, value: object) {
  (await cookies()).set(name, JSON.stringify(value), {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: 15 * 60,
  });
}

export async function readFlowCookie<T>(name: string): Promise<T | null> {
  const raw = (await cookies()).get(name)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function clearFlowCookie(name: string) {
  (await cookies()).delete(name);
}

export const getLocale = cache(async (): Promise<Locale> => {
  const ctx = await getSessionContext();
  if (ctx && isLocale(ctx.user.locale)) return ctx.user.locale;
  const fromCookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(fromCookie)) return fromCookie;
  const accept = (await headers()).get("accept-language") ?? "";
  return /^hi\b/i.test(accept) ? "hi" : defaultLocale;
});

export async function getTranslator() {
  const locale = await getLocale();
  return { locale, t: createTranslator(locale) };
}

/**
 * Accepts only same-site relative paths, to avoid open redirects. The default `/` sends signed-in
 * users to their last event (or the events list), see `src/app/page.tsx`.
 */
export function safeNext(next: unknown, fallback = "/"): string {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")
    ? next
    : fallback;
}

/** Sends the user to re-verify with a fresh OTP unless they did so in the last 10 minutes. */
export async function requireStepUp(ctx: SessionContext, returnTo: string) {
  if (!hasRecentStepUp(ctx.session)) redirect(`/step-up?next=${encodeURIComponent(safeNext(returnTo))}`);
}

export function appUrl(): string {
  return resolveAppUrl();
}
