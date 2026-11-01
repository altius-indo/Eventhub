import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { DocumentError, MAX_DOCUMENT_BYTES, saveDocument } from "@/lib/documents";
import { percentToBps, rupeesToPaise } from "@/lib/money";
import { PaymentError } from "@/lib/payments";
import { getSessionContext } from "@/lib/server/session";
import { getVendorContext } from "@/lib/server/vendor-context";
import { portalInvoiceInput, PortalError, uploadPortalInvoice } from "@/lib/vendor-portal";

/**
 * A vendor uploads an invoice with its file (VND-08/10). A plain multipart form posts here
 * (server actions are capped at 6 MB, ADR-0018). Same-origin only; redirects back to the
 * invoices page with ?saved=1, ?err=<code> or ?fileErr=<code> (codes only, never text).
 */
export async function POST(req: Request, { params }: RouteContext<"/vendor/[vendorId]/invoices/upload">) {
  const { vendorId } = await params;
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
  const ctx = await getVendorContext(vendorId);
  const back = `/vendor/${vendorId}/invoices`;
  const go = (q: string) => NextResponse.redirect(new URL(`${back}?${q}`, req.url), 303);
  if (!ctx.can("portal.invoice")) return go("err=portal.invalid");
  const declared = Number(req.headers.get("content-length") ?? "");
  if (!Number.isFinite(declared) || declared <= 0) return NextResponse.json({ error: "length_required" }, { status: 411 });
  if (declared > MAX_DOCUMENT_BYTES + 512 * 1024) return go("err=doc.too_large");

  const fd = await req.formData().catch(() => null);
  if (!fd) return go("err=portal.invalid");
  const str = (k: string) => String(fd.get(k) ?? "").trim();
  const amount = rupeesToPaise(str("amount"));
  const rate = str("gstRate") === "" ? 0 : percentToBps(str("gstRate"));
  const date = (k: string) => (/^\d{4}-\d{2}-\d{2}$/.test(str(k)) ? str(k) : null);
  const parsed = portalInvoiceInput.safeParse({
    bookingId: str("bookingId") || null,
    number: str("number"),
    invoiceDate: date("invoiceDate"),
    dueDate: date("dueDate"),
    supplierGstin: str("supplierGstin") || null,
    taxType: ["cgst_sgst", "igst"].includes(str("taxType")) ? str("taxType") : "none",
    notes: str("notes") || null,
    lines: [{ serviceId: null, description: str("description"), hsnSac: null, amountPaise: amount, gstRateBps: rate }],
  });
  if (!parsed.success || amount == null || rate == null) return go("err=portal.invalid");

  const db = getDb();
  let invoiceId: string;
  try {
    invoiceId = (await uploadPortalInvoice(db, { eventId: ctx.event.id, vendorId, actor: ctx.actor, invoice: parsed.data })).id;
  } catch (e) {
    if (e instanceof PortalError) return go(`err=portal.${e.code === "not_found" ? "not_found" : "invalid"}`);
    if (e instanceof PaymentError) return go(`err=pay.${["duplicate_number", "invalid_gstin"].includes(e.code) ? e.code : "invalid"}`);
    throw e;
  }
  const file = fd.get("file");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_DOCUMENT_BYTES) return go("saved=1&fileErr=doc.too_large");
    try {
      await saveDocument(db, ctx.event.id, ctx.actor, { owner: { invoiceId }, kind: "invoice", filename: file.name, data: Buffer.from(await file.arrayBuffer()), audience: "vendor" });
    } catch (e) {
      if (e instanceof DocumentError) return go(`saved=1&fileErr=doc.${e.code === "not_found" ? "invalid" : e.code}`);
      throw e;
    }
  }
  return go("saved=1");
}
