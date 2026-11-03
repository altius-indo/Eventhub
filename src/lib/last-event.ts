import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { eventMembers, events, users } from "@/db/schema";

/**
 * "Land on the last event" (EVT-03): each user's last opened event is kept on `users.last_event_id`
 * so it works across devices. It is only a hint: membership and deletion are re-checked whenever
 * it is used, so a revoked or deleted event is never a landing page.
 */

/**
 * Remembers the event a member opened. Writes only when it changed (the caller passes the value
 * it already has from the session row), so ordinary page views cost nothing.
 */
export async function rememberLastEvent(db: Tx, userId: string, eventId: string, current: string | null) {
  if (current === eventId) return false;
  await db
    .update(users)
    .set({ lastEventId: eventId })
    .where(and(eq(users.id, userId), or(isNull(users.lastEventId), sql`${users.lastEventId} <> ${eventId}`)));
  return true;
}

/**
 * Where a signed-in team member should land: their last event if they're still a member and it
 * isn't deleted; otherwise their only event; otherwise null (the events list).
 * One query over the user's active memberships.
 */
export async function landingEventId(db: Tx, userId: string): Promise<string | null> {
  const rows = await db
    .select({ eventId: events.id, last: users.lastEventId })
    .from(eventMembers)
    .innerJoin(events, eq(events.id, eventMembers.eventId))
    .innerJoin(users, eq(users.id, eventMembers.userId))
    .where(and(eq(eventMembers.userId, userId), isNull(events.deletedAt)));
  if (rows.length === 0) return null;
  const last = rows[0].last;
  if (last && rows.some((r) => r.eventId === last)) return last;
  return rows.length === 1 ? rows[0].eventId : null;
}
