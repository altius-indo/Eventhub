import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { PrintButton } from "@/components/print-button";
import { Alert } from "@/components/ui";
import { getDb } from "@/db";
import { functions } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getGallerySettings } from "@/lib/gallery";
import { isUuid } from "@/lib/ids";
import { getEventContext } from "@/lib/server/event-context";
import { appUrl, getTranslator } from "@/lib/server/session";
import { getOrCreateWebsite } from "@/lib/website";

/**
 * Printable per-function QR for the venue (GAL-03). It opens the site's gallery for that
 * function; uploading still needs the family's guest link on that phone (no anonymous uploads).
 */
export default async function GalleryQrPage({ params }: PageProps<"/events/[eventId]/gallery/qr/[functionId]">) {
  const { eventId, functionId } = await params;
  const ctx = await getEventContext(eventId);
  if (!isUuid(functionId)) notFound();
  const db = getDb();
  const [fn] = await db.select().from(functions).where(and(eq(functions.id, functionId), eq(functions.eventId, eventId)));
  if (!fn) notFound();
  const { t } = await getTranslator();
  const site = await getOrCreateWebsite(db, ctx.event);
  const settings = await getGallerySettings(db, eventId);
  const url = `${appUrl()}/${site.slug}/gallery?fn=${fn.id}`;
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return (
    <article className="print-sheet mx-auto max-w-md space-y-4 rounded-xl bg-white p-6 text-center text-black">
      <h1 className="text-2xl font-semibold">{t("gallery.qrPage.title", { function: fn.name })}</h1>
      <p className="text-sm">{ctx.event.coupleNames || ctx.event.name}</p>
      <div className="mx-auto w-64" role="img" aria-label="QR code" dangerouslySetInnerHTML={{ __html: svg }} />
      <p className="break-all text-xs">{url}</p>
      <p className="text-sm print:hidden">{t("gallery.qrPage.help")}</p>
      {!settings.guestUploads && (
        <div className="print:hidden">
          <Alert tone="warning">{t("gallery.qrPage.uploadsOff")}</Alert>
        </div>
      )}
      <div className="print:hidden">
        <PrintButton label={t("gallery.qrPage.print")} />
      </div>
    </article>
  );
}
