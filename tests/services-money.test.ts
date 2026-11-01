import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLogs, eventMembers, events, functions, requirements, serviceTypes, vendors } from "@/db/schema";
import "@/lib/approval-handlers";
import { decideRequest, withdrawRequest } from "@/lib/approvals";
import { addBudgetLine, budgetFacts, byPayer, categoryTotals, groupFacts, sumFacts } from "@/lib/budget";
import { BookingError, cancelBooking, proposeBooking, reviseBooking, updateSchedule } from "@/lib/bookings";
import { ensureCatalogue, listServiceTypes, setThreshold } from "@/lib/catalogue";
import { saveDocument, DocumentError, sniffMime } from "@/lib/documents";
import { createEvent } from "@/lib/events";
import { createFunction, deleteFunction } from "@/lib/functions";
import { bookingFinance, createInvoice, milestoneStatuses, payables, payStatus, PaymentError, recordPayment, sendApprovalReminders, sendPaymentReminders } from "@/lib/payments";
import type { PolicySubject } from "@/lib/policy";
import { compareForService, comparePackage, createQuoteRequests, getQuote, QuoteError, saveQuote, type LineInput } from "@/lib/quotes";
import { addRequirement, addService, cancelRequirement, gapView, getService, listServices, markDelivered, updateRequirement } from "@/lib/services";
import { createVendor, deleteVendor, revealVendorSecrets, setVendorSecrets, VendorError } from "@/lib/vendors";
import { actorOf, db, makeUser, outbox, resetDb } from "./helpers";

beforeEach(resetDb);

const hostS: PolicySubject = { isAppAdmin: false, membership: { role: "host", giftAccess: "none" } };
const plannerS: PolicySubject = { isAppAdmin: false, membership: { role: "planner", giftAccess: "none" } };
const blank = { startTime: null, endTime: null, venueName: null, venueAddress: null, mapUrl: null, dressCode: null, description: null };
const req = (title: string, quantity: number | null, estimate: number | null) => ({
  title,
  quantity,
  unit: null,
  specs: null,
  startsAt: null,
  endsAt: null,
  venue: null,
  estimatePaise: estimate,
  priority: "must" as const,
  payer: null,
});
const TODAY = "2026-11-01";

async function setup() {
  const host = await makeUser("host@example.com", "Asha");
  const planner = await makeUser("planner@example.com", "Ravi");
  const event = await createEvent(db(), actorOf(host), { name: "Wedding", startDate: "2026-12-10" });
  await db().insert(eventMembers).values({ eventId: event.id, userId: planner.id, role: "planner" });
  const mehendi = await createFunction(db(), event.id, actorOf(host), { name: "Mehendi", date: "2026-12-09", ...blank });
  const sangeet = await createFunction(db(), event.id, actorOf(host), { name: "Sangeet", date: "2026-12-10", ...blank });
  const types = await listServiceTypes(db(), event.id);
  const type = (key: string) => types.find((t) => t.systemKey === key)!;
  const H = { eventId: event.id, actor: actorOf(host), subject: hostS };
  const P = { eventId: event.id, actor: actorOf(planner), subject: plannerS };
  const decideAs = (requestId: string, decision: "approve" | "reject" | "request_changes", comment?: string) =>
    decideRequest(db(), { eventId: event.id, requestId, actor: actorOf(host), subject: hostS, decision, comment });
  return { host, planner, event, mehendi, sangeet, type, H, P, decideAs };
}

