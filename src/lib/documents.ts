import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database, Tx } from "@/db";
import { bookings, documentBlobs, documents, invoices, payments, quotes, services, vendors, type DocumentRow } from "@/db/schema";
import { audit, type Actor } from "./audit";

/**
 * Contracts, quotes, invoices and receipts (VND-09, PAY-01/03). Stored in Postgres behind this
 * module (ADR-0018) until object storage arrives with the gallery (M7).
 */
/**
 * Per-file limit. 20 MB by default; 4 MB on Vercel, whose functions refuse request bodies over
 * 4.5 MB (ADR-0021). Override with MAX_DOCUMENT_MB. Larger files need object storage (M7).
 */
export const MAX_DOCUMENT_MB = Math.max(1, Math.min(20, Number(process.env.MAX_DOCUMENT_MB) || (process.env.VERCEL ? 4 : 20)));
export const MAX_DOCUMENT_BYTES = MAX_DOCUMENT_MB * 1024 * 1024;
export const MAX_EVENT_DOCUMENT_BYTES = 500 * 1024 * 1024;

export class DocumentError extends Error {
  constructor(public code: "not_found" | "too_large" | "bad_type" | "quota" | "invalid") {
    super(code);
  }
}

export type DocumentOwner =
  | { vendorId: string }
  | { quoteId: string }
  | { bookingId: string }
  | { invoiceId: string }
  | { paymentId: string }
  | { serviceId: string };

export const DOCUMENT_KINDS = ["contract", "quote", "invoice", "receipt", "brief", "other"] as const;

/** Recognises PDF, JPEG, PNG, WebP and HEIC by their first bytes (the browser's type isn't trusted). */
export function sniffMime(data: Buffer): string | null {
  if (data.length < 12) return null;
  if (data.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (data.subarray(4, 8).toString("latin1") === "ftyp" && /^(heic|heix|mif1|msf1|hevc)$/.test(data.subarray(8, 12).toString("latin1"))) return "image/heic";
  return null;
}

const cleanName = (name: string) =>
  name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim()
    .slice(-120) || "document";

async function checkOwner(tx: Tx, eventId: string, owner: DocumentOwner): Promise<Partial<Record<keyof UnionKeys, string>>> {
  const [[key, id]] = Object.entries(owner) as [string, string][];
  const found = async (t: typeof vendors | typeof quotes | typeof bookings | typeof invoices | typeof payments | typeof services) => {
    const [row] = await tx.select({ id: t.id }).from(t).where(and(eq(t.id, id), eq(t.eventId, eventId)));
    return !!row;
  };
  const table = { vendorId: vendors, quoteId: quotes, bookingId: bookings, invoiceId: invoices, paymentId: payments, serviceId: services }[key as keyof UnionKeys];
  if (!table || !(await found(table))) throw new DocumentError("invalid");
  return { [key]: id };
}

type UnionKeys = { vendorId: 1; quoteId: 1; bookingId: 1; invoiceId: 1; paymentId: 1; serviceId: 1 };

export async function saveDocument(
  db: Database,
  eventId: string,
  actor: Actor,
  input: { owner: DocumentOwner; kind: (typeof DOCUMENT_KINDS)[number]; filename: string; data: Buffer },
) {
  if (input.data.length === 0) throw new DocumentError("invalid");
  if (input.data.length > MAX_DOCUMENT_BYTES) throw new DocumentError("too_large");
  const mime = sniffMime(input.data);
  if (!mime) throw new DocumentError("bad_type");
  return db.transaction(async (tx) => {
    const ownerCols = await checkOwner(tx, eventId, input.owner);
    // Serialise uploads per event so the quota check holds.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docs:${eventId}`}))`);
    const [{ used }] = await tx
      .select({ used: sql<number>`coalesce(sum(${documents.bytes}), 0)::bigint`.mapWith(Number) })
      .from(documents)
      .where(eq(documents.eventId, eventId));
    if (used + input.data.length > MAX_EVENT_DOCUMENT_BYTES) throw new DocumentError("quota");
    const [doc] = await tx
      .insert(documents)
      .values({
        eventId,
        kind: input.kind,
        ...ownerCols,
        filename: cleanName(input.filename),
        mime,
        bytes: input.data.length,
        sha256: createHash("sha256").update(input.data).digest("hex"),
        uploadedBy: actor.userId,
      })
      .returning();
    await tx.insert(documentBlobs).values({ documentId: doc.id, data: input.data });
    await audit(tx, { eventId, actor, action: "document.uploaded", entityType: "document", entityId: doc.id, data: { name: doc.filename, kind: doc.kind } });
    return doc;
  });
}

export async function getDocument(db: Tx, eventId: string, documentId: string) {
  const [row] = await db
    .select({ doc: documents, data: documentBlobs.data })
    .from(documents)
    .innerJoin(documentBlobs, eq(documentBlobs.documentId, documents.id))
    .where(and(eq(documents.id, documentId), eq(documents.eventId, eventId)));
  if (!row) throw new DocumentError("not_found");
  return row;
}

export async function listDocuments(db: Tx, eventId: string, owner: DocumentOwner): Promise<DocumentRow[]> {
  const [[key, id]] = Object.entries(owner) as [keyof DocumentOwner & string, string][];
  const col = { vendorId: documents.vendorId, quoteId: documents.quoteId, bookingId: documents.bookingId, invoiceId: documents.invoiceId, paymentId: documents.paymentId, serviceId: documents.serviceId }[key];
  return db
    .select()
    .from(documents)
    .where(and(eq(documents.eventId, eventId), eq(col, id)))
    .orderBy(desc(documents.createdAt));
}

export async function deleteDocument(db: Database, eventId: string, actor: Actor, documentId: string) {
  await db.transaction(async (tx) => {
    const [doc] = await tx.delete(documents).where(and(eq(documents.id, documentId), eq(documents.eventId, eventId))).returning();
    if (!doc) throw new DocumentError("not_found");
    await audit(tx, { eventId, actor, action: "document.deleted", entityType: "document", entityId: doc.id, data: { name: doc.filename } });
  });
}
