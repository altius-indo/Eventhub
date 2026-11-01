"use server";

import { and, count, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { userIdentifiers, users } from "@/db/schema";
import { acceptPendingInvitations, findUserByIdentifier, revokeAllSessions, revokeSession } from "@/lib/auth-core";
import { maskIdentifier, parseIdentifier } from "@/lib/identifiers";
import { requestOtp, verifyOtp } from "@/lib/otp";
import { requestErrorMessage, verifyErrorMessage } from "@/lib/server/otp-errors";
import { clearFlowCookie, getRequestMeta, getTranslator, readFlowCookie, requireUser, setFlowCookie } from "@/lib/server/session";
import { ADD_ID_FLOW, type AddIdFlow } from "./flow";

type State = { error?: string; info?: string };

export async function saveProfileAction(_prev: State, formData: FormData): Promise<State> {
  const { user } = await requireUser();
  const { t } = await getTranslator();
  const name = String(formData.get("name") ?? "").trim().slice(0, 80);
  if (!name) return { error: t("onboarding.nameLabel") };
  await getDb().update(users).set({ name, updatedAt: new Date() }).where(eq(users.id, user.id));
  revalidatePath("/", "layout");
  return { info: t("common.saved") };
}

export async function startAddIdentifierAction(_prev: State, formData: FormData): Promise<State> {
  const { user } = await requireUser();
  const { t, locale } = await getTranslator();
  const id = parseIdentifier(String(formData.get("identifier") ?? ""));
  if (!id) return { error: t("auth.errors.invalidIdentifier") };
  const db = getDb();
  const owner = await findUserByIdentifier(db, id);
  if (owner) return { error: owner.id === user.id ? t("common.saved") : t("auth.errors.identifierTaken") };
  const res = await requestOtp(db, { purpose: "add_identifier", identifier: id, userId: user.id, ip: (await getRequestMeta()).ip, locale });
  if (!res.ok) return { error: requestErrorMessage(t, res) };
  await setFlowCookie(ADD_ID_FLOW, { c: res.challengeId, id } satisfies AddIdFlow);
  redirect("/account?verify=1");
}

export async function resendAddIdentifierAction(_prev: State): Promise<State> {
  const { user } = await requireUser();
  const { t, locale } = await getTranslator();
  const flow = await readFlowCookie<AddIdFlow>(ADD_ID_FLOW);
  if (!flow) redirect("/account");
  const res = await requestOtp(getDb(), { purpose: "add_identifier", identifier: flow.id, userId: user.id, ip: (await getRequestMeta()).ip, locale });
  if (!res.ok) return { error: requestErrorMessage(t, res) };
  await setFlowCookie(ADD_ID_FLOW, { c: res.challengeId, id: flow.id } satisfies AddIdFlow);
  return { info: t("auth.verify.sentTo", { to: maskIdentifier(flow.id) }) };
}

export async function verifyAddIdentifierAction(_prev: State, formData: FormData): Promise<State> {
  const { user } = await requireUser();
  const { t } = await getTranslator();
  const flow = await readFlowCookie<AddIdFlow>(ADD_ID_FLOW);
  if (!flow) redirect("/account");
  const db = getDb();
  const res = await verifyOtp(db, { challengeId: flow.c, code: String(formData.get("code") ?? ""), purpose: "add_identifier" });
  if (!res.ok) return { error: verifyErrorMessage(t, res) };
  if (res.challenge.userId !== user.id) return { error: t("auth.errors.invalidCode") };
  const inserted = await db
    .insert(userIdentifiers)
    .values({ userId: user.id, type: res.challenge.identifierType, value: res.challenge.identifierValue })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) return { error: t("auth.errors.identifierTaken") };
  await acceptPendingInvitations(db, user.id);
  await clearFlowCookie(ADD_ID_FLOW);
  redirect("/account");
}

export async function removeIdentifierAction(_prev: State, formData: FormData): Promise<State> {
  const { user } = await requireUser();
  const { t } = await getTranslator();
  const db = getDb();
  const [{ n }] = await db.select({ n: count() }).from(userIdentifiers).where(eq(userIdentifiers.userId, user.id));
  if (n <= 1) return { error: t("account.cannotRemoveLast") };
  await db
    .delete(userIdentifiers)
    .where(and(eq(userIdentifiers.id, String(formData.get("identifierId"))), eq(userIdentifiers.userId, user.id)));
  revalidatePath("/account");
  return {};
}

export async function revokeSessionAction(formData: FormData) {
  const { user } = await requireUser();
  await revokeSession(getDb(), user.id, String(formData.get("sessionId")));
  revalidatePath("/account");
}

export async function signOutOthersAction() {
  const { user, session } = await requireUser();
  await revokeAllSessions(getDb(), user.id, session.id);
  revalidatePath("/account");
}
