import { getDb } from "@/db";
import { guestExportLabels } from "@/lib/exports";
import { buildGuestWorkbook } from "@/lib/guest-import";
import { listFunctions } from "@/lib/functions";
import { cleanFilters, listAllGuests } from "@/lib/guests";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator, requireStepUp } from "@/lib/server/session";
import { audit } from "@/lib/audit";

/**
 * Guest list as Excel (GST-04, RPT-02). Contains phones and emails, so it needs a fresh OTP
 * (EVT-01d: bulk export of guest data) and is recorded in the activity log.
 */
export async function GET(req: Request, { params }: RouteContext<"/events/[eventId]/guests/export">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const url = new URL(req.url);
  await requireStepUp(ctx, url.pathname + url.search);
  const { t } = await getTranslator();
  const db = getDb();
  const filters = cleanFilters(Object.fromEntries(url.searchParams));
  const [rows, fns] = await Promise.all([listAllGuests(db, eventId, filters), listFunctions(db, eventId)]);
  await audit(db, { eventId, actor: ctx.actor, action: "guests.exported", entityType: "event", entityId: eventId, data: { count: rows.length } });
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
