import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, Tx } from "@/db";
import {
  bookings,
  documents,
  eventMembers,
  events,
  fulfilments,
  functions,
  invoices,
  quoteRequestServices,
  quoteRequests,
  quotes,
  requirements,
  runSheetItems,
  serviceTypes,
  services,
  users,
  vendors,
  type BookingStatus,
  type DocumentRow,
} from "@/db/schema";
import { isLocale, translateDynamic } from "@/i18n/core";
import type { Actor } from "./audit";
import { notify } from "./notifications";
import { bookingFinance, createInvoice, invoiceLineInput, listInvoices, type PayStatus } from "./payments";
import { getQuote, saveQuote, type QuoteInput } from "./quotes";
import { vendorUserIds } from "./vendor-access";

/**
 * The vendor portal's reads and actions (VND-10, ADR-0023). Every function takes the event and
 * the vendor, and everything is reached through this vendor's own quote requests and bookings.
 * Ids coming from the vendor are re-checked against that scope; anything else is "not found".
 * Vendors never see budget estimates, payers, other vendors or guest data.
 */

export class PortalError extends Error {
  constructor(public code: "not_found" | "closed" | "invalid") {
    super(code);
  }
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export type PortalScope = {
  requestIds: Set<string>;
  quoteIds: Set<string>;
  bookingIds: Set<string>;
  /** Live (not cancelled) bookings only. */
  liveBookingIds: Set<string>;
  invoiceIds: Set<string>;
  serviceIds: Set<string>;
  functionIds: Set<string>;
};

/** What this vendor may see in this event. */
export async function portalScope(db: Tx, eventId: string, vendorId: string): Promise<PortalScope> {
  const [reqs, qs, bks, invs] = await Promise.all([
    db.select({ id: quoteRequests.id }).from(quoteRequests).where(and(eq(quoteRequests.eventId, eventId), eq(quoteRequests.vendorId, vendorId))),
    db.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.eventId, eventId), eq(quotes.vendorId, vendorId))),
    db.select({ id: bookings.id, status: bookings.status }).from(bookings).where(and(eq(bookings.eventId, eventId), eq(bookings.vendorId, vendorId))),
    db.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.eventId, eventId), eq(invoices.vendorId, vendorId))),
  ]);
  const requestIds = new Set(reqs.map((r) => r.id));
  const liveBookingIds = new Set(bks.filter((b) => b.status !== "cancelled").map((b) => b.id));
  const [viaRequests, viaBookings] = await Promise.all([
    requestIds.size
      ? db
          .select({ serviceId: quoteRequestServices.serviceId })
          .from(quoteRequestServices)
          .where(and(eq(quoteRequestServices.eventId, eventId), inArray(quoteRequestServices.requestId, [...requestIds])))
      : [],
    liveBookingIds.size
      ? db
          .select({ serviceId: fulfilments.serviceId })
          .from(fulfilments)
          .where(and(eq(fulfilments.eventId, eventId), inArray(fulfilments.bookingId, [...liveBookingIds]), isNull(fulfilments.cancelledAt)))
      : [],
  ]);
  const serviceIds = new Set([...viaRequests, ...viaBookings].map((r) => r.serviceId));
  const fns = serviceIds.size
    ? await db
        .select({ functionId: services.functionId })
        .from(services)
        .where(and(eq(services.eventId, eventId), inArray(services.id, [...serviceIds])))
    : [];
  return {
    requestIds,
    quoteIds: new Set(qs.map((q) => q.id)),
    bookingIds: new Set(bks.map((b) => b.id)),
    liveBookingIds,
    invoiceIds: new Set(invs.map((i) => i.id)),
    serviceIds,
    functionIds: new Set(fns.map((f) => f.functionId)),
  };
}

// ---------------------------------------------------------------------------
// Quote requests and quotes
// ---------------------------------------------------------------------------

/** Fields of a function a vendor may see. */
const fnCols = {
  id: functions.id,
  name: functions.name,
  date: functions.date,
  startTime: functions.startTime,
  endTime: functions.endTime,
  venueName: functions.venueName,
  venueAddress: functions.venueAddress,
  mapUrl: functions.mapUrl,
};

