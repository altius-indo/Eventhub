import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { catererHeadcountState, events, functionInvites, guests, households, notifications, type Household } from "@/db/schema";
import "@/lib/approval-handlers";
import { proposeBooking } from "@/lib/bookings";
import { listServiceTypes } from "@/lib/catalogue";
import {
  acknowledgeHeadcount,
  alertDue,
  bookingHeadcountLocks,
  checkHeadcountAlerts,
  getCatererView,
  releaseFinalCount,
  setHeadcountLock,
  suggestedLockAt,
  zonedInstant,
} from "@/lib/caterer-headcount";
import { createEvent } from "@/lib/events";
import { createFunction } from "@/lib/functions";
import type { PolicySubject } from "@/lib/policy";
import { createQuoteRequests, getQuote, saveQuote } from "@/lib/quotes";
import { saveRsvps } from "@/lib/rsvp";
import { addRequirement, addService } from "@/lib/services";
import { inviteVendorContact } from "@/lib/vendor-access";
import { createVendor } from "@/lib/vendors";
import { actorOf, db, makeUser, resetDb } from "./helpers";

beforeEach(resetDb);

const hostS: PolicySubject = { isAppAdmin: false, membership: { role: "host", giftAccess: "none" } };
const blank = { startTime: "19:00", endTime: null, venueName: null, venueAddress: null, mapUrl: null, dressCode: null, description: null };
const TODAY = "2026-11-01";

async function setup() {
  const host = await makeUser("host@example.com", "Asha");
  const event = await createEvent(db(), actorOf(host), { name: "Wedding", startDate: "2026-12-09" });
  const H = { eventId: event.id, actor: actorOf(host), subject: hostS };
  const mehendi = await createFunction(db(), event.id, actorOf(host), { name: "Mehendi", date: "2026-12-09", ...blank });
  const sangeet = await createFunction(db(), event.id, actorOf(host), { name: "Sangeet", date: "2026-12-10", ...blank });
  const catering = (await listServiceTypes(db(), event.id)).find((t) => t.systemKey === "catering")!;
  const svc = (await addService(db(), H, { functionId: mehendi.id, serviceTypeId: catering.id, useTemplates: false, ownerUserId: host.id })).service;
  const req = (
    await addRequirement(db(), H, svc.id, { title: "Lunch", quantity: 400, unit: "plates", specs: null, startsAt: null, endsAt: null, venue: null, estimatePaise: 1_00_000_00, priority: "must", payer: null })
  ).requirement;

  /** Books `vendorName` for `quantity` plates of the Mehendi lunch (a Host booking applies directly). */
  async function bookCaterer(vendorName: string, contact: string, quantity: number | null) {
    const vendor = await createVendor(db(), event.id, actorOf(host), { name: vendorName, contactName: null, phone: null, email: null, gstin: null, notes: null, serviceTypeIds: [catering.id] });
    await inviteVendorContact(db(), { eventId: event.id, vendorId: vendor.id, identifier: { type: "email", value: contact }, actor: actorOf(host), appUrl: "" });
    const user = await makeUser(contact, vendorName);
    const [requestId] = await createQuoteRequests(db(), event.id, actorOf(host), { vendorIds: [vendor.id], serviceIds: [svc.id], dueDate: null, message: null });
    const q = await saveQuote(db(), event.id, actorOf(host), { requestId }, {
      vendorRef: null,
      receivedOn: TODAY,
      validUntil: null,
      terms: null,
      taxType: "none",
      allOrNothing: false,
      minFunctions: null,
      lines: [{ scope: "requirement", serviceId: svc.id, requirementId: req.id, description: null, quantity, amountPaise: 2_00_000_00, gstRateBps: 0, conditional: false, allocation: null }],
    });
    const v = await getQuote(db(), event.id, q.id);
    const b = await proposeBooking(db(), H, { quoteId: q.id, lineIds: [v.lines[0].id], today: TODAY });
    return { vendor, user, booking: b.booking };
  }

  /** A family of `n` guests invited to the given functions. */
  async function family(name: string, n: number, fnIds: string[], extra: Partial<typeof guests.$inferInsert> = {}) {
    const [h] = await db().insert(households).values({ eventId: event.id, name, side: "bride" }).returning();
    const gs = await db()
      .insert(guests)
      .values(Array.from({ length: n }, (_, i) => ({ eventId: event.id, householdId: h.id, name: `${name} ${i + 1}`, phone: `+9198765${String(i).padStart(5, "0")}`, ...extra })))
      .returning();
    await db().insert(functionInvites).values(gs.flatMap((g) => fnIds.map((functionId) => ({ functionId, guestId: g.id }))));
    return { household: h, guests: gs };
  }

  const answer = (h: { household: Household; guests: { id: string }[] }, functionId: string, status: "attending" | "maybe" | "declined" | null, now?: Date) =>
    saveRsvps(db(), { household: h.household, event, answers: h.guests.map((g) => ({ guestId: g.id, functionId, status })), recordedBy: actorOf(host), now });

  return { host, event, mehendi, sangeet, svc, req, bookCaterer, family, answer };
}

