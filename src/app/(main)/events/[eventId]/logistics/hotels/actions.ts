"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import {
  assignRoom,
  blockSchema,
  createBlock,
  createHotel,
  deleteBlock,
  deleteHotel,
  HotelError,
  hotelSchema,
  renameRoom,
  unassignRoom,
  updateBlock,
  updateHotel,
} from "@/lib/hotels";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

type State = { error?: string; info?: string };

async function editor(eventId: string) {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  return { ctx, t, allowed: ctx.can("travel.edit") };
}
const refresh = (eventId: string) => revalidatePath(`/events/${eventId}`, "layout");
const err = (t: Awaited<ReturnType<typeof getTranslator>>["t"], e: unknown): State => {
  if (e instanceof HotelError) return { error: t(`hotels.errors.${e.code}`) };
  throw e;
};

const hotelFrom = (fd: FormData) =>
  hotelSchema.safeParse({
    name: String(fd.get("name") ?? ""),
    address: String(fd.get("address") ?? ""),
    phone: String(fd.get("phone") ?? ""),
    mapUrl: String(fd.get("mapUrl") ?? ""),
    notes: String(fd.get("notes") ?? ""),
  });
const blockFrom = (fd: FormData) =>
  blockSchema.safeParse({
    roomType: String(fd.get("roomType") ?? ""),
    maxOccupancy: String(fd.get("maxOccupancy") ?? "2"),
    blockedCount: String(fd.get("blockedCount") ?? "0"),
    rate: String(fd.get("rate") ?? ""),
    checkIn: String(fd.get("checkIn") ?? ""),
    checkOut: String(fd.get("checkOut") ?? ""),
    notes: String(fd.get("notes") ?? ""),
  });

export async function createHotelAction(eventId: string, _prev: State, fd: FormData): Promise<State> {
  const { t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  const parsed = hotelFrom(fd);
  if (!parsed.success) return { error: t("transfers.errors.invalid") };
  let id: string;
  try {
    id = (await createHotel(getDb(), eventId, parsed.data)).id;
  } catch (e) {
    return err(t, e);
  }
  refresh(eventId);
  redirect(`/events/${eventId}/logistics/hotels/${id}`);
}

export async function updateHotelAction(eventId: string, hotelId: string, _prev: State, fd: FormData): Promise<State> {
  const { t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  const parsed = hotelFrom(fd);
  if (!parsed.success) return { error: t("transfers.errors.invalid") };
  try {
    await updateHotel(getDb(), eventId, hotelId, parsed.data);
  } catch (e) {
    return err(t, e);
  }
  refresh(eventId);
  return { info: t("common.saved") };
}

export async function deleteHotelAction(eventId: string, hotelId: string) {
  const { ctx, allowed } = await editor(eventId);
  if (!allowed) return;
  await deleteHotel(getDb(), eventId, hotelId, ctx.actor).catch((e) => {
    if (!(e instanceof HotelError)) throw e;
  });
  refresh(eventId);
  redirect(`/events/${eventId}/logistics/hotels`);
}

export async function createBlockAction(eventId: string, hotelId: string, _prev: State, fd: FormData): Promise<State> {
  const { t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  const parsed = blockFrom(fd);
  if (!parsed.success) return { error: t(parsed.error.issues.some((i) => i.message === "bad_dates") ? "hotels.errors.bad_dates" : "transfers.errors.invalid") };
  try {
    await createBlock(getDb(), eventId, hotelId, parsed.data);
  } catch (e) {
    return err(t, e);
  }
  refresh(eventId);
  return { info: t("common.saved") };
}

export async function updateBlockAction(eventId: string, blockId: string, _prev: State, fd: FormData): Promise<State> {
  const { ctx, t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  const parsed = blockFrom(fd);
  if (!parsed.success) return { error: t(parsed.error.issues.some((i) => i.message === "bad_dates") ? "hotels.errors.bad_dates" : "transfers.errors.invalid") };
  try {
    await updateBlock(getDb(), eventId, blockId, parsed.data, ctx.actor);
  } catch (e) {
    return err(t, e);
  }
  refresh(eventId);
  return { info: t("common.saved") };
}

export async function deleteBlockAction(eventId: string, blockId: string) {
  const { ctx, allowed } = await editor(eventId);
  if (!allowed) return;
  await deleteBlock(getDb(), eventId, blockId, ctx.actor).catch((e) => {
    if (!(e instanceof HotelError)) throw e;
  });
  refresh(eventId);
}

export async function assignRoomAction(eventId: string, _prev: State, fd: FormData): Promise<State> {
  const { t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  const roomId = String(fd.get("roomId") ?? "");
  const guestIds = fd.getAll("guestIds").map(String);
  const checkIn = String(fd.get("checkIn") ?? "");
  const checkOut = String(fd.get("checkOut") ?? "");
  if (!roomId || guestIds.length === 0) return {};
  try {
    const res = await assignRoom(getDb(), eventId, roomId, guestIds, checkIn && checkOut ? { checkIn, checkOut } : undefined);
    refresh(eventId);
    return res.warnings.length ? { info: res.warnings.map((w) => t(`hotels.warnings.${w}`)).join(" ") } : { info: t("common.saved") };
  } catch (e) {
    return err(t, e);
  }
}

export async function unassignRoomAction(eventId: string, roomId: string, guestId: string) {
  const { allowed } = await editor(eventId);
  if (!allowed) return;
  await unassignRoom(getDb(), eventId, roomId, guestId);
  refresh(eventId);
}

export async function renameRoomAction(eventId: string, roomId: string, _prev: State, fd: FormData): Promise<State> {
  const { t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  await renameRoom(getDb(), eventId, roomId, String(fd.get("label") ?? "")).catch((e) => err(t, e));
  refresh(eventId);
  return {};
}
