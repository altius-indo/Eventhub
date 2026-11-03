import { getDb } from "@/db";
import { createTranslator } from "@/i18n/core";
import { buildPayablesWorkbook } from "@/lib/exports";
import { payables } from "@/lib/payments";
import { getEventContext } from "@/lib/server/event-context";
import { eventToday, periodEnd } from "@/lib/server/money-form";
import { getLocale } from "@/lib/server/session";

/** PAY-06 export: payables as Excel (amounts in rupees). */
export async function GET(req: Request, { params }: RouteContext<"/events/[eventId]/budget/payables/export">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const locale = await getLocale();
  const t = createTranslator(locale);
  const period = new URL(req.url).searchParams.get("period") ?? "month";
  const today = eventToday(ctx.event.timezone);
  const rows = await payables(getDb(), eventId, today, periodEnd(today, period));
  const buf = await buildPayablesWorkbook(rows, t, locale);
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="payables-${today}.xlsx"`,
      "Cache-Control": "private, no-store",
    },
  });
}
