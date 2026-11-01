import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, max, ne } from "drizzle-orm";
import { z } from "zod";
import type { Database, Tx } from "@/db";
import {
  functions,
  quoteLines,
  quoteRequests,
  quoteRequestServices,
  quotes,
  requirements,
  serviceTypes,
  services,
  vendors,
  type Quote,
  type QuoteLine,
} from "@/db/schema";
import { audit, type Actor } from "./audit";
import { allocate, gstFor } from "./money";

export class QuoteError extends Error {
  constructor(public code: "not_found" | "not_approved" | "invalid" | "allocation_mismatch" | "no_lines" | "declined") {
    super(code);
  }
}

/** Services that can be sent for quotes: approved, not cancelled (SVC-10). */
async function quotableServices(tx: Tx, eventId: string, serviceIds: string[]) {
  const ids = [...new Set(serviceIds)];
  if (ids.length === 0) throw new QuoteError("invalid");
  const rows = await tx
    .select({ id: services.id, approvalState: services.approvalState, cancelledAt: services.cancelledAt })
    .from(services)
    .where(and(eq(services.eventId, eventId), inArray(services.id, ids)));
  if (rows.length !== ids.length) throw new QuoteError("not_found");
  if (rows.some((r) => r.approvalState !== "approved" || r.cancelledAt)) throw new QuoteError("not_approved");
  return ids;
}

async function assertVendor(tx: Tx, eventId: string, vendorId: string) {
  const [v] = await tx.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.id, vendorId), eq(vendors.eventId, eventId)));
  if (!v) throw new QuoteError("not_found");
}

// ---------------------------------------------------------------------------
// Quote requests (VND-02)
// ---------------------------------------------------------------------------

/** One request per vendor, each covering the same services (from any functions, of any type). */
export async function createQuoteRequests(
  db: Database,
  eventId: string,
  actor: Actor,
  input: { vendorIds: string[]; serviceIds: string[]; dueDate: string | null; message: string | null },
) {
  const vendorIds = [...new Set(input.vendorIds)];
  if (vendorIds.length === 0) throw new QuoteError("invalid");
  return db.transaction(async (tx) => {
    const serviceIds = await quotableServices(tx, eventId, input.serviceIds);
    const created: string[] = [];
    for (const vendorId of vendorIds) {
      await assertVendor(tx, eventId, vendorId);
      const [r] = await tx
        .insert(quoteRequests)
        .values({ eventId, vendorId, dueDate: input.dueDate, message: input.message?.trim() || null, createdBy: actor.userId })
        .returning();
      await tx.insert(quoteRequestServices).values(serviceIds.map((serviceId) => ({ requestId: r.id, serviceId, eventId })));
      created.push(r.id);
    }
    return created;
  });
}

export async function closeQuoteRequest(db: Database, eventId: string, requestId: string, closed: boolean) {
  const [r] = await db
    .update(quoteRequests)
    .set({ closedAt: closed ? new Date() : null })
    .where(and(eq(quoteRequests.id, requestId), eq(quoteRequests.eventId, eventId)))
    .returning({ id: quoteRequests.id });
  if (!r) throw new QuoteError("not_found");
}

/** A request with its vendor and services, each with the live requirements: the vendor brief. */
export async function getQuoteRequest(db: Tx, eventId: string, requestId: string) {
  const [r] = await db
    .select({ request: quoteRequests, vendorName: vendors.name })
    .from(quoteRequests)
    .innerJoin(vendors, eq(vendors.id, quoteRequests.vendorId))
    .where(and(eq(quoteRequests.id, requestId), eq(quoteRequests.eventId, eventId)));
  if (!r) throw new QuoteError("not_found");
  const svc = await db
    .select({ service: services, typeName: serviceTypes.name, typeKey: serviceTypes.systemKey, fn: functions })
    .from(quoteRequestServices)
    .innerJoin(services, eq(services.id, quoteRequestServices.serviceId))
    .innerJoin(serviceTypes, eq(serviceTypes.id, services.serviceTypeId))
    .innerJoin(functions, eq(functions.id, services.functionId))
    .where(eq(quoteRequestServices.requestId, r.request.id))
    .orderBy(asc(functions.date), asc(functions.startTime), asc(services.sortOrder));
  const reqs = svc.length
    ? await db
        .select()
        .from(requirements)
        .where(
          and(
            inArray(requirements.serviceId, svc.map((s) => s.service.id)),
            eq(requirements.approvalState, "approved"),
            ne(requirements.lifecycle, "cancelled"),
          ),
        )
        .orderBy(asc(requirements.sortOrder))
    : [];
  const qs = await db
    .select()
    .from(quotes)
    .where(and(eq(quotes.eventId, eventId), eq(quotes.requestId, r.request.id)))
    .orderBy(desc(quotes.version));
  return {
    ...r,
    services: svc.map((s) => ({ ...s, requirements: reqs.filter((q) => q.serviceId === s.service.id) })),
    quotes: qs,
  };
}