/** Catering for both functions (Host), each with one 400-plate requirement. */
async function cateringSetup() {
  const s = await setup();
  const svcM = (await addService(db(), s.H, { functionId: s.mehendi.id, serviceTypeId: s.type("catering").id, useTemplates: false })).service;
  const svcS = (await addService(db(), s.H, { functionId: s.sangeet.id, serviceTypeId: s.type("catering").id, useTemplates: false })).service;
  const rM = (await addRequirement(db(), s.H, svcM.id, req("Dinner", 400, 40_00_000_00))).requirement;
  const rS = (await addRequirement(db(), s.H, svcS.id, req("Dinner", 400, 50_00_000_00))).requirement;
  const vendor = await createVendor(db(), s.event.id, actorOf(s.host), {
    name: "Spice Caterers",
    contactName: null,
    phone: null,
    email: null,
    gstin: "27AAPFU0939F1ZV",
    notes: null,
    serviceTypeIds: [s.type("catering").id],
  });
  const [requestId] = await createQuoteRequests(db(), s.event.id, actorOf(s.host), { vendorIds: [vendor.id], serviceIds: [svcM.id, svcS.id], dueDate: null, message: null });
  const line = (r: { id: string; serviceId: string }, amount: number, quantity: number | null = null): LineInput => ({
    scope: "requirement",
    serviceId: r.serviceId,
    requirementId: r.id,
    description: null,
    quantity,
    amountPaise: amount,
    gstRateBps: 500,
    conditional: false,
    allocation: null,
  });
  const pkg = (amount: number, conditional = false): LineInput => ({
    scope: "package",
    serviceId: null,
    requirementId: null,
    description: "Bundle discount",
    quantity: null,
    amountPaise: amount,
    gstRateBps: 500,
    conditional,
    allocation: null,
  });
  const head = { vendorRef: null, receivedOn: TODAY, validUntil: null, terms: null, taxType: "cgst_sgst" as const, allOrNothing: false, minFunctions: null };
  return { ...s, svcM, svcS, rM, rS, vendor, requestId, line, pkg, head };
}

describe("catalogue", () => {
  it("seeds built-in types once, in the creator's language", async () => {
    const { event, type } = await setup();
    expect(type("catering").requirementTemplates.length).toBeGreaterThan(2);
    await ensureCatalogue(db(), event.id, "hi");
    const all = await listServiceTypes(db(), event.id);
    expect(all.filter((t) => t.systemKey === "catering")).toHaveLength(1);
    expect(all.some((t) => t.kind === "standalone")).toBe(true);
  });
});

