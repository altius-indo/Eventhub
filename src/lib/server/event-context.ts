import "server-only";
import { and, eq, gt } from "drizzle-orm";
import { notFound } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/db";
import { auditLogs, events, type Event, type EventMember } from "@/db/schema";
import { audit, type Actor } from "../audit";
import { getMembership } from "../events";
import { decide, type Permission, type PolicySubject } from "../policy";
import { requireUser, type SessionContext } from "./session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EventContext = SessionContext & {
  event: Event;
  membership: EventMember | null;
  subject: PolicySubject;
  actor: Actor;
  /** True when an App Admin who isn't a member is viewing the event. */
  viaAdmin: boolean;
  decide: (p: Permission) => ReturnType<typeof decide>;
  can: (p: Permission) => boolean;
};

/**
 * Loads an event for the signed-in user. Non-members get a 404 (so event IDs
 * don't leak), except App Admins, whose access is logged (EVT-10).
 */
export const getEventContext = cache(async (eventId: string): Promise<EventContext> => {
  const session = await requireUser();
  if (!UUID.test(eventId)) notFound();
  const db = getDb();
  const [event] = await db.select().from(events).where(eq(events.id, eventId));
  if (!event || event.deletedAt) notFound();

  const membership = await getMembership(db, eventId, session.user.id);
  const viaAdmin = !membership && session.user.isAppAdmin;
  if (!membership && !viaAdmin) notFound();

  const subject: PolicySubject = {
    isAppAdmin: viaAdmin,
    membership: membership ? { role: membership.role, giftAccess: membership.giftAccess } : null,
  };
  const actor: Actor = { userId: session.user.id, isAppAdmin: viaAdmin };

  if (viaAdmin) await logAdminOpen(eventId, actor);

  return {
    ...session,
    event,
    membership,
    subject,
    actor,
    viaAdmin,
    decide: (p) => decide(subject, p),
    can: (p) => decide(subject, p) !== "deny",
  };
});

/** Records an App Admin opening an event, at most once an hour per admin and event. */
async function logAdminOpen(eventId: string, actor: Actor) {
  const db = getDb();
  const [recent] = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.eventId, eventId),
        eq(auditLogs.actorUserId, actor.userId),
        eq(auditLogs.action, "admin.event_opened"),
        gt(auditLogs.createdAt, new Date(Date.now() - 60 * 60 * 1000)),
      ),
    )
    .limit(1);
  if (!recent) await audit(db, { eventId, actor, action: "admin.event_opened", entityType: "event", entityId: eventId });
}
