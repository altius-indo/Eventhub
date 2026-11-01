import ExcelJS from "exceljs";
import { getDb } from "@/db";
import { budgetFacts, byPayer, groupFacts, type Measures } from "@/lib/budget";
import { listServiceTypes } from "@/lib/catalogue";
import { listFunctions } from "@/lib/functions";
import { listVendors } from "@/lib/vendors";
import { getEventContext } from "@/lib/server/event-context";
import { eventToday, typeLabel } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";

type Row = { label: string; m: Measures | undefined };

/**
 * RPT-02 / BGT-05 export: the budget overview as Excel, one sheet per view (function, service
 * type, vendor, payer) with planned, pending, booked, invoiced and paid in rupees (GST included).
 */
export async function GET(_req: Request, { params }: RouteContext<"/events/[eventId]/budget/export">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  const db = getDb();
  const [facts, fns, types, vendors] = await Promise.all([
    budgetFacts(db, eventId),
    listFunctions(db, eventId),
    listServiceTypes(db, eventId),
    listVendors(db, eventId, { includeArchived: true }),
  ]);
  const byFn = groupFacts(facts, "functionId");
  const byCat = groupFacts(facts, "categoryId");
  const byVendor = groupFacts(facts, "vendorId");
  const payer = byPayer(facts);

  const wb = new ExcelJS.Workbook();
  const sheet = (name: string, rows: Row[]) => {
    const ws = wb.addWorksheet(name.slice(0, 31));
    const money = { numFmt: "#,##0.00" };
    ws.columns = [
      { header: "", key: "label", width: 32 },
      { header: t("budget.planned"), key: "planned", width: 16, style: money },
      { header: t("budget.pending"), key: "pending", width: 18, style: money },
      { header: t("budget.committed"), key: "committed", width: 16, style: money },
      { header: t("budget.invoiced"), key: "invoiced", width: 16, style: money },
      { header: t("budget.paid"), key: "paid", width: 16, style: money },
    ];
    ws.getRow(1).font = { bold: true };
    const live = rows.filter((r): r is { label: string; m: Measures } => !!r.m && !!(r.m.planned || r.m.pending || r.m.committed || r.m.invoiced || r.m.paid));
    for (const { label, m } of live) {
      ws.addRow({ label, planned: m.planned / 100, pending: m.pending / 100, committed: m.committed / 100, invoiced: m.invoiced / 100, paid: m.paid / 100 });
    }
    const total: Measures = { planned: 0, pending: 0, committed: 0, invoiced: 0, paid: 0 };
    for (const { m } of live) for (const k of Object.keys(total) as (keyof Measures)[]) total[k] += m[k];
    const totalRow = ws.addRow({
      label: t("budget.total"),
      planned: total.planned / 100,
      pending: total.pending / 100,
      committed: total.committed / 100,
      invoiced: total.invoiced / 100,
      paid: total.paid / 100,
    });
    totalRow.font = { bold: true };
  };

  sheet(t("budget.byFunction"), [...fns.map((f) => ({ label: f.name, m: byFn.get(f.id) })), { label: t("budget.noFunction"), m: byFn.get(null) }]);
  sheet(t("budget.byCategory"), [
    ...types.map((ty) => ({ label: typeLabel(t, { typeKey: ty.systemKey, typeName: ty.name }), m: byCat.get(ty.id) })),
    { label: t("budget.noCategory"), m: byCat.get(null) },
  ]);
  sheet(t("budget.byVendor"), [...vendors.map((v) => ({ label: v.name, m: byVendor.get(v.id) })), { label: t("budget.noVendor"), m: byVendor.get(null) }]);
  sheet(t("budget.byPayer"), [
    { label: t("payer.bride"), m: payer.bride },
    { label: t("payer.groom"), m: payer.groom },
    { label: t("payer.unassigned"), m: payer.unassigned },
  ]);

  const buf = await wb.xlsx.writeBuffer();
  return new Response(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="budget-${eventToday(ctx.event.timezone)}.xlsx"`,
      "Cache-Control": "private, no-store",
    },
  });
}