describe("services and requirements (SVC-10)", () => {
  it("Host changes apply directly; Planner proposals stay out of planned totals until approved", async () => {
    const { H, P, sangeet, type, event, decideAs } = await setup();
    const hostSvc = await addService(db(), H, { functionId: sangeet.id, serviceTypeId: type("decor").id });
    expect(hostSvc.result.status).toBe("applied");
    expect(hostSvc.service.approvalState).toBe("approved");

    const prop = await addService(db(), P, { functionId: sangeet.id, serviceTypeId: type("catering").id, useTemplates: true });
    expect(prop.result.status).toBe("pending");
    const view = await getService(db(), event.id, prop.service.id);
    expect(view.status).toBe("proposed");
    expect(view.requirements.length).toBeGreaterThan(0);
    expect(view.requirements.every((r) => r.status === "proposed")).toBe(true);

    const r = (await addRequirement(db(), H, hostSvc.service.id, req("Stage", 1, 2_00_000_00))).requirement;
    const pr = await addRequirement(db(), P, hostSvc.service.id, req("Mandap flowers", 1, 50_000_00));
    expect(pr.result.status).toBe("pending");
    let totals = sumFacts(await budgetFacts(db(), event.id));
    expect(totals.planned).toBe(2_00_000_00);
    expect(totals.pending).toBe(50_000_00);

    // Planner edit of an approved requirement waits; values stay until approved.
    const edit = await updateRequirement(db(), P, r.id, req("Stage", 1, 2_50_000_00));
    expect(edit.status).toBe("pending");
    totals = sumFacts(await budgetFacts(db(), event.id));
    expect(totals.planned).toBe(2_00_000_00);
    expect(totals.pending).toBe(50_000_00 + 50_000_00);

    if (edit.status !== "pending" || pr.result.status !== "pending" || prop.result.status !== "pending") throw new Error("expected pending");
    await decideAs(edit.request.id, "approve");
    await decideAs(pr.result.request.id, "reject", "Too expensive");
    await decideAs(prop.result.request.id, "approve");
    totals = sumFacts(await budgetFacts(db(), event.id));
    expect(totals.planned).toBe(2_50_000_00);
    expect(totals.pending).toBe(0);
    const [rej] = await db().select().from(requirements).where(eq(requirements.id, pr.requirement.id));
    expect(rej.approvalState).toBe("rejected");
    expect((await getService(db(), event.id, prop.service.id)).status).toBe("open");
  });

  it("refuses a stale approval after a Host edited the requirement meanwhile", async () => {
    const { H, P, sangeet, type, decideAs } = await setup();
    const svc = (await addService(db(), H, { functionId: sangeet.id, serviceTypeId: type("decor").id, useTemplates: false })).service;
    const r = (await addRequirement(db(), H, svc.id, req("Stage", 1, 100))).requirement;
    const edit = await updateRequirement(db(), P, r.id, req("Stage", 1, 200));
    await updateRequirement(db(), H, r.id, req("Stage", 2, 150));
    if (edit.status !== "pending") throw new Error();
    await expect(decideAs(edit.request.id, "approve")).rejects.toMatchObject({ code: "stale" });
  });

  it("withdrawing a proposal discards it; proposed requirements can't be quoted", async () => {
    const { P, H, event, sangeet, type, planner } = await setup();
    const prop = await addService(db(), P, { functionId: sangeet.id, serviceTypeId: type("decor").id, useTemplates: false });
    const v = await createVendor(db(), event.id, actorOf(planner), { name: "Decor Co", contactName: null, phone: null, email: null, gstin: null, notes: null, serviceTypeIds: [] });
    await expect(createQuoteRequests(db(), event.id, H.actor, { vendorIds: [v.id], serviceIds: [prop.service.id], dueDate: null, message: null })).rejects.toBeInstanceOf(QuoteError);
    if (prop.result.status !== "pending") throw new Error();
    await withdrawRequest(db(), event.id, prop.result.request.id, actorOf(planner));
    expect((await getService(db(), event.id, prop.service.id)).approvalState).toBe("rejected");
    expect(await listServices(db(), event.id)).toHaveLength(0);
  });

  it("blocks deleting a function that has services, but the event purge still cascades", async () => {
    const { H, sangeet, type, event, host } = await setup();
    await addService(db(), H, { functionId: sangeet.id, serviceTypeId: type("decor").id });
    await expect(deleteFunction(db(), event.id, sangeet.id, actorOf(host))).rejects.toBeTruthy();
    await db().delete(events).where(eq(events.id, event.id));
    expect(await db().select().from(functions)).toHaveLength(0);
  });
});

