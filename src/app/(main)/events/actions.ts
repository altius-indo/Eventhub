"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db";
import type { EventFormState } from "@/components/event-form";
import { createEvent, EventError, getMembership, restoreEvent } from "@/lib/events";
import { parseEventForm } from "@/lib/server/event-form";
import { getTranslator, requireUser } from "@/lib/server/session";

export async function createEventAction(_prev: EventFormState, formData: FormData): Promise<EventFormState> {
  const { user } = await requireUser();
  const { t } = await getTranslator();
  const parsed = parseEventForm(t, formData);
  if (!parsed.ok) return parsed.state;
  const event = await createEvent(getDb(), { userId: user.id, isAppAdmin: false }, parsed.data);
  redirect(`/events/${event.id}`);
}

export async function restoreEventAction(formData: FormData) {
  const { user } = await requireUser();
  const eventId = String(formData.get("eventId"));
  const membership = await getMembership(getDb(), eventId, user.id);
  if (membership?.role !== "host") return;
  try {
    await restoreEvent(getDb(), eventId, { userId: user.id, isAppAdmin: false });
  } catch (err) {
    if (err instanceof EventError) redirect("/events");
    throw err;
  }
  redirect(`/events/${eventId}`);
}
