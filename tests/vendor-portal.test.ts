import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLogs, eventMembers, invoices, notifications, quotes } from "@/db/schema";
import "@/lib/approval-handlers";
import { decideRequest } from "@/lib/approvals";
import { proposeBooking } from "@/lib/bookings";
import { listServiceTypes } from "@/lib/catalogue";
import { catererFunctions, getCatererView } from "@/lib/caterer-headcount";
import { saveDocument } from "@/lib/documents";
import { signInWithIdentifier } from "@/lib/auth-core";
import { createEvent } from "@/lib/events";
import { createFunction } from "@/lib/functions";
import type { PolicySubject } from "@/lib/policy";
import { compareForService, createQuoteRequests, closeQuoteRequest, type LineInput, type QuoteInput } from "@/lib/quotes";
import { createItem } from "@/lib/runsheet";
import { addRequirement, addService } from "@/lib/services";
import { inviteVendorContact, revokeVendorContact, vendorLink, vendorLinksForUser } from "@/lib/vendor-access";
import {
  getPortalBooking,
  getPortalRequest,
  listPortalBookings,
  listPortalDocuments,
  listPortalRequests,
  portalDocumentAllowed,
  portalRunSheet,
  portalScope,
  submitPortalQuote,
  uploadPortalInvoice,
} from "@/lib/vendor-portal";
import { createVendor } from "@/lib/vendors";
import { actorOf, db, makeUser, resetDb } from "./helpers";

beforeEach(resetDb);

const hostS: PolicySubject = { isAppAdmin: false, membership: { role: "host", giftAccess: "none" } };
const plannerS: PolicySubject = { isAppAdmin: false, membership: { role: "planner", giftAccess: "none" } };
const blank = { startTime: "19:00", endTime: null, venueName: "Lawns", venueAddress: null, mapUrl: null, dressCode: null, description: null };
const TODAY = "2026-11-01";
/** A distinctive estimate so we can prove it never leaks into portal reads. */
const ESTIMATE = 987_654_321;
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");

async function eventWithVendor(hostEmail: string, vendorName: string, contactEmail: string | null) {
  const host = await makeUser(hostEmail, "Asha");
  const event = await createEvent(db(), actorOf(host), { name: `Wedding of ${hostEmail}`, startDate: "2026-12-10" });
  const H = { eventId: event.id, actor: actorOf(host), subject: hostS };
  const fn = await createFunction(db(), event.id, actorOf(host), { name: "Sangeet", date: "2026-12-10", ...blank });
  const types = await listServiceTypes(db(), event.id);
  const catering = types.find((t) => t.systemKey === "catering")!;
  const svc = (await addService(db(), H, { functionId: fn.id, serviceTypeId: catering.id, useTemplates: false, brief: "Veg buffet" })).service;
  const req = (
    await addRequirement(db(), H, svc.id, {
      title: "Dinner",
      quantity: 400,
      unit: "plates",
      specs: "Jain counter",
      startsAt: null,
      endsAt: null,
      venue: null,
      estimatePaise: ESTIMATE,
      priority: "must",
      payer: { kind: "bride" },
    })
  ).requirement;
  const vendor = await createVendor(db(), event.id, actorOf(host), { name: vendorName, contactName: null, phone: null, email: null, gstin: null, notes: null, serviceTypeIds: [catering.id] });
  const [requestId] = await createQuoteRequests(db(), event.id, actorOf(host), { vendorIds: [vendor.id], serviceIds: [svc.id], dueDate: "2026-11-20", message: "Please quote" });
  if (contactEmail) {
    await inviteVendorContact(db(), { eventId: event.id, vendorId: vendor.id, identifier: { type: "email", value: contactEmail }, actor: actorOf(host), appUrl: "" });
  }
  return { host, event, H, fn, svc, req, vendor, requestId, catering };
}

const quoteFor = (req: { id: string; serviceId: string }, amount = 4_00_000_00, quantity: number | null = null): QuoteInput => ({
  vendorRef: "Q-1",
  receivedOn: TODAY,
  validUntil: null,
  terms: null,
  taxType: "none",
  allOrNothing: false,
  minFunctions: null,
  lines: [{ scope: "requirement", serviceId: req.serviceId, requirementId: req.id, description: null, quantity, amountPaise: amount, gstRateBps: 0, conditional: false, allocation: null } satisfies LineInput],
});