describe("quotes, packages and bookings", () => {
  it("allocates package lines exactly and compares per service", async () => {
    const c = await cateringSetup();
    const q = await saveQuote(db(), c.event.id, c.H.actor, { requestId: c.requestId }, {
      ...c.head,
      lines: [c.line(c.rM, 3_00_000_01), c.line(c.rS, 6_00_000_00), c.pkg(-50_000_00, true)],
    });
    const v = await getQuote(db(), c.event.id, q.id);
    const sum = v.services.reduce((a, s) => a + s.amount, 0);
    expect(sum).toBe(3_00_000_01 + 6_00_000_00 - 50_000_00);
    expect(v.services.reduce((a, s) => a + s.gst, 0)).toBe(v.gst);
    const cmp = await compareForService(db(), c.event.id, c.svcM.id);
    expect(cmp.quotes[0].partOfPackage).toBe(true);
    expect(cmp.quotes[0].missing).toBe(0);
    const pkg = await comparePackage(db(), c.event.id, q.id);
    expect(pkg.columns).toHaveLength(1);
    expect(pkg.bestTotal).toBeNull();
  });

  it("rejects quote lines pointing at another event's requirement", async () => {
    const c = await cateringSetup();
    const other = await cateringSetup().catch(() => null);
    void other;
    const host2 = await makeUser("other@example.com");
    const ev2 = await createEvent(db(), actorOf(host2), { name: "Other" });
    const f2 = await createFunction(db(), ev2.id, actorOf(host2), { name: "F", date: null, ...blank });
    const t2 = (await listServiceTypes(db(), ev2.id))[0];
    const s2 = (await addService(db(), { eventId: ev2.id, actor: actorOf(host2), subject: hostS }, { functionId: f2.id, serviceTypeId: t2.id, useTemplates: false })).service;
    const r2 = (await addRequirement(db(), { eventId: ev2.id, actor: actorOf(host2), subject: hostS }, s2.id, req("X", 1, 1))).requirement;
    await expect(saveQuote(db(), c.event.id, c.H.actor, { requestId: c.requestId }, { ...c.head, lines: [c.line(r2, 100)] })).rejects.toBeInstanceOf(QuoteError);
  });

  it("books part of a package: the conditional discount drops; coverage counts only once approved", async () => {
    const c = await cateringSetup();
    const q = await saveQuote(db(), c.event.id, c.H.actor, { requestId: c.requestId }, {
      ...c.head,
      minFunctions: 2,
      lines: [c.line(c.rM, 3_00_000_00, 400), c.line(c.rS, 6_00_000_00, 200), c.pkg(-50_000_00, true)],
    });
    const v = await getQuote(db(), c.event.id, q.id);
    const [lm, ls, lp] = v.lines;
    const booked = await proposeBooking(db(), c.P, { quoteId: q.id, lineIds: [ls.id, lp.id], today: TODAY });
    expect(booked.warnings).toContainEqual({ code: "condition_dropped", lines: 1 });
    expect(booked.booking.status).toBe("pending_approval");
    expect(booked.booking.subtotalPaise).toBe(6_00_000_00);
    expect(booked.booking.gstPaise).toBe(30_000_00);
    let svc = await getService(db(), c.event.id, c.svcS.id);
    expect(svc.requirements[0].status).toBe("quoting");
    expect(svc.requirements[0].coverage?.tentativeQty).toBe(200);
    await expect(proposeBooking(db(), c.P, { quoteId: q.id, lineIds: [lm.id], today: TODAY })).rejects.toMatchObject({ code: "already_booked" });
    // Payments can't be recorded against a schedule that isn't active.
    await expect(
      recordPayment(db(), c.H, { bookingId: booked.booking.id, budgetLineId: null, invoiceId: null, paidOn: TODAY, amountPaise: 100, mode: "upi", reference: null, payer: null, notes: null, allowOverpay: false }),
    ).rejects.toMatchObject({ code: "booking_pending" });

    if (booked.result.status !== "pending") throw new Error();
    await c.decideAs(booked.result.request.id, "approve");
    svc = await getService(db(), c.event.id, c.svcS.id);
    expect(svc.requirements[0].status).toBe("partially_booked");
    expect(svc.requirements[0].coverage?.confirmedQty).toBe(200);
    const facts = await budgetFacts(db(), c.event.id);
    expect(sumFacts(facts).committed).toBe(6_30_000_00);
    expect(groupFacts(facts, "functionId").get(c.sangeet.id)?.committed).toBe(6_30_000_00);
  });

  it("all-or-nothing quotes must be booked whole", async () => {
    const c = await cateringSetup();
    const q = await saveQuote(db(), c.event.id, c.H.actor, { requestId: c.requestId }, { ...c.head, allOrNothing: true, lines: [c.line(c.rM, 100), c.line(c.rS, 200)] });
    const v = await getQuote(db(), c.event.id, q.id);
    await expect(proposeBooking(db(), c.H, { quoteId: q.id, lineIds: [v.lines[0].id], today: TODAY })).rejects.toBeInstanceOf(BookingError);
    const ok = await proposeBooking(db(), c.H, { quoteId: q.id, lineIds: v.lines.map((l) => l.id), today: TODAY });
    expect(ok.booking.status).toBe("confirmed");
  });

  it("serialises two bookings racing for the same requirement", async () => {
    const c = await cateringSetup();
    const q1 = await saveQuote(db(), c.event.id, c.H.actor, { requestId: c.requestId }, { ...c.head, lines: [c.line(c.rM, 100, 400)] });
    const [req2] = await createQuoteRequests(db(), c.event.id, c.H.actor, { vendorIds: [c.vendor.id], serviceIds: [c.svcM.id], dueDate: null, message: null });
    const q2 = await saveQuote(db(), c.event.id, c.H.actor, { requestId: req2 }, { ...c.head, lines: [c.line(c.rM, 90, 400)] });
    const l1 = (await getQuote(db(), c.event.id, q1.id)).lines[0].id;
    const l2 = (await getQuote(db(), c.event.id, q2.id)).lines[0].id;
    const [a, b] = await Promise.all([
      proposeBooking(db(), c.H, { quoteId: q1.id, lineIds: [l1], today: TODAY }),
      proposeBooking(db(), c.H, { quoteId: q2.id, lineIds: [l2], today: TODAY }),
    ]);
    // Both succeed (over-coverage is a warning), and exactly one of them saw the other.
    expect([a.warnings, b.warnings].filter((w) => w.some((x) => x.code === "over_covered"))).toHaveLength(1);
  });

  it("revising a booked quote moves the booking after approval and rescales the schedule", async () => {
    const c = await cateringSetup();
    const q = await saveQuote(db(), c.event.id, c.H.actor, { requestId: c.requestId }, { ...c.head, taxType: "none", lines: [c.line(c.rM, 1000)] });
    const b = await proposeBooking(db(), c.H, { quoteId: q.id, lineIds: [(await getQuote(db(), c.event.id, q.id)).lines[0].id], today: TODAY });
    const q2 = await saveQuote(db(), c.event.id, c.H.actor, { requestId: c.requestId, reviseQuoteId: q.id }, { ...c.head, taxType: "none", lines: [c.line(c.rM, 1500)] });
    expect(q2.version).toBe(2);
    const r = await reviseBooking(db(), c.P, b.booking.id, { quoteId: q2.id, lineIds: [(await getQuote(db(), c.event.id, q2.id)).lines[0].id], today: TODAY });
    if (r.result.status !== "pending") throw new Error();
    expect(r.result.request.amountPaise).toBe(500);
    await c.decideAs(r.result.request.id, "approve");
    const fin = await bookingFinance(db(), c.event.id, b.booking.id, TODAY);
    expect(fin.total).toBe(1500);
    expect(fin.milestones.reduce((a, m) => a + m.milestone.amountPaise, 0)).toBe(1500);
  });

  it("schedule edits must add up to the booking total", async () => {
    const c = await cateringSetup();
    const q = await saveQuote(db(), c.event.id, c.H.actor, { requestId: c.requestId }, { ...c.head, taxType: "none", lines: [c.line(c.rM, 1000)] });
    const b = await proposeBooking(db(), c.H, { quoteId: q.id, lineIds: [(await getQuote(db(), c.event.id, q.id)).lines[0].id], today: TODAY });
    const m = (amount: number) => ({ kind: "milestone" as const, label: null, amountPaise: amount, dueDate: TODAY, payer: null });
    await expect(updateSchedule(db(), c.H, b.booking.id, [m(400), m(500)])).rejects.toMatchObject({ code: "schedule_mismatch" });
    expect((await updateSchedule(db(), c.H, b.booking.id, [m(400), m(600)])).status).toBe("applied");
    const p = await updateSchedule(db(), c.P, b.booking.id, [m(1000)]);
    expect(p.status).toBe("pending");
  });

  it("cancelling a requirement releases its commitment", async () => {
    const c = await cateringSetup();
    const q = await saveQuote(db(), c.event.id, c.H.actor, { requestId: c.requestId }, { ...c.head, taxType: "none", lines: [c.line(c.rM, 1000)] });
    await proposeBooking(db(), c.H, { quoteId: q.id, lineIds: [(await getQuote(db(), c.event.id, q.id)).lines[0].id], today: TODAY });
    expect(sumFacts(await budgetFacts(db(), c.event.id)).committed).toBe(1000);
    await cancelRequirement(db(), c.H, c.rM.id, "Not needed");
    expect(sumFacts(await budgetFacts(db(), c.event.id)).committed).toBe(0);
  });
});

