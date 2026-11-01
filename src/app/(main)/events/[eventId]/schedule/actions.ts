"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FunctionFormState } from "@/components/function-form";
import { getDb } from "@/db";
import { createFunction, deleteFunction, NotFoundError, updateFunction } from "@/lib/functions";
import { getEventContext } from "@/lib/server/event-context";
import { parseFunctionForm } from "@/lib/server/function-form";
import { getTranslator } from "@/lib/server/session";

export async function createFunctionAction(eventId: string, _prev: FunctionFormState, formData: FormData): Promise<FunctionFormState> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("itinerary.edit")) return { error: t("common.notAllowed") };
  const parsed = parseFunctionForm(t, formData);
  if (!parsed.ok) return parsed.state;
  await createFunction(getDb(), eventId, ctx.actor, parsed.data);
  revalidatePath(`/events/${eventId}`, "layout");
  redirect(`/events/${eventId}/schedule`);
}

export async function updateFunctionAction(eventId: string, functionId: string, _prev: FunctionFormState, formData: FormData): Promise<FunctionFormState> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("itinerary.edit")) return { error: t("common.notAllowed") };
  const parsed = parseFunctionForm(t, formData);
  if (!parsed.ok) return parsed.state;
  try {
    await updateFunction(getDb(), eventId, functionId, ctx.actor, parsed.data);
  } catch (err) {
    if (err instanceof NotFoundError) return { error: t("common.somethingWrong") };
    throw err;
  }
  revalidatePath(`/events/${eventId}`, "layout");
  redirect(`/events/${eventId}/schedule`);
}

export async function deleteFunctionAction(eventId: string, functionId: string) {
  const ctx = await getEventContext(eventId);
  if (!ctx.can("itinerary.edit")) return;
  try {
    await deleteFunction(getDb(), eventId, functionId, ctx.actor);
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
  }
  revalidatePath(`/events/${eventId}`, "layout");
  redirect(`/events/${eventId}/schedule`);
}
