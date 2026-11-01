"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { addTables, deleteTable, seatGuests, seatHousehold, SeatingError, tableSchema, unseat, updateTable } from "@/lib/seating";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

type State = { error?: string; info?: string };

async function editor(eventId: string) {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  return { ctx, t, allowed: ctx.can("seating.edit") };
}
const refresh = (eventId: string, functionId: string) => revalidatePath(`/events/${eventId}/schedule/${functionId}/seating`);

export async function addTablesAction(eventId: string, functionId: string, _prev: State, fd: FormData): Promise<State> {
  const { t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  try {
    await addTables(getDb(), eventId, functionId, {
      count: Number(fd.get("count")) || 1,
      capacity: Number(fd.get("capacity")) || 8,
      prefix: String(fd.get("prefix") ?? "").trim().slice(0, 40) || t("seating.prefixDefault"),
    });
  } catch (e) {
    if (e instanceof SeatingError) return { error: t(`seating.errors.${e.code}`) };
    throw e;
  }
  refresh(eventId, functionId);
  return { info: t("common.saved") };
}

/** Seats the ticked guests (or, with op=family, each ticked guest's whole family) at the chosen table. */
export async function seatAction(eventId: string, functionId: string, _prev: State, fd: FormData): Promise<State> {
  const { t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  const tableId = String(fd.get("tableId") ?? "");
  const guestIds = fd.getAll("guestIds").map(String);
  const householdIds = [...new Set(fd.getAll("householdIds").map(String))];
  if (!tableId || (guestIds.length === 0 && householdIds.length === 0)) return {};
  try {
    for (const householdId of householdIds) await seatHousehold(getDb(), eventId, functionId, tableId, householdId);
    if (guestIds.length) await seatGuests(getDb(), eventId, functionId, tableId, guestIds);
  } catch (e) {
    if (e instanceof SeatingError) return { error: t(`seating.errors.${e.code}`) };
    throw e;
  }
  refresh(eventId, functionId);
  return { info: t("common.saved") };
}

export async function unseatAction(eventId: string, functionId: string, guestId: string) {
  const { allowed } = await editor(eventId);
  if (!allowed) return;
  await unseat(getDb(), eventId, functionId, guestId);
  refresh(eventId, functionId);
}

export async function updateTableAction(eventId: string, functionId: string, tableId: string, _prev: State, fd: FormData): Promise<State> {
  const { t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  const parsed = tableSchema.safeParse({ name: fd.get("name"), capacity: fd.get("capacity") });
  if (!parsed.success) return { error: t("transfers.errors.invalid") };
  await updateTable(getDb(), eventId, tableId, parsed.data);
  refresh(eventId, functionId);
  return {};
}

export async function deleteTableAction(eventId: string, functionId: string, tableId: string) {
  const { ctx, allowed } = await editor(eventId);
  if (!allowed) return;
  await deleteTable(getDb(), eventId, tableId, ctx.actor).catch((e) => {
    if (!(e instanceof SeatingError)) throw e;
  });
  refresh(eventId, functionId);
}
