"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import type { MemberRole } from "@/db/schema";
import {
  changeMemberRole,
  EventError,
  getMembership,
  inviteMember,
  removeMember,
  revokeInvitation,
} from "@/lib/events";
import { parseIdentifier } from "@/lib/identifiers";
import { getEventContext } from "@/lib/server/event-context";
import { appUrl, getTranslator, requireStepUp } from "@/lib/server/session";

type State = { error?: string; info?: string };

const isRole = (v: unknown): v is MemberRole => v === "host" || v === "planner";

async function errorMessage(err: unknown): Promise<State> {
  const { t } = await getTranslator();
  if (err instanceof EventError) {
    if (err.code === "last_host") return { error: t("members.lastHost") };
    if (err.code === "already_member") return { error: t("members.alreadyMember") };
    if (err.code === "already_invited") return { error: t("members.alreadyInvited") };
  }
  throw err;
}

async function managerContext(eventId: string) {
  const ctx = await getEventContext(eventId);
  return ctx.can("members.manage") ? ctx : null;
}

export async function inviteAction(eventId: string, _prev: State, formData: FormData): Promise<State> {
  const ctx = await managerContext(eventId);
  const { t, locale } = await getTranslator();
  if (!ctx) return { error: t("common.notAllowed") };
  const identifier = parseIdentifier(String(formData.get("identifier") ?? ""));
  if (!identifier) return { error: t("auth.errors.invalidIdentifier") };
  const role = formData.get("role");
  if (!isRole(role)) return { error: t("common.somethingWrong") };
  try {
    await inviteMember(getDb(), {
      event: ctx.event,
      actor: ctx.actor,
      inviterName: ctx.user.name ?? "",
      identifier,
      role,
      locale,
      appUrl: appUrl(),
    });
  } catch (err) {
    return errorMessage(err);
  }
  revalidatePath(`/events/${eventId}/members`);
  return { info: t("members.inviteSent") };
}

export async function revokeInvitationAction(eventId: string, formData: FormData) {
  const ctx = await managerContext(eventId);
  if (!ctx) return;
  try {
    await revokeInvitation(getDb(), eventId, String(formData.get("invitationId")), ctx.actor);
  } catch (err) {
    if (!(err instanceof EventError)) throw err;
  }
  revalidatePath(`/events/${eventId}/members`);
}

export async function updateMemberAction(eventId: string, _prev: State, formData: FormData): Promise<State> {
  const ctx = await managerContext(eventId);
  const { t } = await getTranslator();
  if (!ctx) return { error: t("common.notAllowed") };
  const userId = String(formData.get("userId"));
  const role = formData.get("role");
  const db = getDb();
  const member = await getMembership(db, eventId, userId);
  if (!member) return { error: t("common.somethingWrong") };
  try {
    if (isRole(role) && role !== member.role) {
      if (member.role === "host") await requireStepUp(ctx, `/events/${eventId}/members`);
      await changeMemberRole(db, eventId, userId, role, ctx.actor);
    }
  } catch (err) {
    return errorMessage(err);
  }
  revalidatePath(`/events/${eventId}`, "layout");
  return { info: t("common.saved") };
}

export async function removeMemberAction(eventId: string, _prev: State, formData: FormData): Promise<State> {
  const ctx = await managerContext(eventId);
  const { t } = await getTranslator();
  if (!ctx) return { error: t("common.notAllowed") };
  const userId = String(formData.get("userId"));
  const member = await getMembership(getDb(), eventId, userId);
  if (!member) return {};
  if (member.role === "host") await requireStepUp(ctx, `/events/${eventId}/members`);
  try {
    await removeMember(getDb(), eventId, userId, ctx.actor);
  } catch (err) {
    return errorMessage(err);
  }
  if (userId === ctx.user.id) redirect("/events");
  revalidatePath(`/events/${eventId}`, "layout");
  return {};
}