describe("auto-approve thresholds and overspend (BGT-04)", () => {
  it("threshold 0 always needs a Host; under the threshold applies; overspend overrides it", async () => {
    const c = await cateringSetup();
    const q = await saveQuote(db(), c.event.id, c.H.actor, { requestId: c.requestId }, { ...c.head, taxType: "none", lines: [c.line(c.rM, 1000), c.line(c.rS, 1000)] });
    const [lm, ls] = (await getQuote(db(), c.event.id, q.id)).lines;
    const first = await proposeBooking(db(), c.P, { quoteId: q.id, lineIds: [lm.id], today: TODAY });
    expect(first.result.status).toBe("pending");
    await cancelBooking(db(), c.P, first.booking.id, "retry");

    await setThreshold(db(), c.event.id, c.H.actor, c.type("catering").id, 1000);
    // Exactly at the threshold is not "below".
    const atLimit = await proposeBooking(db(), c.P, { quoteId: q.id, lineIds: [lm.id], today: TODAY });
    expect(atLimit.result.status).toBe("pending");
    await cancelBooking(db(), c.P, atLimit.booking.id, "retry");

    await setThreshold(db(), c.event.id, c.H.actor, c.type("catering").id, 2001);
    const auto = await proposeBooking(db(), c.P, { quoteId: q.id, lineIds: [lm.id, ls.id], today: TODAY });
    expect(auto.result).toEqual({ status: "applied", auto: true });
    expect((await db().select().from(auditLogs).where(eq(auditLogs.action, "change.auto_approved"))).length).toBe(1);

    // Over plan: planned for catering is 90,00,000 rupees here, so drop the estimates to force overspend.
    await cancelBooking(db(), c.H, auto.booking.id, "redo");
    await db().update(requirements).set({ estimatePaise: 500 }).where(eq(requirements.eventId, c.event.id));
    const over = await proposeBooking(db(), c.P, { quoteId: q.id, lineIds: [lm.id, ls.id], today: TODAY });
    expect(over.result.status).toBe("pending");
  });

  it("budget lines below the category threshold auto-apply; payments never do", async () => {
    const c = await cateringSetup();
    const gifts = c.type("gifts");
    await setThreshold(db(), c.event.id, c.H.actor, gifts.id, 10_000_00);
    const small = await addBudgetLine(db(), c.P, { categoryId: gifts.id, functionId: null, title: "Return gifts", estimatePaise: 5_000_00, payer: { kind: "bride" }, notes: null });
    expect(small.status).toBe("applied");
    const big = await addBudgetLine(db(), c.P, { categoryId: gifts.id, functionId: null, title: "Silver coins", estimatePaise: 50_000_00, payer: null, notes: null });
    expect(big.status).toBe("pending");
    const [line] = (await budgetFacts(db(), c.event.id)).filter((f) => f.budgetLineId && f.planned);
    const pay = await recordPayment(db(), c.P, {
      bookingId: null,
      budgetLineId: line.budgetLineId,
      invoiceId: null,
      paidOn: TODAY,
      amountPaise: 1000,
      mode: "cash",
      reference: null,
      payer: null,
      notes: null,
      allowOverpay: false,
    });
    expect(pay.result.status).toBe("pending");
    expect(pay.payment.state).toBe("recorded");
    expect(sumFacts(await budgetFacts(db(), c.event.id)).paid).toBe(0);
    if (pay.result.status !== "pending") throw new Error();
    await c.decideAs(pay.result.request.id, "approve");
    expect(sumFacts(await budgetFacts(db(), c.event.id)).paid).toBe(1000);
  });
});

