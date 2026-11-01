import { getDb } from "@/db";
import { buildHeadcountWorkbook } from "@/lib/exports";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

/** Headcount summary plus one sheet per function listing attending guests (for caterers). */
export async function GET(_req: Request, { params }: RouteContext<"/events/[eventId]/rsvp/export">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  const buf = await buildHeadcountWorkbook(getDb(), eventId, t);
  const name = ctx.event.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "rsvp";
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}-headcount.xlsx"`,
      "Cache-Control": "private, no-store",
    },
  });
}
