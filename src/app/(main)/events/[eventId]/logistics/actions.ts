"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { assignToRun, createRun, deleteRun, runSchema, TransferError, unassignFromRun, updateRun } from "@/lib/transfers";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

type State = { error?: string; info?: string };

async function editor(eventId: string) {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  return { ctx, t, allowed: ctx.can("travel.edit") };
}

const refresh = (eventId: string) => revalidatePath(`/events/${eventId}`, "layout");

export async function shareAction(eventId: string, _prev: State, formData: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("travel.edit") || !ctx.can("seating.edit")) return { error: t("common.notAllowed") };
  await getDb()
    .update(events)
    .set({
      shareTransfers: formData.get("shareTransfers") === "on",
      shareRooms: formData.get("shareRooms") === "on",
      shareSeating: formData.get("shareSeating") === "on",
      updatedAt: new Date(),
    })
    .where(eq(events.id, eventId));
  refresh(eventId);
  return { info: t("common.saved") };
}

function parseRun(formData: FormData) {
  return runSchema.safeParse({
    kind: formData.get("kind"),
    functionId: String(formData.get("functionId") ?? ""),
    departsAt: String(formData.get("departsAt") ?? ""),
    fromPlace: String(formData.get("fromPlace") ?? ""),
    toPlace: String(formData.get("toPlace") ?? ""),
    vehicle: String(formData.get("vehicle") ?? ""),
    driverName: String(formData.get("driverName") ?? ""),
    driverPhone: String(formData.get("driverPhone") ?? ""),
    capacity: String(formData.get("capacity") ?? ""),
    notes: String(formData.get("notes") ?? ""),
  });
}

/** Creates a run; any `guestIds` posted along (from the arrivals board) are added to it. */
export async function createRunAction(eventId: string, _prev: State, formData: FormData): Promise<State> {
  const { t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  const parsed = parseRun(formData);
  if (!parsed.success) return { error: t("transfers.errors.invalid") };
  let id: string;
  try {
    const run = await createRun(getDb(), eventId, parsed.data);
    id = run.id;
    const guestIds = formData.getAll("guestIds").map(String);
    if (guestIds.length) await assignToRun(getDb(), eventId, id, guestIds);
  } catch (err) {
    if (err instanceof TransferError) return { error: t(`transfers.errors.${err.code}`) };
    throw err;
  }
  refresh(eventId);
  redirect(`/events/${eventId}/logistics/transfers/${id}`);
}

export async function updateRunAction(eventId: string, runId: string, _prev: State, formData: FormData): Promise<State> {
  const { t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  const parsed = parseRun(formData);
  if (!parsed.success) return { error: t("transfers.errors.invalid") };
  try {
    await updateRun(getDb(), eventId, runId, parsed.data);
  } catch (err) {
    if (err instanceof TransferError) return { error: t(`transfers.errors.${err.code}`) };
    throw err;
  }
  refresh(eventId);
  return { info: t("common.saved") };
}

export async function deleteRunAction(eventId: string, runId: string) {
  const { ctx, allowed } = await editor(eventId);
  if (!allowed) return;
  try {
    await deleteRun(getDb(), eventId, runId, ctx.actor);
  } catch (err) {
    if (!(err instanceof TransferError)) throw err;
  }
  refresh(eventId);
  redirect(`/events/${eventId}/logistics/transfers`);
}

export async function assignSelectedAction(eventId: string, _prev: State, formData: FormData): Promise<State> {
  const { t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  const runId = String(formData.get("runId") ?? "");
  const guestIds = formData.getAll("guestIds").map(String);
  if (guestIds.length === 0) return {};
  if (formData.get("op") === "new") {
    const q = new URLSearchParams({ guests: guestIds.join(","), kind: String(formData.get("kind") ?? "pickup") });
    redirect(`/events/${eventId}/logistics/transfers/new?${q.toString()}`);
  }
  if (!runId) return {};
  try {
    const n = await assignToRun(getDb(), eventId, runId, guestIds);
    refresh(eventId);
    return { info: t("logistics.assigned", { count: n }) };
  } catch (err) {
    if (err instanceof TransferError) return { error: t(`transfers.errors.${err.code}`) };
    throw err;
  }
}

export async function unassignAction(eventId: string, runId: string, guestId: string) {
  const { allowed } = await editor(eventId);
  if (!allowed) return;
  await unassignFromRun(getDb(), eventId, runId, guestId);
  refresh(eventId);
}
