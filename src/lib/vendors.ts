import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Database, Tx } from "@/db";
import { serviceTypes, vendorServiceTypes, vendors, type Vendor } from "@/db/schema";
import { audit, type Actor } from "./audit";
import { decryptField, encryptField } from "./crypto";
import { isValidGstin, isValidPan } from "./money";

export class VendorError extends Error {
  constructor(public code: "not_found" | "invalid_gstin" | "invalid_pan" | "has_bookings" | "invalid") {
    super(code);
  }
}

const opt = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v));

export const vendorSchema = z.object({
  name: z.string().trim().min(1).max(120),
  contactName: opt(120),
  phone: opt(30),
  email: opt(200).refine((v) => v === null || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), "email"),
  gstin: opt(15).transform((v) => (v ? v.toUpperCase() : v)),
  notes: opt(2000),
  serviceTypeIds: z.array(z.string().uuid()).max(30),
});
export type VendorInput = z.infer<typeof vendorSchema>;

/** Bank details are only typed in full when changed; they are stored encrypted (ADR-0019). */
export const bankSchema = z.object({
  accountName: z.string().trim().max(120),
  accountNumber: z.string().trim().regex(/^\d{6,20}$/),
  ifsc: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/),
  upi: z.string().trim().max(100),
});
export type BankDetails = z.infer<typeof bankSchema>;

function validate(input: VendorInput) {
  if (input.gstin && !isValidGstin(input.gstin)) throw new VendorError("invalid_gstin");
}

async function setTypes(tx: Tx, eventId: string, vendorId: string, typeIds: string[]) {
  const ids = [...new Set(typeIds)];
  if (ids.length) {
    const ok = await tx.select({ id: serviceTypes.id }).from(serviceTypes).where(and(eq(serviceTypes.eventId, eventId), inArray(serviceTypes.id, ids)));
    if (ok.length !== ids.length) throw new VendorError("invalid");
  }
  await tx.delete(vendorServiceTypes).where(eq(vendorServiceTypes.vendorId, vendorId));
  if (ids.length) await tx.insert(vendorServiceTypes).values(ids.map((serviceTypeId) => ({ vendorId, serviceTypeId, eventId })));
}

export async function createVendor(db: Database, eventId: string, actor: Actor, input: VendorInput) {
  validate(input);
  return db.transaction(async (tx) => {
    const { serviceTypeIds, ...rest } = input;
    const [v] = await tx.insert(vendors).values({ eventId, ...rest }).returning();
    await setTypes(tx, eventId, v.id, serviceTypeIds);
    await audit(tx, { eventId, actor, action: "vendor.created", entityType: "vendor", entityId: v.id, data: { name: v.name } });
    return v;
  });
}

export async function updateVendor(db: Database, eventId: string, vendorId: string, input: VendorInput) {
  validate(input);
  await db.transaction(async (tx) => {
    const { serviceTypeIds, ...rest } = input;
    const [v] = await tx
      .update(vendors)
      .set({ ...rest, updatedAt: new Date() })
      .where(and(eq(vendors.id, vendorId), eq(vendors.eventId, eventId)))
      .returning();
    if (!v) throw new VendorError("not_found");
    await setTypes(tx, eventId, v.id, serviceTypeIds);
  });
}

/** Sets PAN and/or bank details (encrypted). Audited; values themselves never go into the log. */
export async function setVendorSecrets(db: Database, eventId: string, vendorId: string, actor: Actor, input: { pan?: string | null; bank?: BankDetails | null }) {
  const set: Partial<Vendor> = { updatedAt: new Date() };
  if (input.pan !== undefined) {
    const pan = input.pan?.trim().toUpperCase() || null;
    if (pan && !isValidPan(pan)) throw new VendorError("invalid_pan");
    set.panEnc = pan ? encryptField(pan, `vendor:${vendorId}:pan`) : null;
    set.panLast4 = pan ? pan.slice(-4) : null;
  }
  if (input.bank !== undefined) {
    set.bankEnc = input.bank ? encryptField(JSON.stringify(input.bank), `vendor:${vendorId}:bank`) : null;
    set.bankLast4 = input.bank ? input.bank.accountNumber.slice(-4) : null;
  }
  await db.transaction(async (tx) => {
    const [v] = await tx
      .update(vendors)
      .set(set)
      .where(and(eq(vendors.id, vendorId), eq(vendors.eventId, eventId)))
      .returning({ id: vendors.id, name: vendors.name });
    if (!v) throw new VendorError("not_found");
    await audit(tx, {
      eventId,
      actor,
      action: "vendor.secrets_changed",
      entityType: "vendor",
      entityId: v.id,
      data: { name: v.name, pan: input.pan !== undefined, bank: input.bank !== undefined },
    });
  });
}

