"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
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
import { getTranslator } from "@/lib/server/session";

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
