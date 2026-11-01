"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { guests, households, type RsvpStatus } from "@/db/schema";
import { audit } from "@/lib/audit";
import { DeliveryError } from "@/lib/delivery";
import { regenerateGuestLink, revokeGuestLink, sendGuestLink } from "@/lib/guest-links";
import { RsvpError, saveRsvps } from "@/lib/rsvp";
import { saveTravel, travelFromForm } from "@/lib/travel";
import { NotFoundError } from "@/lib/functions";
import {
  addGuest,
  bulkInvite,
  cleanFilters,
  createHousehold,
  deleteHousehold,
  deleteSavedView,
  GuestError,
  listAllGuests,
  removeGuest,
  saveView,
  setHead,
  setHouseholdInvites,
  updateGuest,
  updateHousehold,
  type GuestInput,
} from "@/lib/guests";
import { getEventContext } from "@/lib/server/event-context";
import { parseGuestFields, parseHouseholdFields } from "@/lib/server/guest-form";
import { appUrl, getTranslator } from "@/lib/server/session";

type State = { error?: string; info?: string };

async function editor(eventId: string) {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  return { ctx, t, allowed: ctx.can("guests.edit") };
}

function refresh(eventId: string) {
  revalidatePath(`/events/${eventId}`, "layout");
}

export async function createHouseholdAction(eventId: string, _prev: State, formData: FormData): Promise<State> {
  const { ctx, t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  const household = parseHouseholdFields(formData);
  if (!household) return { error: t("guestForm.nameRequired") };
  const members: GuestInput[] = [];
  for (const key of String(formData.get("memberKeys") ?? "").split(",").filter(Boolean)) {
    const res = parseGuestFields(t, formData, `m${key}_`);
    if (!res.ok) return { error: res.error };
    members.push(res.data);
  }
  if (members.length === 0) return { error: t("guestForm.nameRequired") };
  let id: string;
  try {
    ({ household: { id } } = await createHousehold(getDb(), eventId, ctx.actor, {
      household,
      members,
      functionIds: formData.getAll("functionIds").map(String),
    }));
  } catch (err) {
    if (err instanceof NotFoundError) return { error: t("common.somethingWrong") };
    throw err;
  }
  refresh(eventId);
  redirect(`/events/${eventId}/guests/${id}?created=1`);
}

export async function updateHouseholdAction(eventId: string, householdId: string, _prev: State, formData: FormData): Promise<State> {
  const { t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  const household = parseHouseholdFields(formData);
  if (!household) return { error: t("guestForm.nameRequired") };
  await updateHousehold(getDb(), eventId, householdId, household);
  refresh(eventId);
  return { info: t("common.saved") };
}

export async function deleteHouseholdAction(eventId: string, householdId: string) {
  const { ctx, allowed } = await editor(eventId);
  if (!allowed) return;
  try {
    await deleteHousehold(getDb(), eventId, householdId, ctx.actor);
  } catch (err) {
    if (!(err instanceof GuestError)) throw err;
  }
  refresh(eventId);
  redirect(`/events/${eventId}/guests`);
}

export async function addGuestAction(eventId: string, householdId: string, _prev: State, formData: FormData): Promise<State> {
  const { t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  const res = parseGuestFields(t, formData, "new_");
  if (!res.ok) return { error: res.error };
  await addGuest(getDb(), eventId, householdId, res.data);
  refresh(eventId);
  return { info: t("common.saved") };
}

export async function updateGuestAction(eventId: string, guestId: string, _prev: State, formData: FormData): Promise<State> {
  const { t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  const res = parseGuestFields(t, formData, `g_`);
  if (!res.ok) return { error: res.error };
  await updateGuest(getDb(), eventId, guestId, res.data);
  refresh(eventId);
  return { info: t("common.saved") };
}

export async function removeGuestAction(eventId: string, guestId: string, _prev: State): Promise<State> {
  const { t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  try {
    await removeGuest(getDb(), eventId, guestId);
  } catch (err) {
    if (err instanceof GuestError && err.code === "last_member") return { error: t("household.lastMember") };
    throw err;
  }
  refresh(eventId);
  return {};
}

export async function setHeadAction(eventId: string, guestId: string) {
  const { allowed } = await editor(eventId);
  if (!allowed) return;
  await setHead(getDb(), eventId, guestId);
  refresh(eventId);
}

/** Saves the member × function matrix; checkbox names are "inv:<guestId>:<functionId>". */
export async function saveInvitesAction(eventId: string, householdId: string, _prev: State, formData: FormData): Promise<State> {
  const { t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  const invites: Record<string, string[]> = {};
  for (const guestId of formData.getAll("guestIds").map(String)) invites[guestId] = [];
  for (const [key] of formData.entries()) {
    const m = key.match(/^inv:([0-9a-f-]{36}):([0-9a-f-]{36})$/i);
    if (m && invites[m[1]]) invites[m[1]].push(m[2]);
  }
  try {
    await setHouseholdInvites(getDb(), eventId, householdId, invites);
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof GuestError) return { error: t("common.somethingWrong") };
    throw err;
  }
  refresh(eventId);
  return { info: t("common.saved") };
}

/** Invites (or un-invites) everyone matching the current filters. */
export async function bulkInviteAction(eventId: string, _prev: State, formData: FormData): Promise<State> {
  const { t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  const filters = cleanFilters(Object.fromEntries(formData.entries()));
  const functionId = String(formData.get("functionId") ?? "");
  const invite = formData.get("op") !== "remove";
  const rows = await listAllGuests(getDb(), eventId, filters);
  try {
    await bulkInvite(getDb(), eventId, rows.map((r) => r.guest.id), functionId, invite);
  } catch (err) {
    if (err instanceof NotFoundError) return { error: t("common.somethingWrong") };
    throw err;
  }
  refresh(eventId);
  return { info: t("guests.bulkDone", { count: rows.length }) };
}

export async function saveViewAction(eventId: string, _prev: State, formData: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  const name = String(formData.get("viewName") ?? "").trim();
  const filters = cleanFilters(Object.fromEntries(formData.entries()));
  if (!name || Object.keys(filters).length === 0) return { error: t("guests.viewName") };
  await saveView(getDb(), eventId, ctx.user.id, name, filters);
  refresh(eventId);
  return { info: t("common.saved") };
}

export async function deleteViewAction(eventId: string, viewId: string) {
  const { allowed } = await editor(eventId);
  if (!allowed) return;
  await deleteSavedView(getDb(), eventId, viewId);
  refresh(eventId);
}

// ---------------------------------------------------------------------------
// Milestone 3: guest links, RSVPs on behalf, travel, family settings
// ---------------------------------------------------------------------------

async function householdFor(eventId: string, householdId: string) {
  const [h] = await getDb()
    .select()
    .from(households)
    .where(and(eq(households.id, householdId), eq(households.eventId, eventId)));
  return h ?? null;
}

export async function sendGuestLinkAction(eventId: string, householdId: string, _prev: State, formData: FormData): Promise<State> {
  const { ctx, t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  const household = await householdFor(eventId, householdId);
  if (!household || household.linkRevokedAt) return { error: t("guestLink.revoked") };
  const [kind, guestId] = String(formData.get("target") ?? "").split(":");
  const [guest] = await getDb()
    .select()
    .from(guests)
    .where(and(eq(guests.id, guestId ?? ""), eq(guests.householdId, householdId)));
  const to = kind === "email" ? guest?.email : guest?.phone;
  if (!guest || !to) return { error: t("guestLink.noContact") };
  try {
    await sendGuestLink(getDb(), { household, event: ctx.event, channel: kind === "email" ? "email" : "sms", to, appUrl: appUrl() });
  } catch (err) {
    if (err instanceof DeliveryError) return { error: t("auth.errors.deliveryFailed") };
    throw err;
  }
  refresh(eventId);
  return { info: t("guestLink.sent") };
}

export async function regenerateLinkAction(eventId: string, householdId: string) {
  const { ctx, allowed } = await editor(eventId);
  if (!allowed) return;
  const h = await regenerateGuestLink(getDb(), eventId, householdId);
  if (h) await audit(getDb(), { eventId, actor: ctx.actor, action: "guest_link.regenerated", entityType: "household", entityId: h.id, data: { name: h.name } });
  refresh(eventId);
}

export async function revokeLinkAction(eventId: string, householdId: string) {
  const { ctx, allowed } = await editor(eventId);
  if (!allowed) return;
  const h = await revokeGuestLink(getDb(), eventId, householdId);
  if (h) await audit(getDb(), { eventId, actor: ctx.actor, action: "guest_link.revoked", entityType: "household", entityId: h.id, data: { name: h.name } });
  refresh(eventId);
}

export async function familySettingsAction(eventId: string, householdId: string, _prev: State, formData: FormData): Promise<State> {
  const { t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  const locale = formData.get("locale") === "hi" ? "hi" : "en";
  const plusOnes = Math.max(0, Math.min(10, Math.trunc(Number(formData.get("plusOnesAllowed")) || 0)));
  await getDb()
    .update(households)
    .set({ locale, plusOnesAllowed: plusOnes, updatedAt: new Date() })
    .where(and(eq(households.id, householdId), eq(households.eventId, eventId)));
  refresh(eventId);
  return { info: t("common.saved") };
}

/** Records RSVPs on the family's behalf (RSV-04). Select names are "rsvp:<guestId>:<functionId>". */
export async function recordRsvpAction(eventId: string, householdId: string, _prev: State, formData: FormData): Promise<State> {
  const { ctx, t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  const household = await householdFor(eventId, householdId);
  if (!household) return { error: t("common.somethingWrong") };
  const answers = [...formData.entries()].flatMap(([k, v]) => {
    const m = k.match(/^rsvp:([0-9a-f-]{36}):([0-9a-f-]{36})$/i);
    if (!m) return [];
    const status: RsvpStatus | null = v === "attending" || v === "maybe" || v === "declined" ? v : null;
    return [{ guestId: m[1], functionId: m[2], status }];
  });
  try {
    await saveRsvps(getDb(), { household, event: ctx.event, answers, recordedBy: ctx.actor });
  } catch (err) {
    if (err instanceof RsvpError) return { error: t(`rsvp.errors.${err.code}`) };
    throw err;
  }
  refresh(eventId);
  return { info: t("rsvp.savedTeam") };
}

export async function saveTravelAction(eventId: string, guestId: string, _prev: State, formData: FormData): Promise<State> {
  const { t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  const [guest] = await getDb()
    .select({ id: guests.id })
    .from(guests)
    .where(and(eq(guests.id, guestId), eq(guests.eventId, eventId)));
  if (!guest) return { error: t("common.somethingWrong") };
  const parsed = travelFromForm(formData);
  if (!parsed.success) return { error: t("travel.order") };
  await saveTravel(getDb(), guestId, parsed.data, false);
  refresh(eventId);
  return { info: t("common.saved") };
}
