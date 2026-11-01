"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userIdentifiers } from "@/db/schema";
import { hasRecentStepUp } from "@/lib/auth-core";
import { requestOtp, verifyOtp } from "@/lib/otp";
import { PasswordError, removePassword, setPassword, setRecoveryEmail } from "@/lib/passwords";
import { requestErrorMessage, verifyErrorMessage } from "@/lib/server/otp-errors";
import { clearFlowCookie, getRequestMeta, getTranslator, readFlowCookie, requireAppAdmin, setFlowCookie } from "@/lib/server/session";
import { RECOVERY_FLOW, type RecoveryFlow } from "./flow";

type State = { error?: string; info?: string };

/** App Admins only (ADR-0022). Setting the first password needs a fresh code (step-up). */
export async function setPasswordAction(_prev: State, fd: FormData): Promise<State> {
  const ctx = await requireAppAdmin();
  const { t } = await getTranslator();
  if (!ctx.user.passwordHash && !hasRecentStepUp(ctx.session)) redirect(`/step-up?next=${encodeURIComponent("/account")}`);
  const pw = String(fd.get("password") ?? "");
  if (pw !== String(fd.get("confirm") ?? "")) return { error: t("password.mismatch") };
  const [login] = await getDb().select().from(userIdentifiers).where(eq(userIdentifiers.userId, ctx.user.id));
  try {
    await setPassword(getDb(), { user: ctx.user, newPassword: pw, currentPassword: String(fd.get("current") ?? ""), keepSessionId: ctx.session.id, email: login?.value });
  } catch (e) {
    if (e instanceof PasswordError) return { error: e.code === "wrong_current" ? t("password.wrongCurrent") : t("password.weak") };
    throw e;
  }
  revalidatePath("/account");
  return { info: t("password.changed") };
}

export async function removePasswordAction(_prev: State): Promise<State> {
  const ctx = await requireAppAdmin();
  const { t } = await getTranslator();
  if (!hasRecentStepUp(ctx.session)) redirect(`/step-up?next=${encodeURIComponent("/account")}`);
  await removePassword(getDb(), ctx.user);
  revalidatePath("/account");
  return { info: t("password.removed") };
}

export async function sendRecoveryCodeAction(_prev: State, fd: FormData): Promise<State> {
  const ctx = await requireAppAdmin();
  const { t, locale } = await getTranslator();
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) return { error: t("password.invalidEmail") };
  const res = await requestOtp(getDb(), { purpose: "recovery_email", identifier: { type: "email", value: email }, userId: ctx.user.id, ip: (await getRequestMeta()).ip, locale });
  if (!res.ok) return { error: requestErrorMessage(t, res) };
  await setFlowCookie(RECOVERY_FLOW, { c: res.challengeId, email } satisfies RecoveryFlow);
  redirect("/account?recovery=1");
}

export async function verifyRecoveryCodeAction(_prev: State, fd: FormData): Promise<State> {
  const ctx = await requireAppAdmin();
  const { t } = await getTranslator();
  const flow = await readFlowCookie<RecoveryFlow>(RECOVERY_FLOW);
  if (!flow) redirect("/account");
  const db = getDb();
  const res = await verifyOtp(db, { challengeId: flow.c, code: String(fd.get("code") ?? ""), purpose: "recovery_email" });
  if (!res.ok) return { error: verifyErrorMessage(t, res) };
  if (res.challenge.userId !== ctx.user.id || res.challenge.identifierValue !== flow.email) return { error: t("auth.errors.invalidCode") };
  await setRecoveryEmail(db, ctx.user, flow.email);
  await clearFlowCookie(RECOVERY_FLOW);
  revalidatePath("/account");
  redirect("/account?recoverySaved=1");
}

export async function removeRecoveryEmailAction(_prev: State): Promise<State> {
  const ctx = await requireAppAdmin();
  const { t } = await getTranslator();
  await setRecoveryEmail(getDb(), ctx.user, null);
  revalidatePath("/account");
  return { info: t("common.saved") };
}
