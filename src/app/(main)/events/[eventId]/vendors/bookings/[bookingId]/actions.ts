"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { HeadcountError, releaseFinalCount, setHeadcountLock, zonedInstant } from "@/lib/caterer-headcount";
import { isUuid } from "@/lib/ids";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

type State = { error?: string; info?: string };

async function locker(eventId: string, bookingId: string, functionId: string) {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  return { ctx, t, ok: ctx.can("headcount.lock") && isUuid(bookingId) && isUuid(functionId) };
}
const page = (eventId: string, bookingId: string) => revalidatePath(`/events/${eventId}/vendors/bookings/${bookingId}`);

/** Sets the caterer's final-guarantee time (RSV-07), entered in the event's timezone. */
export async function setLockAction(eventId: string, bookingId: string, functionId: string, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await locker(eventId, bookingId, functionId);
  if (!ok) return { error: t("common.notAllowed") };
  const raw = String(fd.get("lockAt") ?? "");
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(raw);
  if (!m) return { error: t("headcount.staff.errors.invalid") };
  try {
    await setHeadcountLock(getDb(), { eventId, actor: ctx.actor, bookingId, functionId, lockAt: zonedInstant(m[1], m[2], ctx.event.timezone) });
  } catch (e) {
    if (e instanceof HeadcountError) return { error: t(`headcount.staff.errors.${e.code}`) };
    throw e;
  }
  page(eventId, bookingId);
  return { info: t("headcount.staff.saved") };
}

export async function clearLockAction(eventId: string, bookingId: string, functionId: string, _p: State): Promise<State> {
  const { ctx, t, ok } = await locker(eventId, bookingId, functionId);
  if (!ok) return { error: t("common.notAllowed") };
  try {
    await setHeadcountLock(getDb(), { eventId, actor: ctx.actor, bookingId, functionId, lockAt: null });
  } catch (e) {
    if (e instanceof HeadcountError) return { error: t(`headcount.staff.errors.${e.code}`) };
    throw e;
  }
  page(eventId, bookingId);
  return { info: t("headcount.staff.cleared") };
}

export async function releaseCountAction(eventId: string, bookingId: string, functionId: string, _p: State): Promise<State> {
  const { ctx, t, ok } = await locker(eventId, bookingId, functionId);
  if (!ok) return { error: t("common.notAllowed") };
  try {
    await releaseFinalCount(getDb(), { eventId, actor: ctx.actor, bookingId, functionId });
  } catch (e) {
    if (e instanceof HeadcountError) return { error: t(`headcount.staff.errors.${e.code}`) };
    throw e;
  }
  page(eventId, bookingId);
  return { info: t("headcount.staff.releasedInfo") };
}
