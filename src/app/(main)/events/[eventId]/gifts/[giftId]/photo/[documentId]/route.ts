import { getDb } from "@/db";
import { DocumentError, getDocument } from "@/lib/documents";
import { getGift, GiftError } from "@/lib/gifts";
import { isUuid } from "@/lib/ids";
import { getEventContext } from "@/lib/server/event-context";
import { dctx } from "@/lib/server/money-form";

/** Downloads a gift photo for people who may see that gift (GFT-07). Never cached or inlined. */
export async function GET(_req: Request, { params }: RouteContext<"/events/[eventId]/gifts/[giftId]/photo/[documentId]">) {
  const { eventId, giftId, documentId } = await params;
  const ctx = await getEventContext(eventId);
  const notFound = () => new Response("Not found", { status: 404 });
  if (!ctx.can("gifts.record") || !isUuid(giftId) || !isUuid(documentId)) return notFound();
  const db = getDb();
  const gift = await getGift(db, dctx(ctx), giftId).catch((e) => {
    if (e instanceof GiftError) return null;
    throw e;
  });
  if (!gift) return notFound();
  try {
    const { doc, data } = await getDocument(db, eventId, documentId);
    if (doc.giftId !== giftId) return notFound();
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": doc.mime,
        "Content-Length": String(data.length),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (e) {
    if (e instanceof DocumentError) return notFound();
    throw e;
  }
}
