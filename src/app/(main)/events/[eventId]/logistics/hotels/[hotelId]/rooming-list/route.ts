import { getDb } from "@/db";
import { audit } from "@/lib/audit";
import { getHotel, roomingList, roomingListXlsx, type RoomingRow } from "@/lib/hotels";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

/** Rooming list for the hotel (TRV-05): names, room, dates and one phone; no ID data. Audited. */
export async function GET(_req: Request, { params }: RouteContext<"/events/[eventId]/logistics/hotels/[hotelId]/rooming-list">) {
  const { eventId, hotelId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("travel.edit") || !/^[0-9a-f-]{36}$/i.test(hotelId)) return new Response("Not found", { status: 404 });
  const db = getDb();
  const hotel = await getHotel(db, eventId, hotelId).catch(() => null);
  if (!hotel) return new Response("Not found", { status: 404 });
  const { t } = await getTranslator();
  const rows = await roomingList(db, eventId, hotelId, t("hotels.room"));
  const keys: (keyof RoomingRow)[] = ["roomType", "room", "guestNames", "checkIn", "checkOut", "nights", "contactPhone"];
  const buf = await roomingListXlsx(hotel, rows, Object.fromEntries(keys.map((k) => [k, t(`hotels.export.${k}`)])) as Record<keyof RoomingRow, string>);
  await audit(db, { eventId, actor: ctx.actor, action: "rooming_list.exported", entityType: "hotel", entityId: hotelId, data: { name: hotel.name, rows: rows.length } });
  const name = hotel.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "hotel";
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}-rooming-list.xlsx"`,
      "Cache-Control": "private, no-store",
    },
  });
}
