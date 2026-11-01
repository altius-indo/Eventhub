import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { Database, Tx } from "@/db";
import { eventMembers, events, userIdentifiers, users, vendorContacts, vendors, type VendorContact } from "@/db/schema";
import { createTranslator, isLocale } from "@/i18n/core";
import { audit, type Actor } from "./audit";
import type { Identifier } from "./identifiers";
import { enqueue, registerTemplate } from "./outbox";

/**
 * Vendor portal logins (VND-10, ADR-0023). A login is linked to a vendor row of one event by an
 * invitation to a phone or email; the first OTP login with that identifier accepts it. One login
 * can be linked to vendor rows in several events. Vendors are never event members.
 */

export class VendorAccessError extends Error {
  constructor(public code: "not_found" | "is_member" | "duplicate" | "invalid") {
    super(code);
  }
}

registerTemplate("vendor.invite", (vars, locale) => {
  const t = createTranslator(locale);
  return {
    subject: t("vendorPortal.inviteSubject", { event: String(vars.event ?? "") }),
    text: t("vendorPortal.inviteText", { vendor: String(vars.vendor ?? ""), event: String(vars.event ?? ""), link: String(vars.link ?? "") }),
  };
});

async function isMember(db: Tx, eventId: string, userId: string) {
  const [m] = await db.select({ id: eventMembers.id }).from(eventMembers).where(and(eq(eventMembers.eventId, eventId), eq(eventMembers.userId, userId)));
  return !!m;
}

/** Invites a phone/email to a vendor's portal; links at once if that login already exists. */
export async function inviteVendorContact(db: Database, input: { eventId: string; vendorId: string; identifier: Identifier; actor: Actor; appUrl: string }) {
  return db.transaction(async (tx) => {
    const [v] = await tx
      .select({ vendor: vendors, eventName: events.name })
      .from(vendors)
      .innerJoin(events, eq(events.id, vendors.eventId))
      .where(and(eq(vendors.id, input.vendorId), eq(vendors.eventId, input.eventId)));
    if (!v || v.vendor.archivedAt) throw new VendorAccessError("not_found");
    const [owner] = await tx
      .select({ userId: userIdentifiers.userId })
      .from(userIdentifiers)
      .where(and(eq(userIdentifiers.type, input.identifier.type), eq(userIdentifiers.value, input.identifier.value)));
    // A family member or planner of this event can't also be its vendor (separate identifier needed).
    if (owner && (await isMember(tx, input.eventId, owner.userId))) throw new VendorAccessError("is_member");
    const [open] = await tx
      .select()
      .from(vendorContacts)
      .where(
        and(
          eq(vendorContacts.vendorId, v.vendor.id),
          eq(vendorContacts.identifierType, input.identifier.type),
          eq(vendorContacts.identifierValue, input.identifier.value),
          isNull(vendorContacts.revokedAt),
        ),
      );
    if (open) throw new VendorAccessError("duplicate");
    const [contact] = await tx
      .insert(vendorContacts)
      .values({
        eventId: input.eventId,
        vendorId: v.vendor.id,
        identifierType: input.identifier.type,
        identifierValue: input.identifier.value,
        invitedBy: input.actor.userId,
        userId: owner?.userId ?? null,
        acceptedAt: owner ? new Date() : null,
      })
      .returning();
    const [actorRow] = await tx.select({ locale: users.locale }).from(users).where(eq(users.id, input.actor.userId));
    await enqueue(tx, [
      {
        eventId: input.eventId,
        purpose: "vendor_invite",
        templateKey: "vendor.invite",
        vars: { vendor: v.vendor.name, event: v.eventName, link: `${input.appUrl}/vendor` },
        recipient: { addresses: { [input.identifier.type === "email" ? "email" : "sms"]: input.identifier.value }, locale: isLocale(actorRow?.locale) ? actorRow.locale : "en" },
        channels: input.identifier.type === "email" ? ["email"] : ["sms", "whatsapp"],
        bulk: false,
        key: `vi:${contact.id}`,
      },
    ]);
    await audit(tx, {
      eventId: input.eventId,
      actor: input.actor,
      action: "vendor.portal_invited",
      entityType: "vendor",
      entityId: v.vendor.id,
      data: { name: v.vendor.name },
    });
    return contact;
  });
}

