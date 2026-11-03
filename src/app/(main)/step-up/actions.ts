"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { userIdentifiers } from "@/db/schema";
import { markStepUp } from "@/lib/auth-core";
import { verifyPasswordStepUp } from "@/lib/passwords";
import { maskIdentifier } from "@/lib/identifiers";
import { requestOtp, verifyOtp } from "@/lib/otp";
import { requestErrorMessage, verifyErrorMessage } from "@/lib/server/otp-errors";
import {
  clearFlowCookie,
  getRequestMeta,
  getTranslator,
  readFlowCookie,
  requireUser,
  safeNext,
  setFlowCookie,
} from "@/lib/server/session";

import { STEP_UP_FLOW, type StepUpFlow } from "./flow";
type State = { error?: string; info?: string };

async function send(userId: string, identifierId: string, next: string): Promise<State> {
  const { t, locale } = await getTranslator();
  const [identifier] = await getDb()
    .select()
    .from(userIdentifiers)
    .where(and(eq(userIdentifiers.id, identifierId), eq(userIdentifiers.userId, userId)));
  if (!identifier) return { error: t("common.somethingWrong") };
  const res = await requestOtp(getDb(), {
    purpose: "step_up",
    identifier: { type: identifier.type, value: identifier.value },
    userId,
    ip: (await getRequestMeta()).ip,
    locale,
  });
  if (!res.ok) return { error: requestErrorMessage(t, res) };
  await setFlowCookie(STEP_UP_FLOW, { c: res.challengeId, identifierId, next } satisfies StepUpFlow);
  return { info: t("auth.verify.sentTo", { to: maskIdentifier(identifier) }) };
}

export async function sendStepUpCodeAction(_prev: State, formData: FormData): Promise<State> {
  const { user } = await requireUser();
  const result = await send(user.id, String(formData.get("identifierId")), safeNext(formData.get("next")));
  if (result.error) return result;
  redirect("/step-up?sent=1");
}

export async function resendStepUpCodeAction(_prev: State): Promise<State> {
  const { user } = await requireUser();
  const flow = await readFlowCookie<StepUpFlow>(STEP_UP_FLOW);
  if (!flow) redirect("/step-up");
  return send(user.id, flow.identifierId, flow.next);
}

export async function verifyStepUpCodeAction(_prev: State, formData: FormData): Promise<State> {
  const ctx = await requireUser();
  const { t } = await getTranslator();
  const flow = await readFlowCookie<StepUpFlow>(STEP_UP_FLOW);
  if (!flow) redirect("/step-up");
  const db = getDb();
  const res = await verifyOtp(db, { challengeId: flow.c, code: String(formData.get("code") ?? ""), purpose: "step_up" });
  if (!res.ok) return { error: verifyErrorMessage(t, res) };
  if (res.challenge.userId !== ctx.user.id) return { error: t("auth.errors.invalidCode") };
  await markStepUp(db, ctx.session.id);
  await clearFlowCookie(STEP_UP_FLOW);
  redirect(safeNext(flow.next));
}


/** App Admins with a password may confirm with it instead of a code (ADR-0022). */
export async function stepUpWithPasswordAction(_prev: State, formData: FormData): Promise<State> {
  const ctx = await requireUser();
  const { t } = await getTranslator();
  const db = getDb();
  const res = await verifyPasswordStepUp(db, ctx.user, String(formData.get("password") ?? ""));
  if (res !== "ok") return { error: res === "locked" ? t("password.locked") : t("password.wrongCurrent") };
  await markStepUp(db, ctx.session.id);
  redirect(safeNext(formData.get("next")));
}
