import { getDb } from "@/db";
import { guestExportLabels } from "@/lib/exports";
import { buildGuestWorkbook } from "@/lib/guest-import";
import { listFunctions } from "@/lib/functions";
import { cleanFilters, listAllGuests } from "@/lib/guests";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

export async function GET(req: Request, { params }: RouteContext<"/events/[eventId]/guests/export">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  const db = getDb();
  const filters = cleanFilters(Object.fromEntries(new URL(req.url).searchParams));
  const [rows, fns] = await Promise.all([listAllGuests(db, eventId, filters), listFunctions(db, eventId)]);
  const buf = await buildGuestWorkbook(rows, fns, guestExportLabels(t));
  const name = ctx.event.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "guests";
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}-guests.xlsx"`,
      "Cache-Control": "private, no-store",
    },
  });
}
