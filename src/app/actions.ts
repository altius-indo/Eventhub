"use server";

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { isLocale, LOCALE_COOKIE } from "@/i18n/core";
import { revokeSession } from "@/lib/auth-core";
import { clearSessionCookie, getSessionContext, safeNext } from "@/lib/server/session";

export async function setLocaleAction(formData: FormData) {
  const locale = formData.get("locale");
  if (!isLocale(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, { path: "/", maxAge: 365 * 24 * 60 * 60, sameSite: "lax" });
  const ctx = await getSessionContext();
  if (ctx) await getDb().update(users).set({ locale, updatedAt: new Date() }).where(eq(users.id, ctx.user.id));
  redirect(safeNext(formData.get("returnTo"), "/"));
}

export async function signOutAction() {
  const ctx = await getSessionContext();
  if (ctx) await revokeSession(getDb(), ctx.user.id, ctx.session.id);
  await clearSessionCookie();
  redirect("/login");
}
