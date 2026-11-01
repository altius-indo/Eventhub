"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { processErasureRequest, recordErasureRequest, RetentionError } from "@/lib/retention";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

type State = { error?: string; info?: string };

function parseRequestedOn(fd: FormData): Date | null | "invalid" {
  const raw = String(fd.get("requestedOn") ?? "").trim();
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "invalid";
  const d = new Date(`${raw}T12:00:00Z`);
  return Number.isNaN(d.getTime()) || d.getTime() > Date.now() + 86_400_000 ? "invalid" : d;
}

/** EVT-09: record that the family asked for their data to be erased (processed later). */
export async function recordErasureAction(eventId: string, householdId: string, _prev: State, fd: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("guests.edit")) return { error: t("common.notAllowed") };
  const requestedAt = parseRequestedOn(fd);
  if (requestedAt === "invalid") return { error: t("retention.errors.invalid") };
  try {
    await recordErasureRequest(getDb(), eventId, householdId, ctx.actor, { requestedAt: requestedAt ?? undefined, note: String(fd.get("note") ?? "") });
  } catch (e) {
    if (e instanceof RetentionError) return { error: t(`retention.errors.${e.code}`) };
    throw e;
  }
  revalidatePath(`/events/${eventId}/guests/${householdId}`);
  return { info: t("common.saved") };
}

/** EVT-09: erase the family now (records the request first if there isn't one). */
export async function eraseNowAction(eventId: string, householdId: string, _prev: State, fd: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("guests.edit")) return { error: t("common.notAllowed") };
  const requestedAt = parseRequestedOn(fd);
  if (requestedAt === "invalid") return { error: t("retention.errors.invalid") };
  const db = getDb();
  try {
    const req = await recordErasureRequest(db, eventId, householdId, ctx.actor, { requestedAt: requestedAt ?? undefined, note: String(fd.get("note") ?? "") });
    await processErasureRequest(db, eventId, req.id, ctx.actor);
  } catch (e) {
    if (e instanceof RetentionError) return { error: t(`retention.errors.${e.code}`) };
    throw e;
  }
  revalidatePath(`/events/${eventId}`, "layout");
  redirect(`/events/${eventId}/settings?erased=1#data`);
}
