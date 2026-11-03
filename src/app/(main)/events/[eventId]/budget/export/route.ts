import { getDb } from "@/db";
import { createTranslator } from "@/i18n/core";
import { buildBudgetWorkbook } from "@/lib/exports";
import { getEventContext } from "@/lib/server/event-context";
import { getLocale } from "@/lib/server/session";

/** RPT-02: budget by function, category, vendor and payer as Excel (amounts in rupees). */
export async function GET(_req: Request, { params }: RouteContext<"/events/[eventId]/budget/export">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const t = createTranslator(await getLocale());
  const buf = await buildBudgetWorkbook(getDb(), eventId, t);
  const name = ctx.event.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "budget";
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}-budget.xlsx"`,
      "Cache-Control": "private, no-store",
    },
  });
}
