"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { AccountSuspendedError, createSession, signInWithIdentifier } from "@/lib/auth-core";
import { maskIdentifier, parseIdentifier, type Identifier } from "@/lib/identifiers";
import { requestOtp, verifyOtp } from "@/lib/otp";
import { requestErrorMessage, verifyErrorMessage } from "@/lib/server/otp-errors";
import {
  clearFlowCookie,
  getRequestMeta,
  getTranslator,
  readFlowCookie,
  safeNext,
  setFlowCookie,
  setSessionCookie,
} from "@/lib/server/session";

export type FormState = { error?: string; info?: string };

import { LOGIN_FLOW, type LoginFlow } from "./flow";

async function sendCode(identifier: Identifier, channel: "sms" | "whatsapp", next: string): Promise<FormState | null> {
  const { t, locale } = await getTranslator();
  const meta = await getRequestMeta();
  const res = await requestOtp(getDb(), { purpose: "login", identifier, phoneChannel: channel, ip: meta.ip, locale });
  if (!res.ok) return { error: requestErrorMessage(t, res) };
  await setFlowCookie(LOGIN_FLOW, { c: res.challengeId, id: identifier, ch: channel, next } satisfies LoginFlow);
  return null;
}

export async function requestLoginCodeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { t } = await getTranslator();
  const identifier = parseIdentifier(String(formData.get("identifier") ?? ""));
  if (!identifier) return { error: t("auth.errors.invalidIdentifier") };
  const channel = formData.get("channel") === "whatsapp" ? "whatsapp" : "sms";
  const failed = await sendCode(identifier, channel, safeNext(formData.get("next")));
  if (failed) return failed;
  redirect("/login/verify");
}

export async function resendLoginCodeAction(_prev: FormState): Promise<FormState> {
  const { t } = await getTranslator();
  const flow = await readFlowCookie<LoginFlow>(LOGIN_FLOW);
  if (!flow) redirect("/login");
  return (await sendCode(flow.id, flow.ch, flow.next)) ?? { info: t("auth.verify.sentTo", { to: maskIdentifier(flow.id) }) };
}

export async function verifyLoginCodeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { t, locale } = await getTranslator();
  const flow = await readFlowCookie<LoginFlow>(LOGIN_FLOW);
  if (!flow) redirect("/login");

  const db = getDb();
  const res = await verifyOtp(db, { challengeId: flow.c, code: String(formData.get("code") ?? ""), purpose: "login" });
  if (!res.ok) return { error: verifyErrorMessage(t, res) };

  let user;
  try {
    ({ user } = await db.transaction((tx) =>
      signInWithIdentifier(tx, { type: res.challenge.identifierType, value: res.challenge.identifierValue }, { locale }),
    ));
  } catch (err) {
    if (err instanceof AccountSuspendedError) return { error: t("auth.errors.suspended") };
    throw err;
  }
  const { token } = await createSession(db, user.id, await getRequestMeta());
  await setSessionCookie(token);
  await clearFlowCookie(LOGIN_FLOW);
  redirect(user.name ? flow.next : `/welcome?next=${encodeURIComponent(flow.next)}`);
}
