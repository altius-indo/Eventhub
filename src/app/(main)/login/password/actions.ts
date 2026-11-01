"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { createSession } from "@/lib/auth-core";
import { loginWithPassword, PasswordError, requestPasswordReset, resetPassword } from "@/lib/passwords";
import { appUrl, getRequestMeta, getTranslator, safeNext, setSessionCookie } from "@/lib/server/session";

type State = { error?: string; info?: string };

/** App Admin password login (ADR-0022). Same message whether the account exists or not. */
export async function passwordLoginAction(_prev: State, fd: FormData): Promise<State> {
  const { t } = await getTranslator();
  const meta = await getRequestMeta();
  const db = getDb();
  const res = await loginWithPassword(db, { email: String(fd.get("email") ?? ""), password: String(fd.get("password") ?? ""), ip: meta.ip });
  if (!res.ok) {
    if (res.error === "suspended") return { error: t("password.suspended") };
    return { error: res.error === "invalid" ? t("password.invalid") : t("password.locked") };
  }
  const { token } = await createSession(db, res.user.id, meta);
  await setSessionCookie(token);
  const next = safeNext(fd.get("next"));
  redirect(res.user.name ? next : `/welcome?next=${encodeURIComponent(next)}`);
}

export async function requestResetAction(_prev: State, fd: FormData): Promise<State> {
  const { t, locale } = await getTranslator();
  const email = String(fd.get("email") ?? "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: t("password.invalidEmail") };
  try {
    await requestPasswordReset(getDb(), { email, appUrl: appUrl(), ip: (await getRequestMeta()).ip, locale });
  } catch (e) {
    if (e instanceof PasswordError) return { error: t("password.locked") };
    throw e;
  }
  return { info: t("password.resetSent") };
}

export async function resetPasswordAction(token: string, _prev: State, fd: FormData): Promise<State> {
  const { t } = await getTranslator();
  const pw = String(fd.get("password") ?? "");
  if (pw !== String(fd.get("confirm") ?? "")) return { error: t("password.mismatch") };
  try {
    await resetPassword(getDb(), { token, newPassword: pw });
  } catch (e) {
    if (e instanceof PasswordError) return { error: e.code === "weak" ? t("password.weak") : t("password.linkInvalid") };
    throw e;
  }
  redirect("/login/password?reset=1");
}
