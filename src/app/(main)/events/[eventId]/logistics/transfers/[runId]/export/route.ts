import ExcelJS from "exceljs";
import { getDb } from "@/db";
import { formatWallClock } from "@/i18n/core";
import { formatPhone } from "@/lib/guests";
import { isUuid } from "@/lib/ids";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { getManifest, getRun, TransferError } from "@/lib/transfers";

/**
 * RPT-02 / TRV-03: transfer manifest for one vehicle as Excel. Same fields as the printable
 * manifest: names, family, flight/train and time, pickup point and one contact phone.
 */
export async function GET(_req: Request, { params }: RouteContext<"/events/[eventId]/logistics/transfers/[runId]/export">) {
  const { eventId, runId } = await params;
  await getEventContext(eventId);
  if (!isUuid(runId)) return new Response("Not found", { status: 404 });
  const db = getDb();
  const run = await getRun(db, eventId, runId).catch((e) => {
    if (e instanceof TransferError) return null;
    throw e;
  });
  if (!run) return new Response("Not found", { status: 404 });
  const rows = await getManifest(db, eventId, runId);
  const { t, locale } = await getTranslator();
  const fmt = (d: Date) => formatWallClock(locale, d, { dateStyle: "medium", timeStyle: "short" });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(t(`transfers.kinds.${run.kind}`).slice(0, 31));
  ws.addRow([`${run.fromPlace} → ${run.toPlace}`, fmt(run.departsAt), [run.vehicle, run.driverName, formatPhone(run.driverPhone)].filter(Boolean).join(" · ")]).font = { bold: true };
  ws.addRow([]);
  const cols = ["guest", "household", "flight", "time", "point", "contact"] as const;
  const header = ws.addRow(["#", ...cols.map((k) => t(`transfers.exportColumns.${k}`))]);
  header.font = { bold: true };
  ws.columns = [{ width: 5 }, { width: 26 }, { width: 26 }, { width: 16 }, { width: 22 }, { width: 22 }, { width: 18 }];
  rows.forEach((r, i) => {
    const pickup = run.kind === "pickup";
    const at = pickup ? r.travel?.arrivalAt : r.travel?.departureAt;
    ws.addRow([
      i + 1,
      r.guest.name,
      r.household.name,
      (pickup ? r.travel?.arrivalNumber : r.travel?.departureNumber) ?? "",
      at ? fmt(at) : "",
      (pickup ? r.travel?.arrivalPoint : r.travel?.departurePoint) ?? "",
      formatPhone(r.contactPhone),
    ]);
  });

  const buf = await wb.xlsx.writeBuffer();
  return new Response(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="manifest-${run.departsAt.toISOString().slice(0, 10)}-${runId.slice(0, 8)}.xlsx"`,
      "Cache-Control": "private, no-store",
    },
  });
}
