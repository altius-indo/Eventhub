import ExcelJS from "exceljs";
import { getDb } from "@/db";
import { createTranslator } from "@/i18n/core";
import { getCatererView, HeadcountError } from "@/lib/caterer-headcount";
import { isUuid } from "@/lib/ids";
import { getLocale } from "@/lib/server/session";
import { getVendorContext } from "@/lib/server/vendor-context";
import { headcountRows } from "../../summary";

/** RSV-06 export: the caterer's aggregate headcount for one function as Excel (no guest data). */
export async function GET(_req: Request, { params }: RouteContext<"/vendor/[vendorId]/headcount/[functionId]/export">) {
  const { vendorId, functionId } = await params;
  const ctx = await getVendorContext(vendorId);
  if (!ctx.can("portal.headcount") || !isUuid(functionId)) return new Response("Not found", { status: 404 });
  const t = createTranslator(await getLocale());
  let view;
  try {
    view = await getCatererView(getDb(), ctx.event.id, vendorId, functionId, new Date(), { setBaseline: !ctx.viaAdmin });
  } catch (e) {
    if (e instanceof HeadcountError) return new Response("Not found", { status: 404 });
    throw e;
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(t("headcount.sheet"));
  ws.columns = [
    { header: t("headcount.item"), key: "group", width: 28 },
    { header: "", key: "label", width: 36 },
    { header: t("headcount.count"), key: "value", width: 12 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.addRow({ group: view.functionName, label: view.functionDate ?? "", value: "" });
  for (const r of headcountRows(t, view)) ws.addRow(r);
  if (view.share) ws.addRow({ group: t("headcount.share", { quantity: view.share.quantity, of: view.share.of }), label: "", value: view.share.quantity });
  const buf = await wb.xlsx.writeBuffer();
  const safe = view.functionName.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 40) || "function";
  return new Response(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`headcount-${safe}.xlsx`)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
