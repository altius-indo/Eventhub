import ExcelJS from "exceljs";
import { getDb } from "@/db";
import { listFunctions } from "@/lib/functions";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

const MAX_FUNCTION_COLUMNS = 8;

/**
 * A starter spreadsheet whose headers the importer recognises: two example rows, one column per
 * function with example replies (GST-04, RSV-04), and a short "How to fill" sheet.
 */
export async function GET(_req: Request, { params }: RouteContext<"/events/[eventId]/guests/template">) {
  const { eventId } = await params;
  await getEventContext(eventId);
  const { t } = await getTranslator();
  const fns = await listFunctions(getDb(), eventId);
  const fnNames = fns.length ? fns.slice(0, MAX_FUNCTION_COLUMNS).map((f) => f.name) : ["Mehendi", "Sangeet"];
  const v = { yes: t("importer.exampleValues.yes"), maybe: t("importer.exampleValues.maybe"), no: t("importer.exampleValues.no"), invited: t("importer.exampleValues.invited") };
  // Example replies, cycling so every value appears at least once.
  const examples = [
    [v.yes, v.maybe, v.invited, v.yes],
    [v.invited, v.no, v.yes, ""],
  ];

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(t("importer.sheetGuests"), { views: [{ state: "frozen", ySplit: 1 }] });
  const fields = ["household", "name", "side", "relation", "phone", "email", "ageGroup", "diet", "tags", "city"] as const;
  ws.columns = [
    ...fields.map((f) => ({ header: t(`importer.fields.${f}`), key: f, width: 20 })),
    ...fnNames.map((name, i) => ({ header: name, key: `fn${i}`, width: 14 })),
  ];
  ws.getRow(1).font = { bold: true };
  const fnCells = (row: number) => Object.fromEntries(fnNames.map((_, i) => [`fn${i}`, examples[row][i % examples[row].length]]));
  ws.addRow({ household: "Sharma family", name: "Rajesh Sharma", side: t("sides.bride"), relation: "Uncle", phone: "98765 43210", email: "rajesh@example.com", ageGroup: t("ages.adult"), diet: t("diets.veg"), tags: "VIP, elders", city: "Delhi", ...fnCells(0) });
  ws.addRow({ household: "Sharma family", name: "Anya Sharma", side: t("sides.bride"), relation: "Cousin", ageGroup: "7", diet: t("diets.jain"), tags: "kids", city: "Delhi", ...fnCells(1) });

  const howTo = wb.addWorksheet(t("importer.sheetHowTo"));
  howTo.columns = [{ key: "text", width: 110 }];
  howTo.addRow({ text: t("importer.howTo.title") }).font = { bold: true, size: 13 };
  for (const key of ["rows", "functions", "functionColumns", "values", "rsvp", "existing"] as const) {
    howTo.addRow({ text: `• ${t(`importer.howTo.${key}`)}` }).alignment = { wrapText: true, vertical: "top" };
  }

  return new Response(new Uint8Array(await wb.xlsx.writeBuffer()), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="eventhub-guest-template.xlsx"',
      "Cache-Control": "private, no-store",
    },
  });
}