describe("thresholds and time (RSV-06/07)", () => {
  it("alerts at ±abs or ±pct%, whichever comes first (exactly the limit counts)", () => {
    expect(alertDue(1000, 1020, 5, 20)).toBe(true);
    expect(alertDue(1000, 1019, 5, 20)).toBe(false);
    expect(alertDue(1000, 980, 5, 20)).toBe(true);
    expect(alertDue(100, 105, 5, 20)).toBe(true);
    expect(alertDue(100, 104, 5, 20)).toBe(false);
    expect(alertDue(0, 3, 5, 20)).toBe(false);
    expect(alertDue(50, 50, 5, 20)).toBe(false);
  });

  it("suggests 72 hours before the function starts, in the event timezone", () => {
    expect(zonedInstant("2026-12-10", "19:00", "Asia/Kolkata").toISOString()).toBe("2026-12-10T13:30:00.000Z");
    expect(suggestedLockAt({ date: "2026-12-10", startTime: "19:00:00" }, "Asia/Kolkata")?.toISOString()).toBe("2026-12-07T13:30:00.000Z");
    expect(suggestedLockAt({ date: null, startTime: null }, "Asia/Kolkata")).toBeNull();
  });
});

describe("caterer live headcount (RSV-06)", () => {
  it("shows aggregates only, for booked functions only", async () => {
    const s = await setup();
    const { vendor } = await s.bookCaterer("Spice", "chef@spice.in", null);
    const sharma = await s.family("Sharma", 3, [s.mehendi.id, s.sangeet.id], { diet: "jain", dietNotes: "No onion" });
    const kids = await s.family("Verma", 2, [s.mehendi.id], { ageGroup: "child", diet: "veg" });
    const later = await s.family("Gupta", 4, [s.mehendi.id]);
    await s.answer(sharma, s.mehendi.id, "attending");
    await s.answer(kids, s.mehendi.id, "maybe");
    void later;

    const view = await getCatererView(db(), s.event.id, vendor.id, s.mehendi.id);
    expect(view.snapshot).toMatchObject({ confirmed: 3, maybe: 2, pending: 4, adults: 3, children: 0, allergies: 3 });
    expect(view.snapshot.diet.jain).toBe(3);
    expect(view.total).toBe(5);
    const json = JSON.stringify(view);
    expect(json).not.toContain("Sharma");
    expect(json).not.toContain("+9198765");
    // Not booked for the Sangeet.
    await expect(getCatererView(db(), s.event.id, vendor.id, s.sangeet.id)).rejects.toMatchObject({ code: "not_found" });
    // Viewing set the baseline.
    const [st] = await db().select().from(catererHeadcountState).where(eq(catererHeadcountState.functionId, s.mehendi.id));
    expect(st.baselineTotal).toBe(5);
  });

  it("split bookings show each caterer its own contracted share", async () => {
    const s = await setup();
    const a = await s.bookCaterer("Spice", "a@spice.in", 250);
    const b = await s.bookCaterer("Tadka", "b@tadka.in", 150);
    expect((await getCatererView(db(), s.event.id, a.vendor.id, s.mehendi.id)).share).toEqual({ quantity: 250, of: 400 });
    expect((await getCatererView(db(), s.event.id, b.vendor.id, s.mehendi.id)).share).toEqual({ quantity: 150, of: 400 });
  });

  it("alerts the caterer and the service owner once per move past the threshold; acknowledging resets", async () => {
    const s = await setup();
    const { vendor, user } = await s.bookCaterer("Spice", "chef@spice.in", null);
    await db().update(events).set({ headcountAlertPct: 100, headcountAlertAbs: 20 }).where(eq(events.id, s.event.id));
    const base = await s.family("Base", 30, [s.mehendi.id]);
    await s.answer(base, s.mehendi.id, "attending");
    await getCatererView(db(), s.event.id, vendor.id, s.mehendi.id); // baseline 30
    const kinds = async (userId: string) => (await db().select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.kind, "headcount.changed")))).length;

    const more = await s.family("More", 19, [s.mehendi.id]);
    await s.answer(more, s.mehendi.id, "attending");
    expect(await checkHeadcountAlerts(db())).toBe(0); // +19 < 20 and < 100%
    const one = await s.family("One", 1, [s.mehendi.id]);
    await s.answer(one, s.mehendi.id, "maybe");
    expect(await checkHeadcountAlerts(db())).toBe(1); // exactly +20
    expect(await kinds(user.id)).toBe(1);
    expect(await kinds(s.host.id)).toBe(1);
    expect(await checkHeadcountAlerts(db())).toBe(0); // once per move

    // The caterer acknowledges 50; small changes after that don't alert.
    await acknowledgeHeadcount(db(), { eventId: s.event.id, vendorId: vendor.id, functionId: s.mehendi.id, actor: actorOf(user) });
    const view = await getCatererView(db(), s.event.id, vendor.id, s.mehendi.id);
    expect(view.change).toBe(0);
    expect(view.baselineTotal).toBe(50);
    await s.answer(one, s.mehendi.id, "declined");
    expect(await checkHeadcountAlerts(db())).toBe(0);
    expect((await getCatererView(db(), s.event.id, vendor.id, s.mehendi.id)).change).toBe(-1);
  });

  it("percentage threshold triggers before the absolute one", async () => {
    const s = await setup();
    const { vendor } = await s.bookCaterer("Spice", "chef@spice.in", null);
    const base = await s.family("Base", 40, [s.mehendi.id]);
    await s.answer(base, s.mehendi.id, "attending");
    await getCatererView(db(), s.event.id, vendor.id, s.mehendi.id); // baseline 40, default 5% = 2
    const two = await s.family("Two", 2, [s.mehendi.id]);
    await s.answer(two, s.mehendi.id, "attending");
    expect(await checkHeadcountAlerts(db())).toBe(1);
  });
});