export async function listQuoteRequests(db: Tx, eventId: string, opts: { vendorId?: string; serviceId?: string } = {}) {
  const rows = await db
    .select({ request: quoteRequests, vendorName: vendors.name })
    .from(quoteRequests)
    .innerJoin(vendors, eq(vendors.id, quoteRequests.vendorId))
    .where(and(eq(quoteRequests.eventId, eventId), opts.vendorId ? eq(quoteRequests.vendorId, opts.vendorId) : undefined))
    .orderBy(desc(quoteRequests.createdAt));
  const links = rows.length
    ? await db
        .select({ requestId: quoteRequestServices.requestId, serviceId: quoteRequestServices.serviceId })
        .from(quoteRequestServices)
        .where(inArray(quoteRequestServices.requestId, rows.map((r) => r.request.id)))
    : [];
  return rows
    .map((r) => ({ ...r, serviceIds: links.filter((l) => l.requestId === r.request.id).map((l) => l.serviceId) }))
    .filter((r) => !opts.serviceId || r.serviceIds.includes(opts.serviceId));
}

// ---------------------------------------------------------------------------
// Quotes (VND-03/04/07): entered by the team on the vendor's behalf until the vendor portal (M6)
// ---------------------------------------------------------------------------

export const lineInput = z.object({
  scope: z.enum(["requirement", "service", "package"]),
  serviceId: z.string().uuid().nullable(),
  requirementId: z.string().uuid().nullable(),
  description: z.string().trim().max(300).nullable(),
  quantity: z.number().int().min(0).max(1_000_000).nullable(),
  amountPaise: z.number().int().min(-1e12).max(1e12),
  gstRateBps: z.number().int().min(0).max(10_000),
  conditional: z.boolean().default(false),
  allocation: z.record(z.string(), z.number().int()).nullable().default(null),
});
export type LineInput = z.infer<typeof lineInput>;

export const quoteInput = z.object({
  vendorRef: z.string().trim().max(80).nullable(),
  receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  terms: z.string().trim().max(4000).nullable(),
  taxType: z.enum(["none", "cgst_sgst", "igst"]),
  allOrNothing: z.boolean(),
  minFunctions: z.number().int().min(2).max(50).nullable(),
  lines: z.array(lineInput).max(300),
});
export type QuoteInput = z.infer<typeof quoteInput>;

/**
 * Saves a quote for a request. With `reviseQuoteId`, saves a new version of that quote
 * (the old version stays viewable; bookings keep pointing at the version they accepted).
 */
