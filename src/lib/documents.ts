import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database, Tx } from "@/db";
import { bookings, documentBlobs, documents, invoices, messages, payments, quotes, services, vendors, type DocumentRow } from "@/db/schema";
import { audit, type Actor } from "./audit";
import { documentKey, getStore } from "./storage";
import { runStorageDeletions, queueStorageDeletion } from "./storage-gc";
import { commit, free, reserve, StorageQuotaError, type Audience } from "./storage-quota";

/**
 * Contracts, quotes, invoices and receipts (VND-09, PAY-01/03). New files go to object storage
 * (ADR-0030) and count against the event's storage quota; rows from before M7 keep their bytes
 * in `document_blobs` (ADR-0018) until `scripts/migrate-documents-to-store.ts` moves them.
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
  | { serviceId: string }
  | { messageId: string };

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
  const found = async (t: typeof vendors | typeof quotes | typeof bookings | typeof invoices | typeof payments | typeof services | typeof messages) => {
    const [row] = await tx.select({ id: t.id }).from(t).where(and(eq(t.id, id), eq(t.eventId, eventId)));
    return !!row;
  };
  const table = { vendorId: vendors, quoteId: quotes, bookingId: bookings, invoiceId: invoices, paymentId: payments, serviceId: services, messageId: messages }[key as keyof UnionKeys];
  if (!table || !(await found(table))) throw new DocumentError("invalid");
  return { [key]: id };
}

type UnionKeys = { vendorId: 1; quoteId: 1; bookingId: 1; invoiceId: 1; paymentId: 1; serviceId: 1; messageId: 1 };

export async function saveDocument(
  db: Database,
  eventId: string,
  actor: Actor,
  input: {
    owner: DocumentOwner;
    kind: (typeof DOCUMENT_KINDS)[number];
    filename: string;
    data: Buffer;
    /** Who is uploading, for the storage quota (vendors may use the 10% reserve, LIM-03). */
    audience?: Audience;
  },
) {
  if (input.data.length === 0) throw new DocumentError("invalid");
  if (input.data.length > MAX_DOCUMENT_BYTES) throw new DocumentError("too_large");
  const mime = sniffMime(input.data);
  if (!mime) throw new DocumentError("bad_type");
  const store = getStore();
  const id = randomUUID();
  const key = documentKey(eventId, id);
  let stored = false;
  try {
    return await db.transaction(async (tx) => {
      const ownerCols = await checkOwner(tx, eventId, input.owner);
      // Serialise uploads per event so the quota check holds.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docs:${eventId}`}))`);
      const [{ used }] = await tx
        .select({ used: sql<number>`coalesce(sum(${documents.bytes}), 0)::bigint`.mapWith(Number) })
        .from(documents)
        .where(eq(documents.eventId, eventId));
      if (used + input.data.length > MAX_EVENT_DOCUMENT_BYTES) throw new DocumentError("quota");
      const reservation = await reserve(tx, eventId, input.data.length, input.audience ?? "member");
      const [doc] = await tx
        .insert(documents)
        .values({
          id,
          eventId,
          kind: input.kind,
          ...ownerCols,
          filename: cleanName(input.filename),
          mime,
          bytes: input.data.length,
          sha256: createHash("sha256").update(input.data).digest("hex"),
          storageKey: key,
          uploadedBy: actor.userId,
        })
        .returning();
      // Upload last, inside the transaction: if it fails nothing is recorded.
      await store.put(key, input.data, mime);
      stored = true;
      await commit(tx, eventId, input.data.length, input.data.length, { reservationId: reservation.id });
      await audit(tx, { eventId, actor, action: "document.uploaded", entityType: "document", entityId: doc.id, data: { name: doc.filename, kind: doc.kind } });
      return doc;
    });
  } catch (e) {
    // The row didn't commit, so the object would be an orphan.
    if (stored) await store.delete(key).catch(() => undefined);
    if (e instanceof StorageQuotaError) throw new DocumentError("quota");
    throw e;
  }
}

/** A document with its bytes, from object storage or (older rows) from document_blobs. */
export async function getDocument(db: Tx, eventId: string, documentId: string): Promise<{ doc: DocumentRow; data: Buffer }> {
  const [doc] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.eventId, eventId)));
  if (!doc) throw new DocumentError("not_found");
  return { doc, data: await documentBytes(db, doc) };
}

/** The bytes of a document row (store first, legacy table as fallback). */
export async function documentBytes(db: Tx, doc: Pick<DocumentRow, "id" | "storageKey">): Promise<Buffer> {
  if (doc.storageKey) {
    const data = await getStore().getBytes(doc.storageKey);
    if (!data) throw new DocumentError("not_found");
    return data;
  }
  const [row] = await db.select({ data: documentBlobs.data }).from(documentBlobs).where(eq(documentBlobs.documentId, doc.id));
  if (!row) throw new DocumentError("not_found");
  return row.data;
}

export async function listDocuments(db: Tx, eventId: string, owner: DocumentOwner): Promise<DocumentRow[]> {
  const [[key, id]] = Object.entries(owner) as [keyof DocumentOwner & string, string][];
  const col = {
    vendorId: documents.vendorId,
    quoteId: documents.quoteId,
    bookingId: documents.bookingId,
    invoiceId: documents.invoiceId,
    paymentId: documents.paymentId,
    serviceId: documents.serviceId,
    messageId: documents.messageId,
  }[key];
  return db
    .select()
    .from(documents)
    .where(and(eq(documents.eventId, eventId), eq(col, id)))
    .orderBy(desc(documents.createdAt));
}

/**
 * Chat attachments have their own access rules (thread audience), and legacy received-gift
 * photos (ADR-0036) are no longer shown, so the planning-documents route and action skip both.
 */
export function isPlanningDocument(doc: Pick<DocumentRow, "giftId" | "messageId">) {
  return !doc.giftId && !doc.messageId;
}

export async function deleteDocument(db: Database, eventId: string, actor: Actor, documentId: string, opts: { planningOnly?: boolean } = {}) {
  const queued = await db.transaction(async (tx) => {
    const [doc] = await tx
      .delete(documents)
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.eventId, eventId),
          opts.planningOnly ? and(isNull(documents.giftId), isNull(documents.messageId)) : undefined,
        ),
      )
      .returning();
    if (!doc) throw new DocumentError("not_found");
    await free(tx, eventId, doc.bytes);
    await audit(tx, { eventId, actor, action: "document.deleted", entityType: "document", entityId: doc.id, data: { name: doc.filename } });
    return doc.storageKey ? [await queueStorageDeletion(tx, doc.storageKey, "document")] : [];
  });
  await runStorageDeletions(db, getStore(), queued);
}
