import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { DOCUMENT_KINDS, DocumentError, MAX_DOCUMENT_BYTES, saveDocument, type DocumentOwner } from "@/lib/documents";
import { isUuid } from "@/lib/ids";
import { getEventContext } from "@/lib/server/event-context";
import { getSessionContext } from "@/lib/server/session";

const OWNERS = ["vendorId", "quoteId", "bookingId", "invoiceId", "paymentId", "serviceId"] as const;

/**
 * Document upload (ADR-0018): a plain multipart form posts here (server actions are capped
 * at 6 MB). Same-origin only; redirects back with ?doc=ok or ?docError=<code>.
 */
export async function POST(req: Request, { params }: RouteContext<"/events/[eventId]/documents">) {
  const { eventId } = await params;
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let originHost: string | null = null;
  try {
    originHost = origin ? new URL(origin).host : null;
  } catch {
    originHost = null;
  }
  if (!originHost || originHost !== host) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  if (!(await getSessionContext())) return NextResponse.json({ error: "signed_out" }, { status: 401 });
  if (!isUuid(eventId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const ctx = await getEventContext(eventId);
  // Refuse oversized bodies before reading them (the proxy would otherwise truncate silently).
  const declared = Number(req.headers.get("content-length") ?? "");
  if (!Number.isFinite(declared) || declared <= 0) return NextResponse.json({ error: "length_required" }, { status: 411 });
  if (declared > MAX_DOCUMENT_BYTES + 512 * 1024) {
    return NextResponse.redirect(new URL(`/events/${eventId}?docError=too_large`, req.url), 303);
  }

  const fd = await req.formData().catch(() => null);
  const backRaw = String(fd?.get("back") ?? "");
  const back = backRaw.startsWith(`/events/${eventId}/`) && !backRaw.includes("//") ? backRaw.split("?")[0] : `/events/${eventId}`;
  const go = (q: string) => NextResponse.redirect(new URL(`${back}?${q}`, req.url), 303);
  if (!ctx.can("contracts.edit")) return go("docError=invalid");
  if (!fd) return go("docError=invalid");

  const ownerKey = String(fd.get("owner") ?? "");
  const ownerId = String(fd.get("ownerId") ?? "");
  const kind = String(fd.get("kind") ?? "other");
  const file = fd.get("file");
  if (!(OWNERS as readonly string[]).includes(ownerKey) || !isUuid(ownerId) || !(file instanceof File)) return go("docError=invalid");
  if (file.size > MAX_DOCUMENT_BYTES) return go("docError=too_large");
  try {
    await saveDocument(getDb(), eventId, ctx.actor, {
      owner: { [ownerKey]: ownerId } as DocumentOwner,
      kind: (DOCUMENT_KINDS as readonly string[]).includes(kind) ? (kind as (typeof DOCUMENT_KINDS)[number]) : "other",
      filename: file.name,
      data: Buffer.from(await file.arrayBuffer()),
    });
  } catch (e) {
    if (e instanceof DocumentError) return go(`docError=${e.code}`);
    throw e;
  }
  return go("doc=ok");
}