/** Full PAN and bank details. Callers must require a recent step-up (EVT-01d); every view is audited. */
export async function revealVendorSecrets(db: Database, eventId: string, vendorId: string, actor: Actor) {
  return db.transaction(async (tx) => {
    const [v] = await tx.select().from(vendors).where(and(eq(vendors.id, vendorId), eq(vendors.eventId, eventId)));
    if (!v) throw new VendorError("not_found");
    await audit(tx, { eventId, actor, action: "vendor.bank_viewed", entityType: "vendor", entityId: v.id, data: { name: v.name } });
    return {
      pan: v.panEnc ? decryptField(v.panEnc, `vendor:${v.id}:pan`) : null,
      bank: v.bankEnc ? (JSON.parse(decryptField(v.bankEnc, `vendor:${v.id}:bank`)) as BankDetails) : null,
    };
  });
}

export async function setRating(db: Database, eventId: string, vendorId: string, rating: number | null, note: string | null) {
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) throw new VendorError("invalid");
  const [v] = await db
    .update(vendors)
    .set({ rating, ratingNote: note?.trim() || null, updatedAt: new Date() })
    .where(and(eq(vendors.id, vendorId), eq(vendors.eventId, eventId)))
    .returning({ id: vendors.id });
  if (!v) throw new VendorError("not_found");
}

export async function archiveVendor(db: Database, eventId: string, vendorId: string, archived: boolean) {
  const [v] = await db
    .update(vendors)
    .set({ archivedAt: archived ? new Date() : null })
    .where(and(eq(vendors.id, vendorId), eq(vendors.eventId, eventId)))
    .returning({ id: vendors.id });
  if (!v) throw new VendorError("not_found");
}

/** Deletes a vendor with no bookings or invoices (those keep the vendor via the FK). */
export async function deleteVendor(db: Database, eventId: string, vendorId: string, actor: Actor) {
  try {
    await db.transaction(async (tx) => {
      const [v] = await tx
        .delete(vendors)
        .where(and(eq(vendors.id, vendorId), eq(vendors.eventId, eventId)))
        .returning();
      if (!v) throw new VendorError("not_found");
      await audit(tx, { eventId, actor, action: "vendor.deleted", entityType: "vendor", entityId: v.id, data: { name: v.name } });
    });
  } catch (e) {
    if (isFkViolation(e)) throw new VendorError("has_bookings");
    throw e;
  }
}

export function isFkViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === "23503" || err?.cause?.code === "23503";
}

export type VendorListItem = Vendor & { typeIds: string[] };

export async function listVendors(db: Tx, eventId: string, opts: { includeArchived?: boolean; serviceTypeId?: string } = {}): Promise<VendorListItem[]> {
  const rows = await db
    .select()
    .from(vendors)
    .where(and(eq(vendors.eventId, eventId), opts.includeArchived ? undefined : isNull(vendors.archivedAt)))
    .orderBy(asc(vendors.name));
  const links = rows.length
    ? await db.select().from(vendorServiceTypes).where(inArray(vendorServiceTypes.vendorId, rows.map((r) => r.id)))
    : [];
  return rows
    .map((v) => ({ ...v, typeIds: links.filter((l) => l.vendorId === v.id).map((l) => l.serviceTypeId) }))
    .filter((v) => !opts.serviceTypeId || v.typeIds.includes(opts.serviceTypeId));
}

export async function getVendor(db: Tx, eventId: string, vendorId: string): Promise<VendorListItem> {
  const [v] = await db.select().from(vendors).where(and(eq(vendors.id, vendorId), eq(vendors.eventId, eventId)));
  if (!v) throw new VendorError("not_found");
  const links = await db.select().from(vendorServiceTypes).where(eq(vendorServiceTypes.vendorId, v.id));
  return { ...v, typeIds: links.map((l) => l.serviceTypeId) };
}