export async function revokeVendorContact(db: Database, eventId: string, contactId: string, actor: Actor) {
  await db.transaction(async (tx) => {
    const [c] = await tx
      .update(vendorContacts)
      .set({ revokedAt: new Date() })
      .where(and(eq(vendorContacts.id, contactId), eq(vendorContacts.eventId, eventId), isNull(vendorContacts.revokedAt)))
      .returning();
    if (!c) throw new VendorAccessError("not_found");
    await audit(tx, { eventId, actor, action: "vendor.portal_revoked", entityType: "vendor", entityId: c.vendorId });
  });
}

export async function listVendorContacts(db: Tx, eventId: string, vendorId: string): Promise<VendorContact[]> {
  return db
    .select()
    .from(vendorContacts)
    .where(and(eq(vendorContacts.eventId, eventId), eq(vendorContacts.vendorId, vendorId), isNull(vendorContacts.revokedAt)));
}

/** Called on login: links open vendor invitations addressed to any of the user's identifiers. */
export async function acceptVendorInvites(db: Tx, userId: string) {
  const ids = await db.select().from(userIdentifiers).where(eq(userIdentifiers.userId, userId));
  if (ids.length === 0) return 0;
  const open = await db
    .select()
    .from(vendorContacts)
    .where(
      and(
        isNull(vendorContacts.userId),
        isNull(vendorContacts.revokedAt),
        or(...ids.map((i) => and(eq(vendorContacts.identifierType, i.type), eq(vendorContacts.identifierValue, i.value)))),
      ),
    );
  let n = 0;
  for (const c of open) {
    if (await isMember(db, c.eventId, userId)) continue;
    await db.update(vendorContacts).set({ userId, acceptedAt: new Date() }).where(eq(vendorContacts.id, c.id));
    await audit(db, { eventId: c.eventId, actor: { userId, isAppAdmin: false }, action: "vendor.portal_joined", entityType: "vendor", entityId: c.vendorId });
    n++;
  }
  return n;
}

export type VendorLink = { contactId: string; vendorId: string; vendorName: string; eventId: string; eventName: string; eventStart: string | null };

/** The vendor rows a login may use: accepted, not revoked, vendor not archived, event not deleted. */
export async function vendorLinksForUser(db: Tx, userId: string): Promise<VendorLink[]> {
  const rows = await db
    .select({
      contactId: vendorContacts.id,
      vendorId: vendors.id,
      vendorName: vendors.name,
      eventId: events.id,
      eventName: events.name,
      eventStart: events.startDate,
    })
    .from(vendorContacts)
    .innerJoin(vendors, eq(vendors.id, vendorContacts.vendorId))
    .innerJoin(events, eq(events.id, vendorContacts.eventId))
    .where(and(eq(vendorContacts.userId, userId), isNull(vendorContacts.revokedAt), isNull(vendors.archivedAt), isNull(events.deletedAt)));
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.vendorId) ? false : (seen.add(r.vendorId), true)));
}

/** Whether this login may act for this vendor (re-checked on every portal request). */
export async function vendorLink(db: Tx, userId: string, vendorId: string) {
  return (await vendorLinksForUser(db, userId)).find((l) => l.vendorId === vendorId) ?? null;
}

/** Users who can read a vendor's thread and get its notifications. */
export async function vendorUserIds(db: Tx, vendorIds: string[]) {
  if (vendorIds.length === 0) return [];
  // Same conditions as vendorLinksForUser: no notifications for archived vendors or deleted events.
  const rows = await db
    .select({ userId: vendorContacts.userId })
    .from(vendorContacts)
    .innerJoin(vendors, eq(vendors.id, vendorContacts.vendorId))
    .innerJoin(events, eq(events.id, vendorContacts.eventId))
    .where(and(inArray(vendorContacts.vendorId, vendorIds), isNull(vendorContacts.revokedAt), isNull(vendors.archivedAt), isNull(events.deletedAt)));
  return [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))];
}