/** Fields of a requirement a vendor may see: never the estimate, payer or approval details. */
const reqCols = {
  id: requirements.id,
  serviceId: requirements.serviceId,
  title: requirements.title,
  quantity: requirements.quantity,
  unit: requirements.unit,
  specs: requirements.specs,
  startsAt: requirements.startsAt,
  endsAt: requirements.endsAt,
  venue: requirements.venue,
  priority: requirements.priority,
};

export type PortalRequirement = { id: string; serviceId: string; title: string; quantity: number | null; unit: string | null; specs: string | null; startsAt: Date | null; endsAt: Date | null; venue: string | null; priority: "must" | "nice" };

/** The vendor's quote requests, newest first, with their functions and latest quote version. */
export async function listPortalRequests(db: Tx, eventId: string, vendorId: string) {
  const rows = await db
    .select()
    .from(quoteRequests)
    .where(and(eq(quoteRequests.eventId, eventId), eq(quoteRequests.vendorId, vendorId)))
    .orderBy(desc(quoteRequests.createdAt));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const svc = await db
    .select({ requestId: quoteRequestServices.requestId, functionName: functions.name, functionDate: functions.date, typeKey: serviceTypes.systemKey, typeName: serviceTypes.name, serviceName: services.name })
    .from(quoteRequestServices)
    .innerJoin(services, eq(services.id, quoteRequestServices.serviceId))
    .innerJoin(serviceTypes, eq(serviceTypes.id, services.serviceTypeId))
    .innerJoin(functions, eq(functions.id, services.functionId))
    .where(and(eq(quoteRequestServices.eventId, eventId), inArray(quoteRequestServices.requestId, ids)))
    .orderBy(asc(functions.date), asc(functions.startTime));
  const qs = await db
    .select({ id: quotes.id, requestId: quotes.requestId, version: quotes.version, createdAt: quotes.createdAt })
    .from(quotes)
    .where(and(eq(quotes.eventId, eventId), eq(quotes.vendorId, vendorId), inArray(quotes.requestId, ids)))
    .orderBy(desc(quotes.version));
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    dueDate: r.dueDate,
    closed: !!r.closedAt,
    services: svc.filter((s) => s.requestId === r.id),
    latestQuote: qs.find((q) => q.requestId === r.id) ?? null,
  }));
}

/** The brief of one request: services with function, time, venue and live requirements, plus the vendor's own quotes. */
export async function getPortalRequest(db: Tx, eventId: string, vendorId: string, requestId: string) {
  const [r] = await db
    .select()
    .from(quoteRequests)
    .where(and(eq(quoteRequests.id, requestId), eq(quoteRequests.eventId, eventId), eq(quoteRequests.vendorId, vendorId)));
  if (!r) throw new PortalError("not_found");
  const svc = await db
    .select({ id: services.id, name: services.name, brief: services.brief, cancelledAt: services.cancelledAt, typeKey: serviceTypes.systemKey, typeName: serviceTypes.name, fn: fnCols })
    .from(quoteRequestServices)
    .innerJoin(services, eq(services.id, quoteRequestServices.serviceId))
    .innerJoin(serviceTypes, eq(serviceTypes.id, services.serviceTypeId))
    .innerJoin(functions, eq(functions.id, services.functionId))
    .where(and(eq(quoteRequestServices.requestId, r.id), eq(quoteRequestServices.eventId, eventId)))
    .orderBy(asc(functions.date), asc(functions.startTime), asc(services.sortOrder));
  const reqs: PortalRequirement[] = svc.length
    ? await db
        .select(reqCols)
        .from(requirements)
        .where(
          and(
            eq(requirements.eventId, eventId),
            inArray(requirements.serviceId, svc.map((s) => s.id)),
            eq(requirements.approvalState, "approved"),
            ne(requirements.lifecycle, "cancelled"),
          ),
        )
        .orderBy(asc(requirements.sortOrder))
    : [];
  const own = await db
    .select({ id: quotes.id })
    .from(quotes)
    .where(and(eq(quotes.eventId, eventId), eq(quotes.vendorId, vendorId), eq(quotes.requestId, r.id)))
    .orderBy(desc(quotes.version));
  const quoteViews = await Promise.all(own.map((q) => portalQuoteView(db, eventId, q.id)));
  return {
    request: { id: r.id, message: r.message, dueDate: r.dueDate, createdAt: r.createdAt, closed: !!r.closedAt },
    services: svc.map((s) => ({ ...s, cancelled: !!s.cancelledAt, requirements: reqs.filter((q) => q.serviceId === s.id) })),
    quotes: quoteViews,
  };
}

