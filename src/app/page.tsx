import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { acceptPendingInvitations } from "@/lib/auth-core";
import { listEventsForUser } from "@/lib/events";
import { landingEventId } from "@/lib/last-event";
import { getSessionContext } from "@/lib/server/session";
import { vendorLinksForUser } from "@/lib/vendor-access";

export default async function Home() {
  const ctx = await getSessionContext();
  if (!ctx) redirect("/login");
  if (!ctx.user.name) redirect("/welcome");
  const db = getDb();
  // As on /events: pick up invitations sent to an identifier added after logging in.
  await acceptPendingInvitations(db, ctx.user.id);
  // Land on the last event the user opened, or their only one (EVT-03); otherwise the list.
  const eventId = await landingEventId(db, ctx.user.id);
  if (eventId) redirect(`/events/${eventId}`);
  // Vendor-only logins land in their portal (VND-10).
  if ((await listEventsForUser(db, ctx.user.id)).active.length === 0 && (await vendorLinksForUser(db, ctx.user.id)).length > 0) redirect("/vendor");
  redirect("/events");
}
