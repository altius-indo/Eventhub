import { ensureCatalogue } from "./catalogue";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Database, Tx } from "@/db";
import {
  eventInvitations,
  eventMembers,
  events,
  users,
  type Event,
  type GiftAccess,
  type MemberRole,
} from "@/db/schema";
import { createTranslator, type Locale } from "@/i18n/core";
import { audit, type Actor } from "./audit";
import { removeUserEventNotifications } from "./notifications";
import { findUserByIdentifier } from "./auth-core";
import { DeliveryError, sendMessage } from "./delivery";
import { formatIdentifier, type Identifier } from "./identifiers";

export const DELETE_UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export class EventError extends Error {
  constructor(public code: "last_host" | "already_member" | "already_invited" | "not_found" | "restore_expired") {
    super(code);
  }
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .or(z.literal("").transform(() => undefined));

export const eventDetailsSchema = z
  .object({
    name: z.string().trim().min(1, "nameRequired").max(120),
    coupleNames: z.string().trim().max(120).optional(),
    startDate: isoDate,
    endDate: isoDate,
    city: z.string().trim().max(80).optional(),
  })
  .refine((v) => !v.startDate || !v.endDate || v.endDate >= v.startDate, {
    message: "dateOrder",
    path: ["endDate"],
  });

export type EventDetails = z.infer<typeof eventDetailsSchema>;

const toRow = (d: EventDetails) => ({
  name: d.name,
  coupleNames: d.coupleNames || null,
  startDate: d.startDate ?? null,
  endDate: d.endDate ?? null,
  city: d.city || null,
});

export async function createEvent(db: Database, actor: Actor, details: EventDetails, locale: Locale = "en"): Promise<Event> {
  return db.transaction(async (tx) => {
    const [event] = await tx
      .insert(events)
      .values({ ...toRow(details), createdBy: actor.userId })
      .returning();
    await tx.insert(eventMembers).values({ eventId: event.id, userId: actor.userId, role: "host" });
    await ensureCatalogue(tx, event.id, locale);
    await audit(tx, { eventId: event.id, actor, action: "event.created", entityType: "event", entityId: event.id });
    return event;
  });
}

export async function updateEvent(db: Database, eventId: string, actor: Actor, details: EventDetails) {
  return db.transaction(async (tx) => {
    const [event] = await tx
      .update(events)
      .set({ ...toRow(details), updatedAt: new Date() })
      .where(and(eq(events.id, eventId), isNull(events.deletedAt)))
      .returning();
    if (!event) throw new EventError("not_found");
    await audit(tx, { eventId, actor, action: "event.updated", entityType: "event", entityId: eventId, data: toRow(details) });
    return event;
  });
}

export async function softDeleteEvent(db: Database, eventId: string, actor: Actor, now = new Date()) {
  await db.transaction(async (tx) => {
    const [event] = await tx
      .update(events)
      .set({ deletedAt: now, deletedBy: actor.userId, purgeAfter: new Date(now.getTime() + DELETE_UNDO_WINDOW_MS) })
      .where(and(eq(events.id, eventId), isNull(events.deletedAt)))
      .returning();
    if (!event) throw new EventError("not_found");
    await audit(tx, { eventId, actor, action: "event.deleted", entityType: "event", entityId: eventId });
  });
}

export async function restoreEvent(db: Database, eventId: string, actor: Actor, now = new Date()) {
  await db.transaction(async (tx) => {
    const [event] = await tx
      .update(events)
      .set({ deletedAt: null, deletedBy: null, purgeAfter: null })
      .where(and(eq(events.id, eventId), isNotNull(events.deletedAt), gt(events.purgeAfter, now)))
      .returning();
    if (!event) throw new EventError("restore_expired");
    await audit(tx, { eventId, actor, action: "event.restored", entityType: "event", entityId: eventId });
  });
}

/**
 * Permanently removes events whose undo window has passed. Run by `npm run jobs:purge` and the
 * daily cron. Goes through the retention purge (ADR-0033): anonymised counts are kept and the
 * event's stored files are queued for deletion.
 */
export async function purgeDeletedEvents(db: Database, now = new Date()): Promise<number> {
  const { purgeSoftDeleted } = await import("./retention");
  return purgeSoftDeleted(db, now);
}

export type EventListItem = { event: Event; role: MemberRole };

export async function listEventsForUser(db: Tx, userId: string) {
  const rows = await db
    .select({ event: events, role: eventMembers.role })
    .from(eventMembers)
    .innerJoin(events, eq(events.id, eventMembers.eventId))
    .where(eq(eventMembers.userId, userId))
    .orderBy(asc(events.startDate), desc(events.createdAt));
  return {
    active: rows.filter((r) => !r.event.deletedAt),
    deleted: rows.filter(
      (r) => r.event.deletedAt && r.role === "host" && r.event.purgeAfter && r.event.purgeAfter.getTime() > Date.now(),
    ),
  };
}

export async function getMembership(db: Tx, eventId: string, userId: string) {
  const [m] = await db
    .select()
    .from(eventMembers)
    .where(and(eq(eventMembers.eventId, eventId), eq(eventMembers.userId, userId)));
  return m ?? null;
}

export async function listMembers(db: Tx, eventId: string) {
  return db
    .select({ member: eventMembers, user: { id: users.id, name: users.name } })
    .from(eventMembers)
    .innerJoin(users, eq(users.id, eventMembers.userId))
    .where(eq(eventMembers.eventId, eventId))
    .orderBy(asc(eventMembers.role), asc(eventMembers.createdAt));
}

export async function listOpenInvitations(db: Tx, eventId: string) {
  return db
    .select()
    .from(eventInvitations)
    .where(and(eq(eventInvitations.eventId, eventId), isNull(eventInvitations.acceptedAt), isNull(eventInvitations.revokedAt)))
    .orderBy(desc(eventInvitations.createdAt));
}

export async function memberCounts(db: Tx, eventId: string) {
  const rows = await db
    .select({ role: eventMembers.role, n: count() })
    .from(eventMembers)
    .where(eq(eventMembers.eventId, eventId))
    .groupBy(eventMembers.role);
  const [{ n: invites }] = await db
    .select({ n: count() })
    .from(eventInvitations)
    .where(and(eq(eventInvitations.eventId, eventId), isNull(eventInvitations.acceptedAt), isNull(eventInvitations.revokedAt)));
  return {
    hosts: rows.find((r) => r.role === "host")?.n ?? 0,
    planners: rows.find((r) => r.role === "planner")?.n ?? 0,
    invites,
  };
}

/** Locks the event row so concurrent role changes can't remove the last Host. */
async function lockEvent(tx: Tx, eventId: string) {
  await tx.select({ id: events.id }).from(events).where(eq(events.id, eventId)).for("update");
}

async function hostCount(tx: Tx, eventId: string) {
  const [{ n }] = await tx
    .select({ n: count() })
    .from(eventMembers)
    .where(and(eq(eventMembers.eventId, eventId), eq(eventMembers.role, "host")));
  return n;
}

export type InviteResult = { status: "added"; userId: string } | { status: "invited"; invitationId: string };

/**
 * Invites someone by phone or email. If they already have an account they join
 * immediately; otherwise they join on first login with that identifier (EVT-01b).
 */
export async function inviteMember(
  db: Database,
  input: {
    event: Event;
    actor: Actor;
    inviterName: string;
    identifier: Identifier;
    role: MemberRole;
    locale: Locale;
    appUrl: string;
  },
): Promise<InviteResult> {
  const { event, actor, identifier, role } = input;
  const result = await db.transaction(async (tx): Promise<InviteResult> => {
    const existingUser = await findUserByIdentifier(tx, identifier);
    if (existingUser) {
      if (await getMembership(tx, event.id, existingUser.id)) throw new EventError("already_member");
      await tx.insert(eventMembers).values({ eventId: event.id, userId: existingUser.id, role });
      await audit(tx, {
        eventId: event.id,
        actor,
        action: "member.invited",
        entityType: "member",
        entityId: existingUser.id,
        data: { identifier: formatIdentifier(identifier), role },
      });
      return { status: "added", userId: existingUser.id };
    }
    const [open] = await tx
      .select({ id: eventInvitations.id })
      .from(eventInvitations)
      .where(
        and(
          eq(eventInvitations.eventId, event.id),
          eq(eventInvitations.identifierType, identifier.type),
          eq(eventInvitations.identifierValue, identifier.value),
          isNull(eventInvitations.acceptedAt),
          isNull(eventInvitations.revokedAt),
        ),
      );
    if (open) throw new EventError("already_invited");
    const [invite] = await tx
      .insert(eventInvitations)
      .values({
        eventId: event.id,
        identifierType: identifier.type,
        identifierValue: identifier.value,
        role,
        invitedBy: actor.userId,
      })
      .returning();
    await audit(tx, {
      eventId: event.id,
      actor,
      action: "member.invited",
      entityType: "invitation",
      entityId: invite.id,
      data: { identifier: formatIdentifier(identifier), role },
    });
    return { status: "invited", invitationId: invite.id };
  });

  // Notify outside the transaction; a failed notification doesn't undo the invite.
  const t = createTranslator(input.locale);
  try {
    await sendMessage(db, {
      channel: identifier.type === "email" ? "email" : "sms",
      to: identifier.value,
      subject: event.name,
      text: t("members.inviteMessage", {
        inviter: input.inviterName,
        event: event.name,
        role: t(role === "host" ? "roles.host" : "roles.planner"),
        kind: t(identifier.type === "email" ? "members.kindEmail" : "members.kindPhone"),
        url: `${input.appUrl}/login`,
      }),
    });
  } catch (err) {
    if (!(err instanceof DeliveryError)) throw err;
    console.error("Invitation notification failed", err);
  }
  return result;
}

export async function revokeInvitation(db: Database, eventId: string, invitationId: string, actor: Actor) {
  await db.transaction(async (tx) => {
    const [invite] = await tx
      .update(eventInvitations)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(eventInvitations.id, invitationId),
          eq(eventInvitations.eventId, eventId),
          isNull(eventInvitations.acceptedAt),
          isNull(eventInvitations.revokedAt),
        ),
      )
      .returning();
    if (!invite) throw new EventError("not_found");
    await audit(tx, {
      eventId,
      actor,
      action: "invitation.revoked",
      entityType: "invitation",
      entityId: invitationId,
      data: { identifier: formatIdentifier({ type: invite.identifierType, value: invite.identifierValue }) },
    });
  });
}

