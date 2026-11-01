"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { commitGiftImport, createGiftImport, getGiftImport, reviewGiftImport, type RowDecision } from "@/lib/gift-import";
import { isUuid } from "@/lib/ids";
import { getEventContext } from "@/lib/server/event-context";
import { dctx } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { todayIn } from "@/lib/tasks";
import { giftErrorText } from "../shared";

type State = { error?: string; info?: string };

export async function uploadGiftImportAction(eventId: string, _p: State, fd: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("gifts.manage")) return { error: t("common.notAllowed") };
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: t("gifts.import.errors.empty") };
  let id: string;
  try {
    id = (await createGiftImport(getDb(), dctx(ctx), file.name, await file.arrayBuffer())).id;
  } catch (e) {
    return { error: giftErrorText(t, e) };
  }
  redirect(`/events/${eventId}/gifts/import/${id}`);
}

/** Reads one decision per row: "match:<householdId>", "free_text" or "skip". */
export async function reviewGiftImportAction(eventId: string, importId: string, _p: State, fd: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("gifts.manage") || !isUuid(importId)) return { error: t("common.notAllowed") };
  const decisions: RowDecision[] = [];
  for (const [k, v] of fd.entries()) {
    const m = /^row_(\d+)$/.exec(k);
    if (!m || typeof v !== "string") continue;
    const index = Number(m[1]);
    if (v === "skip" || v === "free_text") decisions.push({ index, decision: v });
    else if (v.startsWith("match:") && isUuid(v.slice(6))) decisions.push({ index, decision: "match", householdId: v.slice(6) });
  }
  try {
    await reviewGiftImport(getDb(), dctx(ctx), importId, decisions);
  } catch (e) {
    return { error: giftErrorText(t, e) };
  }
  revalidatePath(`/events/${eventId}/gifts/import/${importId}`);
  return { info: t("common.saved") };
}

export async function commitGiftImportAction(eventId: string, importId: string, _p: State): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("gifts.manage") || !isUuid(importId)) return { error: t("common.notAllowed") };
  let created: number;
  try {
    await getGiftImport(getDb(), dctx(ctx), importId);
    created = (await commitGiftImport(getDb(), dctx(ctx), importId, todayIn(ctx.event.timezone))).created;
  } catch (e) {
    return { error: giftErrorText(t, e) };
  }
  revalidatePath(`/events/${eventId}/gifts`, "layout");
  redirect(`/events/${eventId}/gifts?source=import&imported=${created}`);
}
