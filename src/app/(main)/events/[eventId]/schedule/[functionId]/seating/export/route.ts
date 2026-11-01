import ExcelJS from "exceljs";
import { getDb } from "@/db";
import type { MessageKey } from "@/i18n/core";
import { getFunction, NotFoundError } from "@/lib/functions";
import { isUuid } from "@/lib/ids";
import { seatingPlan } from "@/lib/seating";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

/** RPT-02: seating chart for one function as Excel (table, guest, family, side, age, RSVP). No contact details. */
export async function GET(_req: Request, { params }: RouteContext<"/events/[eventId]/schedule/[functionId]/seating/export">) {
  const { eventId, functionId } = await params;
  await getEventContext(eventId);
  if (!isUuid(functionId)) return new Response("Not found", { status: 404 });
  const db = getDb();
  const fn = await getFunction(db, eventId, functionId).catch((e) => {
    if (e instanceof NotFoundError) return null;
    throw e;
  });
  if (!fn) return new Response("Not found", { status: 404 });
  const { t } = await getTranslator();
  const plan = await seatingPlan(db, eventId, functionId);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(t("seating.title"));
  const cols = ["table", "guest", "household", "side", "age", "rsvp"] as const;
  ws.columns = cols.map((k) => ({ header: t(`seating.exportColumns.${k}`), key: k, width: k === "guest" || k === "household" ? 28 : 16 }));
  ws.getRow(1).font = { bold: true };
  const row = (table: string, g: (typeof plan.unassigned)[number]) =>
    ws.addRow({
      table,
      guest: g.name,
      household: g.householdName,
      side: t(`sides.${g.side}`),
      age: t(`ages.${g.ageGroup}`),
      rsvp: g.rsvp ? t(`rsvp.${g.rsvp}` as MessageKey) : t("rsvp.pending"),
    });
  for (const table of plan.tables) for (const g of table.guests) row(table.name, g);
  for (const g of plan.unassigned) row(t("seating.unassigned"), g);

  const buf = await wb.xlsx.writeBuffer();
  const name = fn.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "function";
  return new Response(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="seating-${name}.xlsx"`,
      "Cache-Control": "private, no-store",
    },
  });
}
