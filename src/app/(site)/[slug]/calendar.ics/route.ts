import { getDb } from "@/db";
import { functionsToIcs, listFunctions } from "@/lib/functions";
import { getPortalData } from "@/lib/rsvp";
import { getSiteContext } from "@/lib/server/site-context";

/** Public functions for visitors; an invited family gets their own functions instead. */
export async function GET(_req: Request, { params }: RouteContext<"/[slug]/calendar.ics">) {
  const { slug } = await params;
  const ctx = await getSiteContext(slug);
  if (!ctx || (!ctx.guest && (!ctx.website.published || !ctx.unlocked))) return new Response("Not found", { status: 404 });
  const db = getDb();
  const fns = ctx.guest
    ? (await getPortalData(db, ctx.guest.household)).functions
    : (await listFunctions(db, ctx.event.id)).filter((f) => f.isPublic).map((f) => (f.venuePublic ? f : { ...f, venueAddress: null, mapUrl: null }));
  return new Response(functionsToIcs(ctx.event, fns), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}.ics"`,
      "Cache-Control": "private, no-store",
    },
  });
}