/** A vendor's own quote with lines and totals; the team's notes on it (declined, etc.) stay out. */
async function portalQuoteView(db: Tx, eventId: string, quoteId: string) {
  const v = await getQuote(db, eventId, quoteId);
  const q = v.quote;
  return {
    quote: {
      id: q.id,
      rootId: q.rootId,
      version: q.version,
      createdAt: q.createdAt,
      vendorRef: q.vendorRef,
      validUntil: q.validUntil,
      terms: q.terms,
      taxType: q.taxType,
      allOrNothing: q.allOrNothing,
      minFunctions: q.minFunctions,
      submittedByVendor: q.submittedByVendor,
    },
    lines: v.lines,
    subtotal: v.subtotal,
    gst: v.gst,
    total: v.total,
    latest: v.latest,
  };
}

export type PortalQuoteView = Awaited<ReturnType<typeof portalQuoteView>>;

/** People on the team who hear about a vendor's activity: Hosts plus owners of the given services who are still members. */
async function teamFor(tx: Tx, eventId: string, serviceIds: string[]) {
  const hosts = await tx.select({ userId: eventMembers.userId }).from(eventMembers).where(and(eq(eventMembers.eventId, eventId), eq(eventMembers.role, "host")));
  const owners = serviceIds.length
    ? await tx
        .select({ userId: eventMembers.userId })
        .from(services)
        .innerJoin(eventMembers, and(eq(eventMembers.userId, services.ownerUserId), eq(eventMembers.eventId, eventId)))
        .where(and(eq(services.eventId, eventId), inArray(services.id, serviceIds)))
    : [];
  return [...new Set([...hosts, ...owners].map((r) => r.userId))];
}

/**
 * The vendor submits or revises a quote for one of its open requests (VND-03/07, VND-10).
 * It's saved like a team-entered quote (so it appears in the team's comparison) and flagged as
 * the vendor's own; Hosts and the services' owners are notified.
 */