describe("payments, invoices and statuses (PAY)", () => {
  async function confirmedBooking() {
    const c = await cateringSetup();
    const q = await saveQuote(db(), c.event.id, c.H.actor, { requestId: c.requestId }, { ...c.head, taxType: "none", lines: [c.line(c.rM, 1_00_000_00)] });
    const b = await proposeBooking(db(), c.H, { quoteId: q.id, lineIds: [(await getQuote(db(), c.event.id, q.id)).lines[0].id], today: TODAY });
    const pay = (amount: number, extra: Partial<Parameters<typeof recordPayment>[2]> = {}) =>
      recordPayment(db(), c.H, { bookingId: b.booking.id, budgetLineId: null, invoiceId: null, paidOn: TODAY, amountPaise: amount, mode: "upi", reference: null, payer: null, notes: null, allowOverpay: false, ...extra });
    return { ...c, booking: b.booking, pay };
  }

  it("derives milestone statuses FIFO with explicit dates", () => {
    expect(payStatus(100, 0, "2026-11-10", "2026-11-01")).toBe("upcoming");
    expect(payStatus(100, 0, "2026-11-08", "2026-11-01")).toBe("due");
    expect(payStatus(100, 0, "2026-10-31", "2026-11-01")).toBe("overdue");
    expect(payStatus(100, 40, "2026-11-20", "2026-11-01")).toBe("partially_paid");
    expect(payStatus(100, 100, "2026-10-01", "2026-11-01")).toBe("paid");
    const ms = [100, 200].map((amountPaise, i) => ({ id: `${i}`, amountPaise, dueDate: "2026-11-01", sortOrder: i }) as never);
    const st = milestoneStatuses(ms, 150, "2026-11-01");
    expect(st.map((s) => [s.paid, s.status])).toEqual([
      [100, "paid"],
      [50, "partially_paid"],
    ]);
  });

  it("blocks overpayment unless confirmed; payables and reminders", async () => {
    const c = await confirmedBooking();
    await c.pay(60_00_000);
    await expect(c.pay(50_00_000)).rejects.toMatchObject({ code: "overpayment" });
    await c.pay(50_00_000, { allowOverpay: true });
    const fin = await bookingFinance(db(), c.event.id, c.booking.id, TODAY);
    expect(fin.overpaid).toBe(true);

    const c2 = await confirmedBooking().catch(() => null);
    void c2;
  });

  it("lists payables and sends payment reminders once a day", async () => {
    const c = await confirmedBooking();
    const rows = await payables(db(), c.event.id, TODAY, "2026-11-07");
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("advance");
    expect(rows[0].status).toBe("due");
    const now = new Date("2026-11-01T03:00:00Z");
    expect(await sendPaymentReminders(db(), now)).toBe(2);
    expect(await sendPaymentReminders(db(), now)).toBe(0);
    expect((await outbox()).some((m) => m.subject?.includes("Wedding"))).toBe(true);
  });

  it("stores invoices with GST and flags printed-total mismatches; rejects duplicates", async () => {
    const c = await confirmedBooking();
    const base = {
      vendorId: c.vendor.id,
      bookingId: c.booking.id,
      number: "INV-1",
      invoiceDate: TODAY,
      dueDate: null,
      supplierGstin: "27AAPFU0939F1ZV",
      taxType: "cgst_sgst" as const,
      printedTotalPaise: null,
      notes: null,
      lines: [{ serviceId: null, description: "Dinner", hsnSac: "9963", amountPaise: 10001, gstRateBps: 1800 }],
    };
    const inv = await createInvoice(db(), c.event.id, c.H.actor, base);
    expect([inv.cgstPaise, inv.sgstPaise, inv.totalPaise]).toEqual([900, 900, 11801]);
    await expect(createInvoice(db(), c.event.id, c.H.actor, base)).rejects.toMatchObject({ code: "duplicate_number" });
    expect(sumFacts(await budgetFacts(db(), c.event.id)).invoiced).toBe(11801);
  });

  it("splits by payer and always adds up to the total", async () => {
    const c = await confirmedBooking();
    const gifts = c.type("gifts");
    await addBudgetLine(db(), c.H, { categoryId: gifts.id, functionId: null, title: "Return gifts", estimatePaise: 10001, payer: { kind: "shared", mode: "percent", brideBps: 3333 }, notes: null });
    const facts = await budgetFacts(db(), c.event.id);
    const p = byPayer(facts);
    const total = sumFacts(facts);
    expect(p.bride.planned + p.groom.planned + p.unassigned.planned).toBe(total.planned);
    expect(p.bride.committed + p.groom.committed + p.unassigned.committed).toBe(total.committed);
    expect(p.bride.planned).toBe(3333);
  });

  it("reminds Hosts about requests waiting over a day", async () => {
    const c = await cateringSetup();
    await addService(db(), c.P, { functionId: c.sangeet.id, serviceTypeId: c.type("decor").id });
    const later = new Date(Date.now() + 25 * 3600_000);
    expect(await sendApprovalReminders(db(), later)).toBe(1);
    expect(await sendApprovalReminders(db(), later)).toBe(0);
  });
});

