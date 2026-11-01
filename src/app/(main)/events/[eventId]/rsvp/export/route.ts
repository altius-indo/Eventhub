import { eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import { guests, rsvps } from "@/db/schema";
import { getDb } from "@/db";
import { listFunctions } from "@/lib/functions";
import { listAllGuests } from "@/lib/guests";
import { headcounts } from "@/lib/rsvp";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

/** Headcount summary plus one sheet per function listing attending guests (for caterers). */
export async function GET(_req: Request, { params }: RouteContext<"/events/[eventId]/rsvp/export">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  const db = getDb();
  const [fns, counts, rows] = await Promise.all([listFunctions(db, eventId), headcounts(db, eventId), listAllGuests(db, eventId)]);

  const wb = new ExcelJS.Workbook();
  const summary = wb.addWorksheet(t("importer.sheetSummary"));
  const diets = ["veg", "non_veg", "jain", "vegan", "other"] as const;
  summary.columns = [
    { header: t("importer.function"), key: "fn", width: 24 },
    ...(["attending", "maybe", "declined", "pending"] as const).map((k) => ({ header: t(`rsvp.${k}`), key: k, width: 14 })),
    { header: t("ages.adult"), key: "adult", width: 10 },
    { header: t("ages.child"), key: "child", width: 10 },
    { header: t("ages.infant"), key: "infant", width: 10 },
    ...diets.map((d) => ({ header: t(`diets.${d}`), key: d, width: 10 })),
    { header: t("rsvp.unknownDiet"), key: "unknown", width: 12 },
    { header: t("rsvp.allergies"), key: "allergies", width: 16 },
  ];
  summary.getRow(1).font = { bold: true };
  for (const fn of fns) {
    const c = counts.get(fn.id);
    summary.addRow({
      fn: fn.name,
      attending: c?.attending ?? 0,
      maybe: c?.maybe ?? 0,
      declined: c?.declined ?? 0,
      pending: c?.pending ?? 0,
      ...(c?.attendingBy.age ?? {}),
      ...(c?.attendingBy.diet ?? {}),
      allergies: c?.attendingBy.allergies ?? 0,
    });
  }

  // Attending guests per function
  const answers = new Map<string, Record<string, string>>();
  const all = await db
    .select({ guestId: rsvps.guestId, functionId: rsvps.functionId, status: rsvps.status })
    .from(rsvps)
    .innerJoin(guests, eq(guests.id, rsvps.guestId))
    .where(eq(guests.eventId, eventId));
  for (const a of all) answers.set(a.guestId, { ...(answers.get(a.guestId) ?? {}), [a.functionId]: a.status });
  for (const fn of fns) {
    const ws = wb.addWorksheet(fn.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Function");
    ws.columns = [
      { header: t("importer.fields.household"), key: "h", width: 24 },
      { header: t("importer.fields.name"), key: "n", width: 24 },
      { header: t("importer.fields.side"), key: "s", width: 14 },
      { header: t("importer.fields.ageGroup"), key: "a", width: 10 },
      { header: t("importer.fields.diet"), key: "d", width: 12 },
      { header: t("guestForm.dietNotes"), key: "dn", width: 30 },
      { header: t("rsvp.title"), key: "r", width: 14 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      const status = answers.get(r.guest.id)?.[fn.id];
      if (status !== "attending" && status !== "maybe") continue;
      ws.addRow({
        h: r.household.name,
        n: r.guest.name,
        s: t(`sides.${r.household.side}`),
        a: t(`ages.${r.guest.ageGroup}`),
        d: r.guest.diet ? t(`diets.${r.guest.diet}`) : "",
        dn: r.guest.dietNotes ?? "",
        r: t(`rsvp.${status}`),
      });
    }
  }
  const name = ctx.event.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "rsvp";
  return new Response(new Uint8Array(await wb.xlsx.writeBuffer()), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}-headcount.xlsx"`,
      "Cache-Control": "private, no-store",
    },
  });
}
