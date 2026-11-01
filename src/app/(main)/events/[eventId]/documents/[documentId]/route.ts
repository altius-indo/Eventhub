import { getDb } from "@/db";
import { DocumentError, getDocument } from "@/lib/documents";
import { isUuid } from "@/lib/ids";
import { getEventContext } from "@/lib/server/event-context";

/** Downloads a document for members of the event only; never cached, never rendered inline. */
export async function GET(_req: Request, { params }: RouteContext<"/events/[eventId]/documents/[documentId]">) {
  const { eventId, documentId } = await params;
  await getEventContext(eventId);
  if (!isUuid(documentId)) return new Response("Not found", { status: 404 });
  try {
    const { doc, data } = await getDocument(getDb(), eventId, documentId);
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
    if (e instanceof DocumentError) return new Response("Not found", { status: 404 });
    throw e;
  }
}