export async function submitPortalQuote(
  db: Database,
  input: { eventId: string; vendorId: string; actor: Actor; requestId: string; reviseQuoteId: string | null; quote: QuoteInput },
) {
  const { eventId, vendorId } = input;
  const [r] = await db
    .select()
    .from(quoteRequests)
    .where(and(eq(quoteRequests.id, input.requestId), eq(quoteRequests.eventId, eventId), eq(quoteRequests.vendorId, vendorId)));
  if (!r) throw new PortalError("not_found");
  if (r.closedAt) throw new PortalError("closed");
  if (input.reviseQuoteId) {
    const [prev] = await db
      .select({ id: quotes.id })
      .from(quotes)
      .where(and(eq(quotes.id, input.reviseQuoteId), eq(quotes.eventId, eventId), eq(quotes.vendorId, vendorId), eq(quotes.requestId, r.id)));
    if (!prev) throw new PortalError("not_found");
  }
  return saveQuote(db, eventId, input.actor, { requestId: r.id, reviseQuoteId: input.reviseQuoteId }, input.quote, {
    submittedByVendor: true,
    after: async (tx, q) => {
      const svc = await tx.select({ serviceId: quoteRequestServices.serviceId }).from(quoteRequestServices).where(eq(quoteRequestServices.requestId, r.id));
      const [v] = await tx.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, vendorId));
      await notify(tx, {
        eventId,
        userIds: await teamFor(tx, eventId, svc.map((s) => s.serviceId)),
        kind: "vendor.quote_submitted",
        data: { vendor: v?.name ?? "" },
        href: `/events/${eventId}/vendors/quotes/${q.id}`,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Bookings, payment status and invoices
// ---------------------------------------------------------------------------

/** "awaiting confirmation" for a booking a Host hasn't approved yet (BGT-04). */
export type PortalBookingStatus = "awaiting_confirmation" | "confirmed" | "cancelled";
export const portalStatus = (s: BookingStatus): PortalBookingStatus => (s === "pending_approval" ? "awaiting_confirmation" : s);

export async function listPortalBookings(db: Tx, eventId: string, vendorId: string) {
  const rows = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.eventId, eventId), eq(bookings.vendorId, vendorId)))
    .orderBy(desc(bookings.createdAt));
  if (rows.length === 0) return [];
  const fns = await db
    .selectDistinct({ bookingId: fulfilments.bookingId, functionName: functions.name, functionDate: functions.date })
    .from(fulfilments)
    .innerJoin(services, eq(services.id, fulfilments.serviceId))
    .innerJoin(functions, eq(functions.id, services.functionId))
    .where(and(eq(fulfilments.eventId, eventId), inArray(fulfilments.bookingId, rows.map((b) => b.id)), isNull(fulfilments.cancelledAt)));
  return rows.map((b) => ({
    id: b.id,
    status: portalStatus(b.status),
    total: b.subtotalPaise + b.gstPaise,
    createdAt: b.createdAt,
    functions: fns.filter((f) => f.bookingId === b.id).sort((x, y) => (x.functionDate ?? "").localeCompare(y.functionDate ?? "")),
  }));
}

export type PortalMilestone = { id: string; kind: "advance" | "milestone" | "final"; label: string | null; amount: number; dueDate: string | null; paid: number; status: PayStatus | null };

/** One booking: what's booked, the payment schedule with status, invoices, files and run-sheet items. */
export async function getPortalBooking(db: Tx, eventId: string, vendorId: string, bookingId: string, today: string) {
  const [b] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.eventId, eventId), eq(bookings.vendorId, vendorId)));
  if (!b) throw new PortalError("not_found");
  const fs = await db
    .select({
      id: fulfilments.id,
      quantity: fulfilments.quantity,
      amount: fulfilments.amountPaise,
      gst: fulfilments.gstPaise,
      requirementTitle: requirements.title,
      requirementQty: requirements.quantity,
      unit: requirements.unit,
      specs: requirements.specs,
      serviceName: services.name,
      typeKey: serviceTypes.systemKey,
      typeName: serviceTypes.name,
      functionId: functions.id,
      functionName: functions.name,
      functionDate: functions.date,
    })
    .from(fulfilments)
    .innerJoin(services, eq(services.id, fulfilments.serviceId))
    .innerJoin(serviceTypes, eq(serviceTypes.id, services.serviceTypeId))
    .innerJoin(functions, eq(functions.id, services.functionId))
    .leftJoin(requirements, eq(requirements.id, fulfilments.requirementId))
    .where(and(eq(fulfilments.bookingId, b.id), eq(fulfilments.eventId, eventId), b.status === "cancelled" ? undefined : isNull(fulfilments.cancelledAt)))
    .orderBy(asc(functions.date), asc(services.sortOrder), asc(requirements.sortOrder));
  const fin = await bookingFinance(db, eventId, b.id, today);
  // Only the schedule and confirmed totals: who paid, payers and unconfirmed records stay with the team.
  const milestones: PortalMilestone[] = fin.milestones.map((m) => ({
    id: m.milestone.id,
    kind: m.milestone.kind,
    label: m.milestone.label,
    amount: m.milestone.amountPaise,
    dueDate: m.milestone.dueDate,
    paid: m.paid,
    status: m.status,
  }));
  const invs = (await listInvoices(db, eventId, today, { vendorId, bookingId: b.id })).map(invoiceView);
  const docs = await db
    .select()
    .from(documents)
    .where(and(eq(documents.eventId, eventId), eq(documents.bookingId, b.id)))
    .orderBy(desc(documents.createdAt));
  const fnIds = [...new Set(fs.map((f) => f.functionId))];
  const items = (await portalRunSheet(db, eventId, vendorId)).filter((i) => fnIds.includes(i.functionId));
  return {
    booking: {
      id: b.id,
      status: portalStatus(b.status),
      subtotal: b.subtotalPaise,
      gst: b.gstPaise,
      total: b.subtotalPaise + b.gstPaise,
      cancellationPolicy: b.cancellationPolicy,
      deliverables: b.deliverables,
      confirmedAt: b.confirmedAt,
      cancelledAt: b.cancelledAt,
      quoteId: b.quoteId,
    },
    fulfilments: fs,
    // The schedule is only active once a Host confirms the booking.
    milestones,
    paid: b.status === "confirmed" ? fin.paid : 0,
    balance: b.status === "confirmed" ? fin.balance : b.subtotalPaise + b.gstPaise,
    invoices: invs,
    documents: docs,
    runSheet: items,
  };
}

