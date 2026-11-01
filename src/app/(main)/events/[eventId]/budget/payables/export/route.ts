import ExcelJS from "exceljs";
import { getDb } from "@/db";
import { createTranslator, type MessageKey } from "@/i18n/core";
import { payables } from "@/lib/payments";
import { getEventContext } from "@/lib/server/event-context";
import { eventToday, payerText, periodEnd } from "@/lib/server/money-form";
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
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(t("payments.payablesTitle"));
  ws.columns = [
    { header: t("invoices.vendor"), key: "vendor", width: 28 },
    { header: t("bookings.milestoneLabel"), key: "label", width: 20 },
    { header: t("bookings.due"), key: "due", width: 14 },
    { header: t("bookings.amount"), key: "amount", width: 14, style: { numFmt: "#,##0.00" } },
    { header: t("bookings.balance"), key: "remaining", width: 14, style: { numFmt: "#,##0.00" } },
    { header: t("payments.payer"), key: "payer", width: 24 },
    { header: t("payments.statusColumn"), key: "status", width: 14 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    ws.addRow({
      vendor: r.vendorName,
      label: r.label || t(`bookings.milestoneKinds.${r.kind}`),
      due: r.dueDate ?? "",
      amount: r.amount / 100,
      remaining: r.remaining / 100,
      payer: payerText(t, locale, r.payer),
      status: t(`payments.status.${r.status}` as MessageKey),
    });
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Response(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="payables-${today}.xlsx"`,
      "Cache-Control": "private, no-store",
    },
  });
}
