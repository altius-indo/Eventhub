"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { BroadcastError, createDraft, deleteDraft, sendBroadcast, updateDraft, type BroadcastInput } from "@/lib/broadcasts";
import { isUuid } from "@/lib/ids";
import { drainSoon } from "@/lib/server/drain";
import { getEventContext } from "@/lib/server/event-context";
import { appUrl, getTranslator } from "@/lib/server/session";

type State = { error?: string; info?: string };
type T = Awaited<ReturnType<typeof getTranslator>>["t"];

function fail(t: T, e: unknown): State {
  if (e instanceof BroadcastError) {
    if (e.code === "quota") return { error: t("broadcasts.errors.quota", { channel: e.channel ? t(`broadcasts.channelNames.${e.channel}`) : "" }) };
    return { error: t(`broadcasts.errors.${e.code}`) };
  }
  throw e;
}

const all = (fd: FormData, name: string) => fd.getAll(name).map(String).filter(Boolean);

function inputFrom(fd: FormData): BroadcastInput {
  const bodyHi = String(fd.get("bodyHi") ?? "").trim();
  return {
    title: String(fd.get("title") ?? ""),
    bodyEn: String(fd.get("bodyEn") ?? ""),
    bodyHi: bodyHi || undefined,
    channels: all(fd, "channels") as BroadcastInput["channels"],
    segment: {
      sides: all(fd, "sides") as NonNullable<BroadcastInput["segment"]["sides"]>,
      tags: all(fd, "tags"),
      functionIds: all(fd, "functionIds"),
      rsvp: all(fd, "rsvp") as NonNullable<BroadcastInput["segment"]["rsvp"]>,
      travel: all(fd, "travel") as NonNullable<BroadcastInput["segment"]["travel"]>,
      hotelIds: all(fd, "hotelIds"),
      allAdults: fd.get("allAdults") === "on",
    },
  };
}

async function sender(eventId: string) {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  return { ctx, t, ok: ctx.can("messaging.send") };
}

export async function createDraftAction(eventId: string, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await sender(eventId);
  if (!ok) return { error: t("common.notAllowed") };
  let id: string;
  try {
    id = (await createDraft(getDb(), eventId, ctx.actor, inputFrom(fd))).id;
  } catch (e) {
    return fail(t, e);
  }
  redirect(`/events/${eventId}/messages/broadcasts/${id}`);
}

export async function updateDraftAction(eventId: string, broadcastId: string, _p: State, fd: FormData): Promise<State> {
  const { t, ok } = await sender(eventId);
  if (!ok || !isUuid(broadcastId)) return { error: t("common.notAllowed") };
  try {
    await updateDraft(getDb(), eventId, broadcastId, inputFrom(fd));
  } catch (e) {
    return fail(t, e);
  }
  revalidatePath(`/events/${eventId}/messages/broadcasts/${broadcastId}`);
  return { info: t("broadcasts.draftSaved") };
}

export async function sendAction(eventId: string, broadcastId: string, _p: State, _fd: FormData): Promise<State> {
  const { ctx, t, ok } = await sender(eventId);
  if (!ok || !isUuid(broadcastId)) return { error: t("common.notAllowed") };
  try {
    await sendBroadcast(getDb(), eventId, broadcastId, ctx.actor, appUrl());
  } catch (e) {
    return fail(t, e);
  }
  drainSoon();
  revalidatePath(`/events/${eventId}/messages/broadcasts`);
  redirect(`/events/${eventId}/messages/broadcasts/${broadcastId}?sent=1`);
}

export async function deleteDraftAction(eventId: string, broadcastId: string, _p: State, _fd: FormData): Promise<State> {
  const { t, ok } = await sender(eventId);
  if (!ok || !isUuid(broadcastId)) return { error: t("common.notAllowed") };
  try {
    await deleteDraft(getDb(), eventId, broadcastId);
  } catch (e) {
    return fail(t, e);
  }
  redirect(`/events/${eventId}/messages/broadcasts`);
}
