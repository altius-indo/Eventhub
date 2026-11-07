import { getDb } from "@/db";
import { buildGiftListWorkbook } from "@/lib/exports";
import { cleanGiftFilters, listGiftItems } from "@/lib/gifts";
import { getEventContext } from "@/lib/server/event-context";
import { dctx } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";

/** The gift list as Excel (GFT-06), with the list's current filters. */
export async function GET(req: Request, { params }: RouteContext<"/events/[eventId]/gifts/export">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gifts.view")) return new Response("Not found", { status: 404 });
  const filters = cleanGiftFilters(Object.fromEntries(new URL(req.url).searchParams));
  const { t, locale } = await getTranslator();
  const rows = await listGiftItems(getDb(), dctx(ctx), filters);
  const buf = await buildGiftListWorkbook(rows, t, locale);
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="gifts-to-give.xlsx"`,
      "Cache-Control": "private, no-store",
    },
  });
}
