"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { createGiftItem, deleteGiftItem, GIFT_STATUSES, GiftError, recordBought, setGiftStatus, updateGiftItem, type GiftStatus } from "@/lib/gifts";
import { isUuid } from "@/lib/ids";
import { getEventContext } from "@/lib/server/event-context";
import { dctx } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { giftErrorText, giftFromForm } from "./shared";

type State = { error?: string; info?: string };
const list = (eventId: string) => `/events/${eventId}/gifts`;

async function guard(eventId: string) {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  return { ctx, t, ok: ctx.can("gifts.manage") };
}

/** The list, its counts and the dashboard card change together. */
const refresh = (eventId: string) => revalidatePath(`/events/${eventId}`, "layout");

export async function createGiftItemAction(eventId: string, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await guard(eventId);
  if (!ok) return { error: t("common.notAllowed") };
  const input = giftFromForm(fd);
  if (typeof input === "string") return { error: t(`gifts.errors.${input}`) };
  try {
    await createGiftItem(getDb(), dctx(ctx), input);
  } catch (e) {
    return { error: giftErrorText(t, e) };
  }
  refresh(eventId);
  redirect(`${list(eventId)}?saved=1`);
}

export async function updateGiftItemAction(eventId: string, id: string, version: number, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await guard(eventId);
  if (!ok || !isUuid(id)) return { error: t("common.notAllowed") };
  const input = giftFromForm(fd);
  if (typeof input === "string") return { error: t(`gifts.errors.${input}`) };
  try {
    await updateGiftItem(getDb(), dctx(ctx), id, version, input);
  } catch (e) {
    return { error: giftErrorText(t, e) };
  }
  refresh(eventId);
  redirect(`${list(eventId)}?saved=1`);
}

export async function deleteGiftItemAction(eventId: string, id: string, _p: State): Promise<State> {
  const { ctx, t, ok } = await guard(eventId);
  if (!ok || !isUuid(id)) return { error: t("common.notAllowed") };
  try {
    await deleteGiftItem(getDb(), dctx(ctx), id);
  } catch (e) {
    return { error: giftErrorText(t, e) };
  }
  refresh(eventId);
  redirect(`${list(eventId)}?deleted=1`);
}

/** Sets the bought count from the edit page. */
export async function setBoughtAction(eventId: string, id: string, version: number, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await guard(eventId);
  if (!ok || !isUuid(id)) return { error: t("common.notAllowed") };
  const raw = String(fd.get("bought") ?? "").trim();
  if (!/^\d{1,6}$/.test(raw)) return { error: t("gifts.errors.invalid") };
  try {
    await recordBought(getDb(), dctx(ctx), id, { set: Number(raw) }, version);
  } catch (e) {
    return { error: giftErrorText(t, e) };
  }
  refresh(eventId);
  return { info: t("gifts.saved") };
}

// One-tap actions on the list (plain forms; a missing item just refreshes the list).

async function quiet(eventId: string, run: (ctx: Awaited<ReturnType<typeof getEventContext>>) => Promise<unknown>) {
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gifts.manage")) return;
  try {
    await run(ctx);
  } catch (e) {
    if (!(e instanceof GiftError)) throw e;
  }
  refresh(eventId);
}

export async function quickStatusAction(eventId: string, id: string, status: GiftStatus) {
  if (!isUuid(id) || !(GIFT_STATUSES as readonly string[]).includes(status)) return;
  await quiet(eventId, (ctx) => setGiftStatus(getDb(), dctx(ctx), id, status));
}

/** +1, or "+N" with the number typed in the row's small field. */
export async function quickBoughtAction(eventId: string, id: string, add: number | null, fd: FormData) {
  if (!isUuid(id)) return;
  const n = add ?? Number(String(fd.get("n") ?? "").trim());
  if (!Number.isInteger(n) || n < 1 || n > 100_000) return;
  await quiet(eventId, (ctx) => recordBought(getDb(), dctx(ctx), id, { add: n }));
}
