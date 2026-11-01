"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { parseIdentifier } from "@/lib/identifiers";
import { isUuid } from "@/lib/ids";
import { getEventContext } from "@/lib/server/event-context";
import { appUrl, getTranslator } from "@/lib/server/session";
import { inviteVendorContact, revokeVendorContact, VendorAccessError } from "@/lib/vendor-access";

type State = { error?: string; info?: string };

/** Invites a phone number or email to this vendor's portal (VND-10, ADR-0023). */
export async function inviteContactAction(eventId: string, vendorId: string, _p: State, fd: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("vendors.edit") || !isUuid(vendorId)) return { error: t("common.notAllowed") };
  const identifier = parseIdentifier(String(fd.get("identifier") ?? ""));
  if (!identifier) return { error: t("vendorPortal.staff.errors.invalid") };
  try {
    await inviteVendorContact(getDb(), { eventId, vendorId, identifier, actor: ctx.actor, appUrl: appUrl() });
  } catch (e) {
    if (e instanceof VendorAccessError) return { error: t(`vendorPortal.staff.errors.${e.code}`) };
    throw e;
  }
  revalidatePath(`/events/${eventId}/vendors/${vendorId}`);
  return { info: t("vendorPortal.staff.inviteSent") };
}

export async function revokeContactAction(eventId: string, vendorId: string, contactId: string, _p: State): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("vendors.edit") || !isUuid(vendorId) || !isUuid(contactId)) return { error: t("common.notAllowed") };
  try {
    await revokeVendorContact(getDb(), eventId, contactId, ctx.actor);
  } catch (e) {
    if (e instanceof VendorAccessError) return { error: t(`vendorPortal.staff.errors.${e.code}`) };
    throw e;
  }
  revalidatePath(`/events/${eventId}/vendors/${vendorId}`);
  return { info: t("vendorPortal.staff.revoked") };
}
