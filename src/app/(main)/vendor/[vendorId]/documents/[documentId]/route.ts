import { getDb } from "@/db";
import { DocumentError, getDocument } from "@/lib/documents";
import { isUuid } from "@/lib/ids";
import { getVendorContext } from "@/lib/server/vendor-context";
import { portalDocumentAllowed } from "@/lib/vendor-portal";

/** Downloads a file in the vendor's scope (its own vendor row, quotes, bookings or invoices); never cached or inline. */
export async function GET(_req: Request, { params }: RouteContext<"/vendor/[vendorId]/documents/[documentId]">) {
  const { vendorId, documentId } = await params;
  const ctx = await getVendorContext(vendorId);
  const notFound = () => new Response("Not found", { status: 404 });
  if (!isUuid(documentId) || !ctx.can("portal.view")) return notFound();
  const db = getDb();
  if (!(await portalDocumentAllowed(db, ctx.event.id, vendorId, documentId))) return notFound();
  try {
    const { doc, data } = await getDocument(db, ctx.event.id, documentId);
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