export async function saveQuote(
  db: Database,
  eventId: string,
  actor: Actor,
  target: { requestId: string; reviseQuoteId?: string | null },
  input: QuoteInput,
) {
  const lines = input.lines.filter((l) => l.amountPaise !== 0 || l.quantity);
  if (lines.length === 0) throw new QuoteError("no_lines");
  return db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(quoteRequests)
      .where(and(eq(quoteRequests.id, target.requestId), eq(quoteRequests.eventId, eventId)));
    if (!request) throw new QuoteError("not_found");
    const linked = await tx.select({ serviceId: quoteRequestServices.serviceId }).from(quoteRequestServices).where(eq(quoteRequestServices.requestId, request.id));
    const allowed = new Set(linked.map((l) => l.serviceId));

    // Every line must point at this request's services and their live requirements.
    const reqIds = lines.filter((l) => l.scope === "requirement").map((l) => l.requirementId!);
    const reqRows = reqIds.length
      ? await tx
          .select({ id: requirements.id, serviceId: requirements.serviceId, approvalState: requirements.approvalState, lifecycle: requirements.lifecycle })
          .from(requirements)
          .where(and(eq(requirements.eventId, eventId), inArray(requirements.id, reqIds)))
      : [];
    for (const l of lines) {
      if (l.scope === "package") {
        if (l.serviceId || l.requirementId) throw new QuoteError("invalid");
        if (l.allocation) {
          const keys = Object.keys(l.allocation);
          if (keys.some((k) => !allowed.has(k))) throw new QuoteError("invalid");
          if (Object.values(l.allocation).reduce((a, b) => a + b, 0) !== l.amountPaise) throw new QuoteError("allocation_mismatch");
        }
        continue;
      }
      if (!l.serviceId || !allowed.has(l.serviceId)) throw new QuoteError("invalid");
      if (l.scope === "requirement") {
        const r = reqRows.find((x) => x.id === l.requirementId);
        if (!r || r.serviceId !== l.serviceId) throw new QuoteError("invalid");
        if (r.approvalState !== "approved" || r.lifecycle === "cancelled") throw new QuoteError("not_approved");
      } else if (l.requirementId) throw new QuoteError("invalid");
    }

    let rootId: string | null = null;
    let version = 1;
    if (target.reviseQuoteId) {
      const [prev] = await tx
        .select()
        .from(quotes)
        .where(and(eq(quotes.id, target.reviseQuoteId), eq(quotes.eventId, eventId), eq(quotes.requestId, request.id)));
      if (!prev) throw new QuoteError("not_found");
      rootId = prev.rootId;
      const [{ m }] = await tx.select({ m: max(quotes.version) }).from(quotes).where(eq(quotes.rootId, prev.rootId));
      version = (m ?? prev.version) + 1;
    }
    const { lines: _lines, ...head } = input;
    void _lines;
    const id = randomUUID();
    const [q] = await tx
      .insert(quotes)
      .values({ id, eventId, vendorId: request.vendorId, requestId: request.id, rootId: rootId ?? id, version, createdBy: actor.userId, ...head })
      .returning();
    await tx.insert(quoteLines).values(
      lines.map((l, i) => ({
        eventId,
        quoteId: q.id,
        scope: l.scope,
        serviceId: l.scope === "package" ? null : l.serviceId,
        requirementId: l.scope === "requirement" ? l.requirementId : null,
        description: l.description || null,
        quantity: l.quantity,
        amountPaise: l.amountPaise,
        gstRateBps: l.gstRateBps,
        conditional: l.scope === "package" ? l.conditional : false,
        allocation: l.scope === "package" ? l.allocation : null,
        sortOrder: i + 1,
      })),
    );
    await audit(tx, {
      eventId,
      actor,
      action: version > 1 ? "quote.revised" : "quote.added",
      entityType: "quote",
      entityId: q.id,
      data: { version },
    });
    return q;
  });
}

export async function declineQuote(db: Database, eventId: string, quoteId: string, declined: boolean) {
  const [q] = await db
    .update(quotes)
    .set({ declinedAt: declined ? new Date() : null })
    .where(and(eq(quotes.id, quoteId), eq(quotes.eventId, eventId)))
    .returning({ id: quotes.id });
  if (!q) throw new QuoteError("not_found");
}

// ---------------------------------------------------------------------------
// Allocation and totals
// ---------------------------------------------------------------------------

export type Priced = { amount: number; gst: number };

/**
 * Splits package-level lines over services (VND-04): a manual allocation if it only names
 * the chosen services, else proportional to each chosen service's own line amounts.
 * Returns serviceId -> amount for every package line, so every rupee lands on a service.
 */
