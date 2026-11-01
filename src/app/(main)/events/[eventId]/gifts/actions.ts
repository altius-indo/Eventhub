"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { deleteDocument, DocumentError, listDocuments } from "@/lib/documents";
import { createGift, createHandover, deleteGift, getGift, updateGift } from "@/lib/gifts";
import { isUuid } from "@/lib/ids";
import { getEventContext } from "@/lib/server/event-context";
import { dctx } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { giftErrorText, giftFromForm, paise } from "./shared";

type State = { error?: string; info?: string };

export async function createGiftAction(eventId: string, _p: State, fd: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("gifts.record")) return { error: t("common.notAllowed") };
  const input = giftFromForm(fd);
  if (!input) return { error: t("gifts.errors.bad_amount") };
  let dup: boolean;
  let id: string;
  try {
    const r = await createGift(getDb(), dctx(ctx), input);
    dup = r.duplicateEnvelope;
    id = r.gift.id;
  } catch (e) {
    return { error: giftErrorText(t, e) };
  }
  revalidatePath(`/events/${eventId}/gifts`, "layout");
  redirect(dup ? `/events/${eventId}/gifts/${id}?saved=1&dup=1` : `/events/${eventId}/gifts?saved=1`);
}

export async function updateGiftAction(eventId: string, giftId: string, version: number, _p: State, fd: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("gifts.record") || !isUuid(giftId)) return { error: t("common.notAllowed") };
  const input = giftFromForm(fd);
  if (!input) return { error: t("gifts.errors.bad_amount") };
  let dup: boolean;
  try {
    dup = (await updateGift(getDb(), dctx(ctx), giftId, version, input)).duplicateEnvelope;
  } catch (e) {
    return { error: giftErrorText(t, e) };
  }
  revalidatePath(`/events/${eventId}/gifts`, "layout");
  redirect(`/events/${eventId}/gifts/${giftId}?saved=1${dup ? "&dup=1" : ""}`);
}

export async function deleteGiftAction(eventId: string, giftId: string, _p: State): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("gifts.record") || !isUuid(giftId)) return { error: t("common.notAllowed") };
  try {
    await deleteGift(getDb(), dctx(ctx), giftId);
  } catch (e) {
    return { error: giftErrorText(t, e) };
  }
  revalidatePath(`/events/${eventId}/gifts`, "layout");
  redirect(`/events/${eventId}/gifts?deleted=1`);
}

/** Removes an item photo; the gift must be one this user may change. */
export async function deleteGiftPhotoAction(eventId: string, giftId: string, documentId: string) {
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gifts.record") || !isUuid(giftId) || !isUuid(documentId)) return;
  const db = getDb();
  const gift = await getGift(db, dctx(ctx), giftId).catch(() => null);
  if (!gift || (gift.handedOver && !ctx.can("gifts.view"))) return;
  const docs = await listDocuments(db, eventId, { giftId });
  if (!docs.some((d) => d.id === documentId)) return;
  await deleteDocument(db, eventId, ctx.actor, documentId).catch((e) => {
    if (!(e instanceof DocumentError)) throw e;
  });
  revalidatePath(`/events/${eventId}/gifts/${giftId}`);
}

export async function handoverAction(eventId: string, functionId: string | null, collectorUserId: string, _p: State, fd: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("gifts.record") || !isUuid(collectorUserId) || (functionId !== null && !isUuid(functionId))) return { error: t("common.notAllowed") };
  const counted = paise(fd, "counted");
  if (counted == null) return { error: t("gifts.errors.bad_amount") };
  const to = String(fd.get("handedTo") ?? "");
  const toName = String(fd.get("handedToName") ?? "").trim();
  let diff: number;
  try {
    const r = await createHandover(getDb(), dctx(ctx), {
      functionId,
      collectorUserId,
      countedPaise: counted,
      handedToUserId: isUuid(to) ? to : null,
      handedToName: isUuid(to) ? null : toName || null,
      notes: String(fd.get("notes") ?? "").trim() || null,
    });
    diff = r.discrepancyPaise;
  } catch (e) {
    return { error: giftErrorText(t, e) };
  }
  revalidatePath(`/events/${eventId}/gifts`, "layout");
  redirect(`/events/${eventId}/gifts/cash?handover=${diff === 0 ? "ok" : "flagged"}`);
}