describe("final headcount lock (RSV-07)", () => {
  it("freezes before a post-lock RSVP lands; staff see the delta and can release", async () => {
    const s = await setup();
    const { vendor, user, booking } = await s.bookCaterer("Spice", "chef@spice.in", null);
    const a = await s.family("A", 10, [s.mehendi.id]);
    const late = await s.family("Late", 5, [s.mehendi.id]);
    await s.answer(a, s.mehendi.id, "attending", new Date("2026-12-01T00:00:00Z"));

    const lockAt = new Date("2026-12-06T13:30:00Z");
    await setHeadcountLock(db(), { eventId: s.event.id, actor: actorOf(s.host), bookingId: booking.id, functionId: s.mehendi.id, lockAt, now: new Date("2026-12-01T00:00:00Z") });
    let [st] = await db().select().from(catererHeadcountState).where(eq(catererHeadcountState.bookingId, booking.id));
    expect(st.frozenAt).toBeNull();

    // An RSVP after the lock time: the lock freezes first, with the earlier count.
    await s.answer(late, s.mehendi.id, "attending", new Date("2026-12-07T00:00:00Z"));
    [st] = await db().select().from(catererHeadcountState).where(eq(catererHeadcountState.bookingId, booking.id));
    expect(st.frozenAt?.toISOString()).toBe("2026-12-07T00:00:00.000Z");
    expect(st.lockedSnapshot?.confirmed).toBe(10);

    const view = await getCatererView(db(), s.event.id, vendor.id, s.mehendi.id, new Date("2026-12-07T01:00:00Z"));
    expect(view.frozen).toBe(true);
    expect(view.total).toBe(10);
    const [staff] = await bookingHeadcountLocks(db(), s.event.id, booking.id, "Asia/Kolkata", new Date("2026-12-07T01:00:00Z"));
    expect(staff).toMatchObject({ frozen: true, lockedTotal: 10, liveTotal: 15, delta: 5 });

    await releaseFinalCount(db(), { eventId: s.event.id, actor: actorOf(s.host), bookingId: booking.id, functionId: s.mehendi.id });
    expect((await getCatererView(db(), s.event.id, vendor.id, s.mehendi.id, new Date("2026-12-07T02:00:00Z"))).total).toBe(15);
    const locked = await db().select().from(notifications).where(and(eq(notifications.userId, user.id), eq(notifications.kind, "headcount.locked")));
    expect(locked.map((n) => n.data.total)).toEqual([10, 15]);
  });

  it("release needs a lock; clearing the lock unfreezes", async () => {
    const s = await setup();
    const { vendor, booking } = await s.bookCaterer("Spice", "chef@spice.in", null);
    await expect(releaseFinalCount(db(), { eventId: s.event.id, actor: actorOf(s.host), bookingId: booking.id, functionId: s.mehendi.id })).rejects.toMatchObject({ code: "not_locked" });
    await expect(
      setHeadcountLock(db(), { eventId: s.event.id, actor: actorOf(s.host), bookingId: booking.id, functionId: s.sangeet.id, lockAt: new Date() }),
    ).rejects.toMatchObject({ code: "not_found" });
    await setHeadcountLock(db(), { eventId: s.event.id, actor: actorOf(s.host), bookingId: booking.id, functionId: s.mehendi.id, lockAt: new Date("2026-01-01T00:00:00Z") });
    expect((await getCatererView(db(), s.event.id, vendor.id, s.mehendi.id)).frozen).toBe(true);
    await setHeadcountLock(db(), { eventId: s.event.id, actor: actorOf(s.host), bookingId: booking.id, functionId: s.mehendi.id, lockAt: null });
    expect((await getCatererView(db(), s.event.id, vendor.id, s.mehendi.id)).frozen).toBe(false);
  });
});
