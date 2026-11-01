"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import type { EventFormState } from "@/components/event-form";
import { softDeleteEvent, updateEvent } from "@/lib/events";
import { parseEventForm } from "@/lib/server/event-form";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator, requireStepUp } from "@/lib/server/session";

export async function updateEventAction(eventId: string, _prev: EventFormState, formData: FormData): Promise<EventFormState> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("event.update")) return { error: t("common.notAllowed") };
  const parsed = parseEventForm(t, formData);
  if (!parsed.ok) return parsed.state;
  const event = await updateEvent(getDb(), eventId, ctx.actor, parsed.data);
  revalidatePath(`/events/${eventId}`, "layout");
  return { info: t("common.saved"), values: event };
}

export async function deleteEventAction(eventId: string, _prev: { error?: string }, formData: FormData) {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("event.delete")) return { error: t("common.notAllowed") };
  if (String(formData.get("confirm") ?? "").trim() !== ctx.event.name.trim()) return { error: t("settings.confirmMismatch") };
  await requireStepUp(ctx, `/events/${eventId}/settings`);
  await softDeleteEvent(getDb(), eventId, ctx.actor);
  redirect("/events");
}

export async function updateRsvpDeadlineAction(eventId: string, _prev: { error?: string; info?: string }, formData: FormData) {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("event.update")) return { error: t("common.notAllowed") };
  const raw = String(formData.get("rsvpDeadline") ?? "");
  if (raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { error: t("common.somethingWrong") };
  await getDb().update(events).set({ rsvpDeadline: raw || null, updatedAt: new Date() }).where(eq(events.id, eventId));
  revalidatePath(`/events/${eventId}`, "layout");
  return { info: t("common.saved") };
}