async function memberName(tx: Tx, userId: string) {
  const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.id, userId));
  return u?.name ?? "";
}

export async function changeMemberRole(db: Database, eventId: string, memberUserId: string, role: MemberRole, actor: Actor) {
  await db.transaction(async (tx) => {
    await lockEvent(tx, eventId);
    const member = await getMembership(tx, eventId, memberUserId);
    if (!member) throw new EventError("not_found");
    if (member.role === role) return;
    if (member.role === "host" && (await hostCount(tx, eventId)) <= 1) throw new EventError("last_host");
    await tx
      .update(eventMembers)
      .set({ role, giftAccess: role === "host" ? "none" : member.giftAccess })
      .where(eq(eventMembers.id, member.id));
    await audit(tx, {
      eventId,
      actor,
      action: "member.role_changed",
      entityType: "member",
      entityId: memberUserId,
      data: { name: await memberName(tx, memberUserId), role, from: member.role },
    });
  });
}

export async function setGiftAccess(db: Database, eventId: string, memberUserId: string, access: GiftAccess, actor: Actor) {
  await db.transaction(async (tx) => {
    const member = await getMembership(tx, eventId, memberUserId);
    if (!member) throw new EventError("not_found");
    await tx.update(eventMembers).set({ giftAccess: access }).where(eq(eventMembers.id, member.id));
    await audit(tx, {
      eventId,
      actor,
      action: "member.gift_access_changed",
      entityType: "member",
      entityId: memberUserId,
      data: { name: await memberName(tx, memberUserId), access, from: member.giftAccess },
    });
  });
}

export async function removeMember(db: Database, eventId: string, memberUserId: string, actor: Actor) {
  await db.transaction(async (tx) => {
    await lockEvent(tx, eventId);
    const member = await getMembership(tx, eventId, memberUserId);
    if (!member) throw new EventError("not_found");
    if (member.role === "host" && (await hostCount(tx, eventId)) <= 1) throw new EventError("last_host");
    const name = await memberName(tx, memberUserId);
    await tx.delete(eventMembers).where(eq(eventMembers.id, member.id));
    await removeUserEventNotifications(tx, memberUserId, eventId);
    await audit(tx, {
      eventId,
      actor,
      action: "member.removed",
      entityType: "member",
      entityId: memberUserId,
      data: { name, role: member.role },
    });
  });
}

export async function getEventsByIds(db: Tx, ids: string[]) {
  if (ids.length === 0) return [];
  return db.select().from(events).where(inArray(events.id, ids));
}