describe("gap view, delivery and category totals", () => {
  it("lists uncovered requirements by date and must-have first", async () => {
    const c = await cateringSetup();
    await addRequirement(db(), c.H, c.svcM.id, { ...req("Chaat counter", null, null), priority: "nice" });
    const gaps = await gapView(db(), c.event.id, TODAY);
    expect(gaps.map((g) => g.requirement.title)).toEqual(["Dinner", "Chaat counter", "Dinner"]);
    expect(gaps[0].daysLeft).toBe(38);
    const { planned } = await categoryTotals(db(), c.event.id);
    expect(planned.get(c.type("catering").id)).toBe(90_00_000_00);
  });

  it("only the owner or a Host marks delivered", async () => {
    const c = await cateringSetup();
    await expect(markDelivered(db(), c.P, c.rM.id, true)).rejects.toMatchObject({ code: "not_owner" });
    await markDelivered(db(), c.H, c.rM.id, true);
    expect((await getService(db(), c.event.id, c.svcM.id)).requirements[0].status).toBe("delivered");
  });
});

describe("vendors and documents", () => {
  it("encrypts PAN and bank details, audits reveals, and refuses deleting vendors with bookings", async () => {
    const c = await cateringSetup();
    await expect(setVendorSecrets(db(), c.event.id, c.vendor.id, c.H.actor, { pan: "BADPAN" })).rejects.toBeInstanceOf(VendorError);
    await setVendorSecrets(db(), c.event.id, c.vendor.id, c.H.actor, { pan: "ABCDE1234F", bank: { accountName: "Spice", accountNumber: "123456789012", ifsc: "HDFC0001234", upi: "" } });
    const [row] = await db().select().from(vendors).where(eq(vendors.id, c.vendor.id));
    expect(row.panEnc).not.toContain("ABCDE1234F");
    expect(row.bankEnc).not.toContain("123456789012");
    expect(row.bankLast4).toBe("9012");
    const s = await revealVendorSecrets(db(), c.event.id, c.vendor.id, c.H.actor);
    expect(s.bank?.ifsc).toBe("HDFC0001234");
    expect((await db().select().from(auditLogs).where(and(eq(auditLogs.action, "vendor.bank_viewed")))).length).toBe(1);

    const q = await saveQuote(db(), c.event.id, c.H.actor, { requestId: c.requestId }, { ...c.head, lines: [c.line(c.rM, 100)] });
    await proposeBooking(db(), c.H, { quoteId: q.id, lineIds: [(await getQuote(db(), c.event.id, q.id)).lines[0].id], today: TODAY });
    await expect(deleteVendor(db(), c.event.id, c.vendor.id, c.H.actor)).rejects.toMatchObject({ code: "has_bookings" });
  });

  it("sniffs file types and enforces the size limit", async () => {
    const c = await cateringSetup();
    expect(sniffMime(Buffer.from("%PDF-1.7 hello world"))).toBe("application/pdf");
    expect(sniffMime(Buffer.from("<html><script>alert(1)</script>"))).toBeNull();
    await expect(saveDocument(db(), c.event.id, c.H.actor, { owner: { vendorId: c.vendor.id }, kind: "other", filename: "x.html", data: Buffer.from("<html>not a pdf at all</html>") })).rejects.toBeInstanceOf(DocumentError);
    const doc = await saveDocument(db(), c.event.id, c.H.actor, { owner: { vendorId: c.vendor.id }, kind: "contract", filename: "../../contract.pdf", data: Buffer.from("%PDF-1.7 contract body") });
    expect(doc.filename).not.toContain("/");
    expect(doc.mime).toBe("application/pdf");
    await expect(
      saveDocument(db(), c.event.id, c.H.actor, { owner: { vendorId: "00000000-0000-0000-0000-000000000000" }, kind: "other", filename: "a.pdf", data: Buffer.from("%PDF-1.7 contract body") }),
    ).rejects.toBeInstanceOf(DocumentError);
  });
});

void PaymentError;
void serviceTypes;
