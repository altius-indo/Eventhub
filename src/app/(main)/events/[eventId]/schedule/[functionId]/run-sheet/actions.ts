"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { runItemStatus, type RunItemStatus } from "@/db/schema";
import { createItem, deleteItem, itemSchema, RunSheetError, setItemStatus, shiftItems, updateItem } from "@/lib/runsheet";
import { isUuid } from "@/lib/ids";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

type State = { error?: string; info?: string };

async function editor(eventId: string, ...ids: string[]) {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  return { ctx, t, allowed: ctx.can("runsheet.edit") && ids.every(isUuid) };
}
const refresh = (eventId: string, functionId: string) => revalidatePath(`/events/${eventId}/schedule/${functionId}/run-sheet`, "layout");
const parse = (fd: FormData) =>
  itemSchema.safeParse({
    startsAt: String(fd.get("startsAt") ?? ""),
    durationMin: String(fd.get("durationMin") ?? ""),
    title: String(fd.get("title") ?? ""),
    ownerUserId: String(fd.get("ownerUserId") ?? ""),
    ownerVendorId: String(fd.get("ownerVendorId") ?? ""),
    ownerName: String(fd.get("ownerName") ?? ""),
    ownerPhone: String(fd.get("ownerPhone") ?? ""),
    location: String(fd.get("location") ?? ""),
    notes: String(fd.get("notes") ?? ""),
    timeLocked: fd.get("timeLocked") === "on",
  });

export async function createItemAction(eventId: string, functionId: string, _prev: State, fd: FormData): Promise<State> {
  const { t, allowed } = await editor(eventId, functionId);
  if (!allowed) return { error: t("common.notAllowed") };
  const parsed = parse(fd);
  if (!parsed.success) return { error: t("runsheet.errors.invalid") };
  try {
    await createItem(getDb(), eventId, functionId, parsed.data);
  } catch (e) {
    if (e instanceof RunSheetError) return { error: t(`runsheet.errors.${e.code}`) };
    throw e;
  }
  refresh(eventId, functionId);
  return { info: t("common.saved") };
}

export async function updateItemAction(eventId: string, functionId: string, itemId: string, _prev: State, fd: FormData): Promise<State> {
  const { t, allowed } = await editor(eventId, functionId, itemId);
  if (!allowed) return { error: t("common.notAllowed") };
  const parsed = parse(fd);
  if (!parsed.success) return { error: t("runsheet.errors.invalid") };
  try {
    await updateItem(getDb(), eventId, itemId, parsed.data);
  } catch (e) {
    if (e instanceof RunSheetError) return { error: t(`runsheet.errors.${e.code}`) };
    throw e;
  }
  refresh(eventId, functionId);
  return { info: t("common.saved") };
}

export async function setStatusAction(eventId: string, functionId: string, itemId: string, status: RunItemStatus) {
  const { allowed } = await editor(eventId, functionId, itemId);
  if (!allowed || !runItemStatus.enumValues.includes(status)) return;
  await setItemStatus(getDb(), eventId, itemId, status).catch((e) => {
    if (!(e instanceof RunSheetError)) throw e;
  });
  refresh(eventId, functionId);
}

export async function shiftAction(eventId: string, functionId: string, itemId: string, _prev: State, fd: FormData): Promise<State> {
  const { t, allowed } = await editor(eventId, functionId, itemId);
  if (!allowed) return { error: t("common.notAllowed") };
  try {
    const n = await shiftItems(getDb(), eventId, itemId, Number(fd.get("minutes")));
    refresh(eventId, functionId);
    return { info: t("runsheet.shifted", { count: n }) };
  } catch (e) {
    if (e instanceof RunSheetError) return { error: t(`runsheet.errors.${e.code}`) };
    throw e;
  }
}

export async function deleteItemAction(eventId: string, functionId: string, itemId: string) {
  const { ctx, allowed } = await editor(eventId, functionId, itemId);
  if (!allowed) return;
  await deleteItem(getDb(), eventId, itemId, ctx.actor).catch((e) => {
    if (!(e instanceof RunSheetError)) throw e;
  });
  refresh(eventId, functionId);
}