describe("vendor portal scope (VND-10)", () => {
  it("keeps a vendor of two events to each event's own data", async () => {
    const a = await eventWithVendor("a@example.com", "Spice", "chef@spice.in");
    const b = await eventWithVendor("b@example.com", "Spice B", "chef@spice.in");
    const chef = await makeUser("chef@spice.in", "Chef");
    expect((await vendorLinksForUser(db(), chef.id)).map((l) => l.vendorId).sort()).toEqual([a.vendor.id, b.vendor.id].sort());

    // Own data works.
    expect((await getPortalRequest(db(), a.event.id, a.vendor.id, a.requestId)).services).toHaveLength(1);
    // Event B's request through event A's ids, or through a mismatched vendor: not found.
    await expect(getPortalRequest(db(), a.event.id, a.vendor.id, b.requestId)).rejects.toMatchObject({ code: "not_found" });
    await expect(getPortalRequest(db(), a.event.id, b.vendor.id, b.requestId)).rejects.toMatchObject({ code: "not_found" });
    await expect(getPortalRequest(db(), b.event.id, a.vendor.id, a.requestId)).rejects.toMatchObject({ code: "not_found" });
    // Quote into the other event's request.
    await expect(
      submitPortalQuote(db(), { eventId: a.event.id, vendorId: a.vendor.id, actor: actorOf(chef), requestId: b.requestId, reviseQuoteId: null, quote: quoteFor(b.req) }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await listPortalRequests(db(), a.event.id, b.vendor.id)).toEqual([]);
  });

  it("hides another vendor's request, booking, documents and functions (404)", async () => {
    const a = await eventWithVendor("a@example.com", "Spice", "chef@spice.in");
    const chef = await makeUser("chef@spice.in", "Chef");
    const other = await createVendor(db(), a.event.id, actorOf(a.host), { name: "Rival", contactName: null, phone: null, email: null, gstin: null, notes: null, serviceTypeIds: [a.catering.id] });
    const [otherReq] = await createQuoteRequests(db(), a.event.id, actorOf(a.host), { vendorIds: [other.id], serviceIds: [a.svc.id], dueDate: null, message: null });
    const { saveQuote } = await import("@/lib/quotes");
    const oq = await saveQuote(db(), a.event.id, actorOf(a.host), { requestId: otherReq }, quoteFor(a.req));
    const { getQuote } = await import("@/lib/quotes");
    const ov = await getQuote(db(), a.event.id, oq.id);
    const booked = await proposeBooking(db(), a.H, { quoteId: oq.id, lineIds: [ov.lines[0].id], today: TODAY });
    const doc = await saveDocument(db(), a.event.id, actorOf(a.host), { owner: { bookingId: booked.booking.id }, kind: "contract", filename: "rival.pdf", data: PDF });
    const ownDoc = await saveDocument(db(), a.event.id, actorOf(a.host), { owner: { vendorId: a.vendor.id }, kind: "brief", filename: "brief.pdf", data: PDF });

    await expect(getPortalRequest(db(), a.event.id, a.vendor.id, otherReq)).rejects.toMatchObject({ code: "not_found" });
    await expect(getPortalBooking(db(), a.event.id, a.vendor.id, booked.booking.id, TODAY)).rejects.toMatchObject({ code: "not_found" });
    expect(await portalDocumentAllowed(db(), a.event.id, a.vendor.id, doc.id)).toBe(false);
    expect(await portalDocumentAllowed(db(), a.event.id, a.vendor.id, ownDoc.id)).toBe(true);
    expect((await listPortalDocuments(db(), a.event.id, a.vendor.id)).map((d) => d.id)).toEqual([ownDoc.id]);
    expect(await listPortalBookings(db(), a.event.id, a.vendor.id)).toEqual([]);
    // The rival's confirmed catering function isn't the vendor's headcount.
    await expect(getCatererView(db(), a.event.id, a.vendor.id, a.fn.id)).rejects.toMatchObject({ code: "not_found" });
    // Revising the rival's quote through own request: not found.
    await expect(
      submitPortalQuote(db(), { eventId: a.event.id, vendorId: a.vendor.id, actor: actorOf(chef), requestId: a.requestId, reviseQuoteId: oq.id, quote: quoteFor(a.req) }),
    ).rejects.toMatchObject({ code: "not_found" });
    // Invoicing against the rival's booking: not found.
    await expect(
      uploadPortalInvoice(db(), {
        eventId: a.event.id,
        vendorId: a.vendor.id,
        actor: actorOf(chef),
        invoice: { bookingId: booked.booking.id, number: "INV-1", invoiceDate: TODAY, dueDate: null, supplierGstin: null, taxType: "none", notes: null, lines: [{ serviceId: null, description: "Food", hsnSac: null, amountPaise: 100_00, gstRateBps: 0 }] },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("revoked contacts lose access", async () => {
    const a = await eventWithVendor("a@example.com", "Spice", "chef@spice.in");
    const chef = await makeUser("chef@spice.in", "Chef");
    expect(await vendorLink(db(), chef.id, a.vendor.id)).not.toBeNull();
    const [c] = await (await import("@/lib/vendor-access")).listVendorContacts(db(), a.event.id, a.vendor.id);
    await revokeVendorContact(db(), a.event.id, c.id, actorOf(a.host));
    expect(await vendorLink(db(), chef.id, a.vendor.id)).toBeNull();
  });
});

describe("vendor quotes, bookings and invoices (VND-10)", () => {
  it("a vendor's quote is flagged, notifies the team and shows in the comparison", async () => {
    const a = await eventWithVendor("a@example.com", "Spice", "chef@spice.in");
    const chef = await makeUser("chef@spice.in", "Chef");
    const q = await submitPortalQuote(db(), { eventId: a.event.id, vendorId: a.vendor.id, actor: actorOf(chef), requestId: a.requestId, reviseQuoteId: null, quote: quoteFor(a.req) });
    expect(q.submittedByVendor).toBe(true);
    const cmp = await compareForService(db(), a.event.id, a.svc.id);
    expect(cmp.quotes.map((x) => x.quote.id)).toEqual([q.id]);
    const notes = await db().select().from(notifications).where(eq(notifications.userId, a.host.id));
    expect(notes.map((n) => n.kind)).toContain("vendor.quote_submitted");
    const [log] = await db().select().from(auditLogs).where(and(eq(auditLogs.eventId, a.event.id), eq(auditLogs.action, "quote.vendor_submitted")));
    expect(log.actorUserId).toBe(chef.id);

    // Revision is a new version; the portal shows both, latest first.
    const q2 = await submitPortalQuote(db(), { eventId: a.event.id, vendorId: a.vendor.id, actor: actorOf(chef), requestId: a.requestId, reviseQuoteId: q.id, quote: quoteFor(a.req, 3_90_000_00) });
    expect(q2.version).toBe(2);
    const view = await getPortalRequest(db(), a.event.id, a.vendor.id, a.requestId);
    expect(view.quotes.map((x) => x.quote.version)).toEqual([2, 1]);

    // Closed requests take no more quotes.
    await closeQuoteRequest(db(), a.event.id, a.requestId, true);
    await expect(
      submitPortalQuote(db(), { eventId: a.event.id, vendorId: a.vendor.id, actor: actorOf(chef), requestId: a.requestId, reviseQuoteId: q2.id, quote: quoteFor(a.req) }),
    ).rejects.toMatchObject({ code: "closed" });
  });

  it("never exposes budget estimates or payers in portal reads", async () => {
    const a = await eventWithVendor("a@example.com", "Spice", "chef@spice.in");
    const chef = await makeUser("chef@spice.in", "Chef");
    const q = await submitPortalQuote(db(), { eventId: a.event.id, vendorId: a.vendor.id, actor: actorOf(chef), requestId: a.requestId, reviseQuoteId: null, quote: quoteFor(a.req) });
    const { getQuote } = await import("@/lib/quotes");
    const v = await getQuote(db(), a.event.id, q.id);
    const b = await proposeBooking(db(), a.H, { quoteId: q.id, lineIds: [v.lines[0].id], today: TODAY });
    const reads = JSON.stringify([
      await getPortalRequest(db(), a.event.id, a.vendor.id, a.requestId),
      await getPortalBooking(db(), a.event.id, a.vendor.id, b.booking.id, TODAY),
      await listPortalRequests(db(), a.event.id, a.vendor.id),
      await listPortalBookings(db(), a.event.id, a.vendor.id),
    ]);
    expect(reads).not.toContain(String(ESTIMATE));
    expect(reads).not.toContain("estimate");
    expect(reads).not.toContain("payer");
    expect(reads).toContain("Jain counter");
  });

  it("shows the vendor only contracts, invoices and receipts on a booking, plus its own uploads", async () => {
    const a = await eventWithVendor("a@example.com", "Spice", "chef@spice.in");
    const { user: chef } = await db().transaction((tx) => signInWithIdentifier(tx, { type: "email", value: "chef@spice.in" }));
    const q = await submitPortalQuote(db(), { eventId: a.event.id, vendorId: a.vendor.id, actor: actorOf(chef), requestId: a.requestId, reviseQuoteId: null, quote: quoteFor(a.req) });
    const { getQuote } = await import("@/lib/quotes");
    const v = await getQuote(db(), a.event.id, q.id);
    const b = await proposeBooking(db(), a.H, { quoteId: q.id, lineIds: [v.lines[0].id], today: TODAY });
    const owner = { bookingId: b.booking.id };
    const contract = await saveDocument(db(), a.event.id, actorOf(a.host), { owner, kind: "contract", filename: "contract.pdf", data: PDF });
    const receipt = await saveDocument(db(), a.event.id, actorOf(a.host), { owner, kind: "receipt", filename: "receipt.pdf", data: PDF });
    const internal = await saveDocument(db(), a.event.id, actorOf(a.host), { owner, kind: "other", filename: "negotiation-notes.pdf", data: PDF });
    const theirs = await saveDocument(db(), a.event.id, actorOf(chef), { owner, kind: "other", filename: "menu.pdf", data: PDF });

    const visible = [contract.id, receipt.id, theirs.id].sort();
    expect((await getPortalBooking(db(), a.event.id, a.vendor.id, b.booking.id, TODAY)).documents.map((d) => d.id).sort()).toEqual(visible);
    expect((await listPortalDocuments(db(), a.event.id, a.vendor.id)).map((d) => d.id).sort()).toEqual(visible);
    expect(await portalDocumentAllowed(db(), a.event.id, a.vendor.id, internal.id)).toBe(false);
    expect(await portalDocumentAllowed(db(), a.event.id, a.vendor.id, contract.id)).toBe(true);
    expect(await portalDocumentAllowed(db(), a.event.id, a.vendor.id, theirs.id)).toBe(true);
  });

  it("a pending booking shows awaiting confirmation and no headcount until a Host approves", async () => {
    const a = await eventWithVendor("a@example.com", "Spice", "chef@spice.in");
    const chef = await makeUser("chef@spice.in", "Chef");
    const planner = await makeUser("planner@example.com", "Ravi");
    await db().insert(eventMembers).values({ eventId: a.event.id, userId: planner.id, role: "planner" });
    const P = { eventId: a.event.id, actor: actorOf(planner), subject: plannerS };
    const q = await submitPortalQuote(db(), { eventId: a.event.id, vendorId: a.vendor.id, actor: actorOf(chef), requestId: a.requestId, reviseQuoteId: null, quote: quoteFor(a.req) });
    const { getQuote } = await import("@/lib/quotes");
    const v = await getQuote(db(), a.event.id, q.id);
    const b = await proposeBooking(db(), P, { quoteId: q.id, lineIds: [v.lines[0].id], today: TODAY });
    expect(b.result.status).toBe("pending");

    const [row] = await listPortalBookings(db(), a.event.id, a.vendor.id);
    expect(row.status).toBe("awaiting_confirmation");
    const detail = await getPortalBooking(db(), a.event.id, a.vendor.id, b.booking.id, TODAY);
    expect(detail.milestones.every((m) => m.status === null)).toBe(true);
    expect(await catererFunctions(db(), a.event.id, a.vendor.id)).toEqual([]);
    await expect(getCatererView(db(), a.event.id, a.vendor.id, a.fn.id)).rejects.toMatchObject({ code: "not_found" });

    if (b.result.status !== "pending") throw new Error("expected pending");
    await decideRequest(db(), { eventId: a.event.id, requestId: b.result.request.id, actor: actorOf(a.host), subject: hostS, decision: "approve" });
    expect((await listPortalBookings(db(), a.event.id, a.vendor.id))[0].status).toBe("confirmed");
    expect((await catererFunctions(db(), a.event.id, a.vendor.id)).map((f) => f.functionId)).toEqual([a.fn.id]);
    const notes = await db().select().from(notifications).where(eq(notifications.userId, chef.id));
    expect(notes.map((n) => n.kind)).toContain("vendor.booking_changed");
    expect(notes.find((n) => n.kind === "vendor.booking_changed")?.data).toMatchObject({ status: "Confirmed" });
  });

  it("vendor invoices are stored with source vendor and notify the team", async () => {
    const a = await eventWithVendor("a@example.com", "Spice", "chef@spice.in");
    const chef = await makeUser("chef@spice.in", "Chef");
    const q = await submitPortalQuote(db(), { eventId: a.event.id, vendorId: a.vendor.id, actor: actorOf(chef), requestId: a.requestId, reviseQuoteId: null, quote: quoteFor(a.req) });
    const { getQuote } = await import("@/lib/quotes");
    const v = await getQuote(db(), a.event.id, q.id);
    const b = await proposeBooking(db(), a.H, { quoteId: q.id, lineIds: [v.lines[0].id], today: TODAY });
    const inv = await uploadPortalInvoice(db(), {
      eventId: a.event.id,
      vendorId: a.vendor.id,
      actor: actorOf(chef),
      invoice: { bookingId: b.booking.id, number: "INV-7", invoiceDate: TODAY, dueDate: null, supplierGstin: null, taxType: "igst", notes: null, lines: [{ serviceId: null, description: "Advance", hsnSac: null, amountPaise: 1_00_000_00, gstRateBps: 1800 }] },
    });
    const [row] = await db().select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row.source).toBe("vendor");
    expect(row.totalPaise).toBe(1_18_000_00);
    expect((await portalScope(db(), a.event.id, a.vendor.id)).invoiceIds.has(inv.id)).toBe(true);
    const doc = await saveDocument(db(), a.event.id, actorOf(chef), { owner: { invoiceId: inv.id }, kind: "invoice", filename: "inv.pdf", data: PDF });
    expect(await portalDocumentAllowed(db(), a.event.id, a.vendor.id, doc.id)).toBe(true);
    const notes = await db().select().from(notifications).where(eq(notifications.userId, a.host.id));
    expect(notes.map((n) => n.kind)).toContain("vendor.invoice_uploaded");
    // The quote stays the team's to decline; the vendor's quote isn't touched by invoicing.
    const [qq] = await db().select().from(quotes).where(eq(quotes.id, q.id));
    expect(qq.declinedAt).toBeNull();
  });

  it("shows run-sheet items assigned to the vendor and rejects vendors of other events", async () => {
    const a = await eventWithVendor("a@example.com", "Spice", null);
    const b = await eventWithVendor("b@example.com", "Elsewhere", null);
    const base = { startsAt: new Date("2026-12-10T18:00:00Z"), durationMin: 30, title: "Dinner service opens", ownerUserId: null, ownerName: null, ownerPhone: null, location: "Lawns", notes: null, timeLocked: false };
    await createItem(db(), a.event.id, a.fn.id, { ...base, ownerVendorId: a.vendor.id });
    await createItem(db(), a.event.id, a.fn.id, { ...base, title: "Speeches", ownerVendorId: null });
    await expect(createItem(db(), a.event.id, a.fn.id, { ...base, ownerVendorId: b.vendor.id })).rejects.toMatchObject({ code: "bad_owner" });
    const items = await portalRunSheet(db(), a.event.id, a.vendor.id);
    expect(items.map((i) => i.title)).toEqual(["Dinner service opens"]);
    expect(await portalRunSheet(db(), b.event.id, a.vendor.id)).toEqual([]);
  });
});
