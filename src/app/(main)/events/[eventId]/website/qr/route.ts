import QRCode from "qrcode";
import { getDb } from "@/db";
import { getEventContext } from "@/lib/server/event-context";
import { appUrl } from "@/lib/server/session";
import { getOrCreateWebsite } from "@/lib/website";

/** PNG QR code of the website address, for printed invitation cards (WEB-09). */
export async function GET(_req: Request, { params }: RouteContext<"/events/[eventId]/website/qr">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const site = await getOrCreateWebsite(getDb(), ctx.event);
  const png = await QRCode.toBuffer(`${appUrl()}/${site.slug}`, { type: "png", width: 1024, margin: 2, errorCorrectionLevel: "M" });
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "Content-Disposition": `attachment; filename="${site.slug}-qr.png"`, "Cache-Control": "private, no-store" },
  });
}