const invoiceView = (i: Awaited<ReturnType<typeof listInvoices>>[number]) => ({
  id: i.invoice.id,
  number: i.invoice.number,
  invoiceDate: i.invoice.invoiceDate,
  dueDate: i.invoice.dueDate,
  bookingId: i.invoice.bookingId,
  total: i.invoice.totalPaise,
  source: i.invoice.source,
  paid: i.paid,
  status: i.status,
});

export async function listPortalInvoices(db: Tx, eventId: string, vendorId: string, today: string) {
  return (await listInvoices(db, eventId, today, { vendorId })).map(invoiceView);
}

export const portalInvoiceInput = z.object({
  bookingId: z.string().uuid().nullable(),
  number: z.string().trim().min(1).max(60),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  supplierGstin: z.string().trim().toUpperCase().max(15).nullable(),
  taxType: z.enum(["none", "cgst_sgst", "igst"]),
  notes: z.string().trim().max(2000).nullable(),
  lines: z.array(invoiceLineInput.extend({ serviceId: z.null().default(null) })).min(1).max(50),
});
export type PortalInvoiceInput = z.infer<typeof portalInvoiceInput>;

/**
 * The vendor uploads an invoice (VND-08/10). It must be for one of the vendor's own live
 * bookings (or none); it's stored with source "vendor" and the team is notified. Payments are
 * still recorded and confirmed only by the team.
 */
export async function uploadPortalInvoice(db: Database, input: { eventId: string; vendorId: string; actor: Actor; invoice: PortalInvoiceInput }) {
  const { eventId, vendorId } = input;
  const inv = portalInvoiceInput.parse(input.invoice);
  let serviceIds: string[] = [];
  if (inv.bookingId) {
    const [b] = await db
      .select({ id: bookings.id, status: bookings.status })
      .from(bookings)
      .where(and(eq(bookings.id, inv.bookingId), eq(bookings.eventId, eventId), eq(bookings.vendorId, vendorId)));
    if (!b || b.status === "cancelled") throw new PortalError("not_found");
    serviceIds = (
      await db.selectDistinct({ serviceId: fulfilments.serviceId }).from(fulfilments).where(and(eq(fulfilments.bookingId, b.id), isNull(fulfilments.cancelledAt)))
    ).map((r) => r.serviceId);
  }
  return createInvoice(
    db,
    eventId,
    input.actor,
    { ...inv, vendorId, printedTotalPaise: null },
    {
      source: "vendor",
      after: async (tx, row) => {
        const [v] = await tx.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, vendorId));
        await notify(tx, {
          eventId,
          userIds: await teamFor(tx, eventId, serviceIds),
          kind: "vendor.invoice_uploaded",
          data: { vendor: v?.name ?? "", number: row.number },
          href: `/events/${eventId}/budget/invoices/${row.id}`,
        });
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Run sheet and documents
// ---------------------------------------------------------------------------

/** Run-sheet items the team assigned to this vendor (ITN-03, VND-10). */
export async function portalRunSheet(db: Tx, eventId: string, vendorId: string) {
  return db
    .select({
      id: runSheetItems.id,
      functionId: runSheetItems.functionId,
      functionName: functions.name,
      functionDate: functions.date,
      startsAt: runSheetItems.startsAt,
      durationMin: runSheetItems.durationMin,
      title: runSheetItems.title,
      location: runSheetItems.location,
      notes: runSheetItems.notes,
      status: runSheetItems.status,
      timeLocked: runSheetItems.timeLocked,
    })
    .from(runSheetItems)
    .innerJoin(functions, eq(functions.id, runSheetItems.functionId))
    .where(and(eq(runSheetItems.eventId, eventId), eq(runSheetItems.ownerVendorId, vendorId)))
    .orderBy(asc(runSheetItems.startsAt), asc(runSheetItems.sortOrder));
}

/** Files attached to this vendor, its quotes, bookings or invoices. */
export async function listPortalDocuments(db: Tx, eventId: string, vendorId: string, scope?: PortalScope): Promise<DocumentRow[]> {
  const s = scope ?? (await portalScope(db, eventId, vendorId));
  const ids = (set: Set<string>) => (set.size ? [...set] : null);
  const q = ids(s.quoteIds);
  const b = ids(s.bookingIds);
  const i = ids(s.invoiceIds);
  return db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.eventId, eventId),
        or(
          eq(documents.vendorId, vendorId),
          q ? inArray(documents.quoteId, q) : undefined,
          b ? inArray(documents.bookingId, b) : undefined,
          i ? inArray(documents.invoiceId, i) : undefined,
        ),
      ),
    )
    .orderBy(desc(documents.createdAt));
}

