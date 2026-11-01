"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { createTranslator, locales } from "@/i18n/core";
import { isUuid } from "@/lib/ids";
import { drainSoon } from "@/lib/server/drain";
import { getEventContext } from "@/lib/server/event-context";
import { dctx } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { deleteTemplate, draftMany, listTracker, saveDraft, saveTemplate, sendThankYous, setStatus } from "@/lib/thank-yous";
import { giftErrorText } from "../shared";

type State = { error?: string; info?: string };
const path = (eventId: string) => `/events/${eventId}/gifts/thank-yous`;

async function guard(eventId: string) {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  return { ctx, t, ok: ctx.can("gifts.manage") };
}

export async function saveTemplateAction(eventId: string, templateId: string | null, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await guard(eventId);
  if (!ok || (templateId !== null && !isUuid(templateId))) return { error: t("common.notAllowed") };
  try {
    await saveTemplate(getDb(), dctx(ctx), templateId, { locale: String(fd.get("locale") ?? "en"), name: String(fd.get("name") ?? ""), body: String(fd.get("body") ?? "") });
  } catch (e) {
    return { error: giftErrorText(t, e) };
  }
  revalidatePath(`${path(eventId)}/templates`);
  return { info: t("common.saved") };
}

export async function deleteTemplateAction(eventId: string, templateId: string) {
  const { ctx, ok } = await guard(eventId);
  if (!ok || !isUuid(templateId)) return;
  await deleteTemplate(getDb(), dctx(ctx), templateId).catch(() => undefined);
  revalidatePath(`${path(eventId)}/templates`);
}

/** Adds the suggested English and Hindi templates. */
export async function addSuggestedTemplatesAction(eventId: string) {
  const { ctx, ok } = await guard(eventId);
  if (!ok) return;
  for (const locale of locales) {
    const tl = createTranslator(locale);
    await saveTemplate(getDb(), dctx(ctx), null, { locale, name: tl("thankYous.suggestedName"), body: tl("thankYous.suggestedBody") });
  }
  revalidatePath(`${path(eventId)}/templates`);
}

export async function draftFromTemplateAction(eventId: string, householdId: string, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await guard(eventId);
  if (!ok || !isUuid(householdId)) return { error: t("common.notAllowed") };
  const templateId = String(fd.get("templateId") ?? "");
  try {
    await saveDraft(getDb(), dctx(ctx), householdId, { templateId: isUuid(templateId) ? templateId : null, personalLine: String(fd.get("personalLine") ?? "") });
  } catch (e) {
    return { error: giftErrorText(t, e) };
  }
  revalidatePath(`${path(eventId)}/${householdId}`);
  return { info: t("thankYous.drafted") };
}

export async function saveTextAction(eventId: string, householdId: string, version: number, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await guard(eventId);
  if (!ok || !isUuid(householdId)) return { error: t("common.notAllowed") };
  try {
    await saveDraft(getDb(), dctx(ctx), householdId, { text: String(fd.get("text") ?? ""), version });
  } catch (e) {
    return { error: giftErrorText(t, e) };
  }
  revalidatePath(`${path(eventId)}/${householdId}`);
  redirect(`${path(eventId)}/${householdId}?saved=1`);
}

export async function sendOneAction(eventId: string, householdId: string, thankYouId: string, _p: State): Promise<State> {
  const { ctx, t, ok } = await guard(eventId);
  if (!ok || !isUuid(householdId) || !isUuid(thankYouId)) return { error: t("common.notAllowed") };
  let r;
  try {
    r = await sendThankYous(getDb(), dctx(ctx), [thankYouId], { bulk: false });
  } catch (e) {
    return { error: giftErrorText(t, e) };
  }
  if (r.sent === 0) return { error: r.noAddress ? t("thankYous.noAddress") : t("thankYous.errors.not_drafted") };
  drainSoon();
  revalidatePath(path(eventId));
  redirect(`${path(eventId)}/${householdId}?sent=1`);
}

export async function setStatusAction(eventId: string, householdId: string, status: "not_started" | "not_needed" | "sent", channel: "printed" | "in_person" | null) {
  const { ctx, ok } = await guard(eventId);
  if (!ok || !isUuid(householdId)) return;
  await setStatus(getDb(), dctx(ctx), householdId, status, channel);
  revalidatePath(path(eventId));
  revalidatePath(`${path(eventId)}/${householdId}`);
}

/** Drafts notes from a template for the families in the tracker's current filter that aren't started. */
export async function draftManyAction(eventId: string, filters: Record<string, string>, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await guard(eventId);
  if (!ok) return { error: t("common.notAllowed") };
  const templateId = String(fd.get("templateId") ?? "");
  if (!isUuid(templateId)) return { error: t("thankYous.errors.no_template") };
  const db = getDb();
  const rows = (await listTracker(db, dctx(ctx), { ...filters, status: "not_started" })).map((r) => r.householdId);
  let n: number;
  try {
    n = await draftMany(db, dctx(ctx), templateId, rows);
  } catch (e) {
    return { error: giftErrorText(t, e) };
  }
  revalidatePath(path(eventId));
  return { info: t("thankYous.draftedMany", { count: n }) };
}

/** Bulk send: only the reviewed (ticked) drafted notes. */
export async function sendBulkAction(eventId: string, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await guard(eventId);
  if (!ok) return { error: t("common.notAllowed") };
  const ids = fd.getAll("ty").map(String).filter(isUuid);
  if (ids.length === 0) return { error: t("thankYous.noneSelected") };
  let r;
  try {
    r = await sendThankYous(getDb(), dctx(ctx), ids, { bulk: true });
  } catch (e) {
    return { error: giftErrorText(t, e) };
  }
  drainSoon();
  revalidatePath(path(eventId));
  redirect(`${path(eventId)}?sent=${r.sent}&skipped=${r.noAddress}`);
}