export function allocatePackages(lines: QuoteLine[], serviceIds: string[]): Map<string, Map<string, number>> {
  const own = new Map<string, number>(serviceIds.map((id) => [id, 0]));
  for (const l of lines) if (l.scope !== "package" && l.serviceId && own.has(l.serviceId)) own.set(l.serviceId, own.get(l.serviceId)! + Math.max(0, l.amountPaise));
  const ids = [...own.keys()];
  const out = new Map<string, Map<string, number>>();
  for (const l of lines) {
    if (l.scope !== "package") continue;
    const manual = l.allocation;
    if (manual) {
      const keys = Object.keys(manual);
      if (keys.length === ids.length && keys.every((k) => own.has(k))) {
        out.set(l.id, new Map(ids.map((id) => [id, manual[id]])));
        continue;
      }
      // Manual split naming services that aren't all chosen: re-spread by its weights.
      const weights = ids.map((id) => Math.max(0, manual[id] ?? 0));
      if (weights.some((w) => w > 0)) {
        const parts = allocate(l.amountPaise, weights);
        out.set(l.id, new Map(ids.map((id, i) => [id, parts[i]])));
        continue;
      }
    }
    const parts = allocate(l.amountPaise, ids.map((id) => own.get(id)!));
    out.set(l.id, new Map(ids.map((id, i) => [id, parts[i]])));
  }
  return out;
}

/** Tax on one line under the quote's GST type. */
export const lineGst = (l: Pick<QuoteLine, "amountPaise" | "gstRateBps">, taxType: Quote["taxType"]) => gstFor(l.amountPaise, l.gstRateBps, taxType).tax;

/** Splits a line's GST by the same weights as its amount, so tax also adds up exactly. */
export function splitGst(total: number, parts: number[]): number[] {
  return allocate(total, parts.map((p) => Math.abs(p)));
}

export type QuoteView = Awaited<ReturnType<typeof getQuote>>;

/** A quote with lines, per-service totals (incl. package allocations) and its versions. */
export async function getQuote(db: Tx, eventId: string, quoteId: string) {
  const [q] = await db
    .select({ quote: quotes, vendorName: vendors.name, vendorGstin: vendors.gstin })
    .from(quotes)
    .innerJoin(vendors, eq(vendors.id, quotes.vendorId))
    .where(and(eq(quotes.id, quoteId), eq(quotes.eventId, eventId)));
  if (!q) throw new QuoteError("not_found");
  const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, q.quote.id)).orderBy(asc(quoteLines.sortOrder));
  const versions = await db
    .select({ id: quotes.id, version: quotes.version, createdAt: quotes.createdAt })
    .from(quotes)
    .where(eq(quotes.rootId, q.quote.rootId))
    .orderBy(asc(quotes.version));
  const serviceIds = [...new Set(lines.map((l) => l.serviceId).filter((x): x is string => !!x))];
  const svc = serviceIds.length
    ? await db
        .select({ id: services.id, name: services.name, typeName: serviceTypes.name, typeKey: serviceTypes.systemKey, categoryId: serviceTypes.id, functionId: functions.id, functionName: functions.name, functionDate: functions.date })
        .from(services)
        .innerJoin(serviceTypes, eq(serviceTypes.id, services.serviceTypeId))
        .innerJoin(functions, eq(functions.id, services.functionId))
        .where(inArray(services.id, serviceIds))
        .orderBy(asc(functions.date), asc(functions.startTime))
    : [];
  const reqIds = lines.map((l) => l.requirementId).filter((x): x is string => !!x);
  const reqs = reqIds.length ? await db.select().from(requirements).where(inArray(requirements.id, reqIds)) : [];
  const alloc = allocatePackages(lines, svc.map((s) => s.id));
  const totals = svc.map((s) => {
    let amount = 0;
    let gst = 0;
    for (const l of lines) {
      const g = lineGst(l, q.quote.taxType);
      if (l.serviceId === s.id) {
        amount += l.amountPaise;
        gst += g;
      } else if (l.scope === "package") {
        const parts = alloc.get(l.id)!;
        const ids = [...parts.keys()];
        const gs = splitGst(g, ids.map((id) => parts.get(id)!));
        amount += parts.get(s.id) ?? 0;
        gst += gs[ids.indexOf(s.id)] ?? 0;
      }
    }
    return { ...s, amount, gst };
  });
  const subtotal = lines.reduce((a, l) => a + l.amountPaise, 0);
  const gst = lines.reduce((a, l) => a + lineGst(l, q.quote.taxType), 0);
  const latest = versions[versions.length - 1]?.id === q.quote.id;
  return { ...q, lines, versions, services: totals, requirements: reqs, allocation: alloc, subtotal, gst, total: subtotal + gst, latest };
}

