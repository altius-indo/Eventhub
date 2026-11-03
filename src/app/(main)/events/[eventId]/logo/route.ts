import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { getMembership } from "@/lib/events";
import { readEventLogo } from "@/lib/event-logo";
import { getSessionContext } from "@/lib/server/session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "private, no-store" } });

/**
 * The event logo for its members (and App Admins). Deliberately not `getEventContext`: the event
 * switcher shows other events' logos, and loading those must not count as opening the event
 * (last-event landing, admin access log). URLs carry `?v=<version>`, so a private cache is safe.
 */
export async function GET(_req: Request, { params }: RouteContext<"/events/[eventId]/logo">) {
  const { eventId } = await params;
  const session = await getSessionContext();
  if (!session || !UUID.test(eventId)) return notFound();
  const db = getDb();
  const [event] = await db.select({ logoKey: events.logoKey, deletedAt: events.deletedAt }).from(events).where(eq(events.id, eventId));
  if (!event || event.deletedAt) return notFound();
  if (!session.user.isAppAdmin && !(await getMembership(db, eventId, session.user.id))) return notFound();
  const data = await readEventLogo(eventId, event.logoKey);
  if (!data) return notFound();
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": "image/webp",
      "Content-Length": String(data.length),
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
