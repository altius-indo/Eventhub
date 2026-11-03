import { getDb } from "@/db";
import { functionsToIcs, listFunctions } from "@/lib/functions";
import { getEventContext } from "@/lib/server/event-context";

export async function GET(_req: Request, { params }: RouteContext<"/events/[eventId]/schedule/calendar.ics">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const ics = functionsToIcs(ctx.event, await listFunctions(getDb(), eventId));
  const filename = ctx.event.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "schedule";
  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}.ics"`,
      "Cache-Control": "private, no-store",
    },
  });
}
