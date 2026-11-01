import ExcelJS from "exceljs";
import { getDb } from "@/db";
import { listFunctions } from "@/lib/functions";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

/** A starter spreadsheet whose headers the importer recognises, with two example rows. */
export async function GET(_req: Request, { params }: RouteContext<"/events/[eventId]/guests/template">) {
  const { eventId } = await params;
  await getEventContext(eventId);
  const { t } = await getTranslator();
  const fns = await listFunctions(getDb(), eventId);
  const fnList = fns.slice(0, 2).map((f) => f.name).join(", ") || "Mehendi, Sangeet";
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(t("importer.sheetGuests"), { views: [{ state: "frozen", ySplit: 1 }] });
  const fields = ["household", "name", "side", "relation", "phone", "email", "ageGroup", "diet", "tags", "functions", "city"] as const;
  ws.columns = fields.map((f) => ({ header: t(`importer.fields.${f}`), key: f, width: f === "functions" ? 30 : 20 }));
  ws.getRow(1).font = { bold: true };
  ws.addRow({ household: "Sharma family", name: "Rajesh Sharma", side: t("sides.bride"), relation: "Uncle", phone: "98765 43210", email: "rajesh@example.com", ageGroup: t("ages.adult"), diet: t("diets.veg"), tags: "VIP, elders", functions: fnList, city: "Delhi" });
  ws.addRow({ household: "Sharma family", name: "Anya Sharma", side: t("sides.bride"), relation: "Cousin", ageGroup: "7", diet: t("diets.jain"), tags: "kids", functions: fnList, city: "Delhi" });
  return new Response(new Uint8Array(await wb.xlsx.writeBuffer()), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="eventhub-guest-template.xlsx"',
    },
  });
}