/** Latest version of each quote that has lines for a service (VND-05 per-service comparison). */
export async function compareForService(db: Tx, eventId: string, serviceId: string) {
  const ids = await db
    .selectDistinct({ quoteId: quoteLines.quoteId })
    .from(quoteLines)
    .where(and(eq(quoteLines.eventId, eventId), eq(quoteLines.serviceId, serviceId)));
  const views = await Promise.all(ids.map((i) => getQuote(db, eventId, i.quoteId)));
  const reqs = await db
    .select()
    .from(requirements)
    .where(and(eq(requirements.serviceId, serviceId), eq(requirements.approvalState, "approved"), ne(requirements.lifecycle, "cancelled")))
    .orderBy(asc(requirements.sortOrder));
  return {
    requirements: reqs,
    quotes: views
      .filter((v) => v.latest)
      .map((v) => {
        const mine = v.services.find((s) => s.id === serviceId)!;
        const perReq = reqs.map((r) => {
          const ls = v.lines.filter((l) => l.requirementId === r.id);
          const qty = ls.some((l) => l.quantity == null) ? null : ls.reduce((a, l) => a + (l.quantity ?? 0), 0);
          return {
            requirementId: r.id,
            covered: ls.length > 0,
            quantity: qty,
            full: ls.length > 0 && (qty == null || r.quantity == null || qty >= r.quantity),
            amount: ls.reduce((a, l) => a + l.amountPaise, 0),
          };
        });
        return {
          quote: v.quote,
          vendorName: v.vendorName,
          amount: mine.amount,
          gst: mine.gst,
          total: mine.amount + mine.gst,
          partOfPackage: v.services.length > 1,
          packageTotal: v.total,
          perRequirement: perReq,
          missing: perReq.filter((p) => !p.full).length,
        };
      })
      .sort((a, b) => Number(!!a.quote.declinedAt) - Number(!!b.quote.declinedAt) || a.total - b.total),
  };
}

/**
 * VND-05 per package: other quotes covering any of this quote's services, side by side, and
 * the cheapest single-service quotes that fully cover each service ("best individual").
 */
export async function comparePackage(db: Tx, eventId: string, quoteId: string) {
  const base = await getQuote(db, eventId, quoteId);
  const serviceIds = base.services.map((s) => s.id);
  const ids = serviceIds.length
    ? await db
        .selectDistinct({ quoteId: quoteLines.quoteId })
        .from(quoteLines)
        .innerJoin(quotes, eq(quotes.id, quoteLines.quoteId))
        .where(and(eq(quoteLines.eventId, eventId), inArray(quoteLines.serviceId, serviceIds), isNull(quotes.declinedAt)))
    : [];
  const views = (await Promise.all(ids.map((i) => getQuote(db, eventId, i.quoteId)))).filter((v) => v.latest);
  const perService = await Promise.all(serviceIds.map((id) => compareForService(db, eventId, id)));
  const best = serviceIds.map((id, i) => {
    const singles = perService[i].quotes.filter((q) => !q.partOfPackage && q.missing === 0 && !q.quote.declinedAt);
    const pick = singles.sort((a, b) => a.total - b.total)[0] ?? null;
    return { serviceId: id, quoteId: pick?.quote.id ?? null, vendorName: pick?.vendorName ?? null, total: pick?.total ?? null };
  });
  return {
    base,
    columns: views
      .map((v) => ({
        quote: v.quote,
        vendorName: v.vendorName,
        total: v.total,
        perService: serviceIds.map((id) => {
          const s = v.services.find((x) => x.id === id);
          return s ? s.amount + s.gst : null;
        }),
      }))
      .sort((a, b) => a.total - b.total),
    best,
    bestTotal: best.every((b) => b.total != null) ? best.reduce((a, b) => a + (b.total ?? 0), 0) : null,
    uncovered: best.filter((b) => b.total == null).map((b) => b.serviceId),
  };
}

export async function listQuotes(db: Tx, eventId: string, opts: { vendorId?: string } = {}) {
  return db
    .select({ quote: quotes, vendorName: vendors.name })
    .from(quotes)
    .innerJoin(vendors, eq(vendors.id, quotes.vendorId))
    .where(and(eq(quotes.eventId, eventId), opts.vendorId ? eq(quotes.vendorId, opts.vendorId) : undefined))
    .orderBy(desc(quotes.createdAt));
}
