"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { RsvpError, setHouseholdRsvp, setRsvp } from "@/lib/rsvp";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

type State = { error?: string; info?: string };

const statusSchema = z.enum(["attending", "maybe", "declined", "clear"]).transform((s) => (s === "clear" ? null : s));
const memberSchema = z.object({ guestId: z.string().uuid(), status: statusSchema });
const familySchema = z.object({
  householdId: z.string().uuid(),
  status: z.enum(["attending", "declined"]),
  /** Only the members shown on a filtered view; absent = the whole family. */
  guestIds: z.array(z.string().uuid()).min(1).max(200).optional(),
});

async function run(eventId: string, fn: (ctx: Awaited<ReturnType<typeof getEventContext>>) => Promise<unknown>): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("rsvp.edit")) return { error: t("common.notAllowed") };
  try {
    await fn(ctx);
  } catch (err) {
    if (err instanceof RsvpError) return { error: t(`rsvp.errors.${err.code}`) };
    if (err instanceof z.ZodError) return { error: t("common.somethingWrong") };
    throw err;
  }
  // Counts on the RSVP tab and dashboard change too.
  revalidatePath(`/events/${eventId}`, "layout");
  return { info: t("rsvp.savedTeam") };
}

/** One member's reply on the RSVP desk (RSV-04). The domain function re-checks the invitation. */
export async function deskRsvpAction(eventId: string, functionId: string, formData: FormData): Promise<State> {
  return run(eventId, async (ctx) => {
    const input = memberSchema.parse({ guestId: formData.get("guestId"), status: formData.get("status") });
    await setRsvp(getDb(), eventId, ctx.actor, { guestId: input.guestId, functionId, status: input.status });
  });
}

/** "Whole family attending / not attending" for this function. */
export async function deskFamilyAction(eventId: string, functionId: string, formData: FormData): Promise<State> {
  return run(eventId, async (ctx) => {
    const ids = formData.getAll("guestIds");
    const input = familySchema.parse({ householdId: formData.get("householdId"), status: formData.get("status"), guestIds: ids.length ? ids : undefined });
    await setHouseholdRsvp(getDb(), eventId, ctx.actor, { householdId: input.householdId, guestIds: input.guestIds, functionId, status: input.status });
  });
}
