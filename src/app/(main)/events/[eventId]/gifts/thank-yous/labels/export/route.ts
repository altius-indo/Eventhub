import { getDb } from "@/db";
import { audit } from "@/lib/audit";
import { getEventContext } from "@/lib/server/event-context";
import { dctx } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { addressLabels, labelsXlsx, trackerFilterKeys, type TrackerFilters } from "@/lib/thank-yous";

/** Names and postal addresses for printed thank-you cards (GFT-09). No amounts; audited. */
export async function GET(req: Request, { params }: RouteContext<"/events/[eventId]/gifts/thank-yous/labels/export">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gifts.manage")) return new Response("Not found", { status: 404 });
  const url = new URL(req.url);
  const filters: TrackerFilters = {};
  for (const k of trackerFilterKeys) {
    const v = url.searchParams.get(k);
    if (v) filters[k] = v.slice(0, 60);
  }
  const db = getDb();
  const { t } = await getTranslator();
  const rows = await addressLabels(db, dctx(ctx), filters);
  const buf = await labelsXlsx(rows, { name: t("thankYous.export.name"), address: t("thankYous.export.address"), city: t("thankYous.export.city"), postalCode: t("thankYous.export.postalCode") });
  await audit(db, { eventId, actor: ctx.actor, action: "thank_you.labels_exported", entityType: "event", entityId: eventId, data: { count: rows.length } });
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="thank-you-addresses.xlsx"`,
      "Cache-Control": "private, no-store",
    },
  });
}