/** Whether a document belongs to this vendor's scope (download check). */
export async function portalDocumentAllowed(db: Tx, eventId: string, vendorId: string, documentId: string) {
  const [d] = await db.select().from(documents).where(and(eq(documents.id, documentId), eq(documents.eventId, eventId)));
  if (!d) return false;
  if (d.vendorId === vendorId) return true;
  const s = await portalScope(db, eventId, vendorId);
  return (!!d.quoteId && s.quoteIds.has(d.quoteId)) || (!!d.bookingId && s.bookingIds.has(d.bookingId)) || (!!d.invoiceId && s.invoiceIds.has(d.invoiceId));
}

/** Whether an invoice is the vendor's own (to attach files to it). */
export async function portalInvoiceAllowed(db: Tx, eventId: string, vendorId: string, invoiceId: string) {
  const [i] = await db.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.id, invoiceId), eq(invoices.eventId, eventId), eq(invoices.vendorId, vendorId)));
  return !!i;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export async function portalOverview(db: Tx, eventId: string, vendorId: string) {
  const [counts] = await db
    .select({
      openRequests: sql<number>`(select count(*)::int from ${quoteRequests} where ${quoteRequests.eventId} = ${eventId} and ${quoteRequests.vendorId} = ${vendorId} and ${quoteRequests.closedAt} is null)`,
      awaiting: sql<number>`(select count(*)::int from ${bookings} where ${bookings.eventId} = ${eventId} and ${bookings.vendorId} = ${vendorId} and ${bookings.status} = 'pending_approval')`,
      confirmed: sql<number>`(select count(*)::int from ${bookings} where ${bookings.eventId} = ${eventId} and ${bookings.vendorId} = ${vendorId} and ${bookings.status} = 'confirmed')`,
    })
    .from(events)
    .where(eq(events.id, eventId));
  return counts ?? { openRequests: 0, awaiting: 0, confirmed: 0 };
}

// ---------------------------------------------------------------------------
// Notifications to the vendor's logins
// ---------------------------------------------------------------------------

/**
 * Tells the vendor's logins that a booking changed (kind vendor.booking_changed). The status is
 * written in each person's language, since the notification text is rendered from its data.
 */
export async function notifyVendorBooking(tx: Tx, eventId: string, vendorId: string, bookingId: string, status: PortalBookingStatus | "changed") {
  const ids = await vendorUserIds(tx, [vendorId]);
  if (ids.length === 0) return;
  const [ev] = await tx.select({ name: events.name }).from(events).where(eq(events.id, eventId));
  const people = await tx.select({ id: users.id, locale: users.locale }).from(users).where(inArray(users.id, ids));
  for (const p of people) {
    const locale = isLocale(p.locale) ? p.locale : "en";
    await notify(tx, {
      eventId,
      userIds: [p.id],
      kind: "vendor.booking_changed",
      data: { event: ev?.name ?? "", status: translateDynamic(locale, `vendorPortal.bookingStatus.${status}`) ?? status },
      href: `/vendor/${vendorId}/bookings/${bookingId}`,
    });
  }
}
