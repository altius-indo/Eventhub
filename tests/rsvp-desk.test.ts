import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLogs, catererHeadcountState, functionInvites, guests, households, rsvps } from "@/db/schema";
import "@/lib/approval-handlers";
import { proposeBooking } from "@/lib/bookings";
import { listServiceTypes } from "@/lib/catalogue";
import { setHeadcountLock } from "@/lib/caterer-headcount";
import { createEvent } from "@/lib/events";
import { createFunction } from "@/lib/functions";
import type { PolicySubject } from "@/lib/policy";
import { createQuoteRequests, getQuote, saveQuote } from "@/lib/quotes";
import { rsvpDesk, RsvpError, setHouseholdRsvp, setRsvp } from "@/lib/rsvp";
import { addRequirement, addService } from "@/lib/services";
import { createVendor } from "@/lib/vendors";
import { actorOf, db, makeUser, resetDb } from "./helpers";

beforeEach(resetDb);

const blank = { startTime: "19:00", endTime: null, venueName: null, venueAddress: null, mapUrl: null, dressCode: null, description: null };

async function setup() {
  const host = await makeUser("host@example.com", "Asha");
  const actor = actorOf(host);
  const event = await createEvent(db(), actor, { name: "Wedding", startDate: "2026-12-09" });
  const mehendi = await createFunction(db(), event.id, actor, { name: "Mehendi", date: "2026-12-09", ...blank });
  const sangeet = await createFunction(db(), event.id, actor, { name: "Sangeet", date: "2026-12-10", ...blank });

  async function family(name: string, members: { name: string; phone?: string }[], fnIds: string[], eventId = event.id) {
    const [h] = await db().insert(households).values({ eventId, name, side: "bride" }).returning();
    const gs = await db()
      .insert(guests)
      .values(members.map((m, i) => ({ eventId, householdId: h.id, name: m.name, phone: m.phone ?? null, sortOrder: i, isHead: i === 0 })))
      .returning();
    if (fnIds.length) await db().insert(functionInvites).values(gs.flatMap((g) => fnIds.map((functionId) => ({ functionId, guestId: g.id }))));
    return { household: h, guests: gs };
  }
  return { host, actor, event, mehendi, sangeet, family };
}

const answerOf = async (guestId: string, functionId: string) =>
  (await db().select().from(rsvps).where(and(eq(rsvps.guestId, guestId), eq(rsvps.functionId, functionId))))[0];

describe("setRsvp (RSV-04)", () => {
  it("records, changes and clears one member's reply, recorded by the team member and audited", async () => {
    const s = await setup();
    const sharma = await s.family("Sharma", [{ name: "Rajesh" }, { name: "Sunita" }], [s.mehendi.id]);
    const [rajesh] = sharma.guests;

    expect(await setRsvp(db(), s.event.id, s.actor, { guestId: rajesh.id, functionId: s.mehendi.id, status: "attending" })).toBe(1);
    expect(await answerOf(rajesh.id, s.mehendi.id)).toMatchObject({ status: "attending", recordedBy: s.host.id });
    // Same answer again: nothing changes, no extra audit entry.
    expect(await setRsvp(db(), s.event.id, s.actor, { guestId: rajesh.id, functionId: s.mehendi.id, status: "attending" })).toBe(0);
    expect(await setRsvp(db(), s.event.id, s.actor, { guestId: rajesh.id, functionId: s.mehendi.id, status: "maybe" })).toBe(1);
    expect(await setRsvp(db(), s.event.id, s.actor, { guestId: rajesh.id, functionId: s.mehendi.id, status: null })).toBe(1);
    expect(await answerOf(rajesh.id, s.mehendi.id)).toBeUndefined();
    // The other member was never touched.
    expect(await answerOf(sharma.guests[1].id, s.mehendi.id)).toBeUndefined();

    const entries = await db().select().from(auditLogs).where(and(eq(auditLogs.eventId, s.event.id), eq(auditLogs.action, "rsvp.recorded")));
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ entityType: "household", entityId: sharma.household.id, actorUserId: s.host.id });
    expect(entries.map((e) => (e.data as { status: string }).status).sort()).toEqual(["attending", "maybe", "pending"]);
  });

  it("rejects guests not invited to the function, other events' guests and functions, and bad ids", async () => {
    const s = await setup();
    const sharma = await s.family("Sharma", [{ name: "Rajesh" }], [s.mehendi.id]);
    const other = await createEvent(db(), s.actor, { name: "Other" });
    const otherFn = await createFunction(db(), other.id, s.actor, { name: "Mehendi", date: null, ...blank });
    const stranger = await s.family("Stranger", [{ name: "X" }], [otherFn.id], other.id);

    const tries = [
      { guestId: sharma.guests[0].id, functionId: s.sangeet.id }, // not invited
      { guestId: stranger.guests[0].id, functionId: otherFn.id }, // other event
      { guestId: stranger.guests[0].id, functionId: s.mehendi.id },
      { guestId: sharma.guests[0].id, functionId: otherFn.id },
    ];
    for (const t of tries) {
      await expect(setRsvp(db(), s.event.id, s.actor, { ...t, status: "attending" })).rejects.toBeInstanceOf(RsvpError);
    }
    await expect(setRsvp(db(), s.event.id, s.actor, { guestId: "nope", functionId: s.mehendi.id, status: "attending" })).rejects.toMatchObject({ code: "not_invited" });
    await expect(setHouseholdRsvp(db(), s.event.id, s.actor, { householdId: stranger.household.id, functionId: otherFn.id, status: "attending" })).rejects.toMatchObject({
      code: "not_invited",
    });
    expect(await db().select().from(rsvps)).toHaveLength(0);
  });

  it("whole family: every member invited to that function, others untouched", async () => {
    const s = await setup();
    const fam = await s.family("Verma", [{ name: "Anil" }, { name: "Kiran" }], [s.mehendi.id]);
    // A third member is invited only to the Sangeet.
    const [extra] = await db().insert(guests).values({ eventId: s.event.id, householdId: fam.household.id, name: "Dev", sortOrder: 2 }).returning();
    await db().insert(functionInvites).values({ functionId: s.sangeet.id, guestId: extra.id });

    expect(await setHouseholdRsvp(db(), s.event.id, s.actor, { householdId: fam.household.id, functionId: s.mehendi.id, status: "attending" })).toBe(2);
    expect(await answerOf(extra.id, s.mehendi.id)).toBeUndefined();
    expect(await setHouseholdRsvp(db(), s.event.id, s.actor, { householdId: fam.household.id, functionId: s.mehendi.id, status: "declined" })).toBe(2);
    const audits = await db().select().from(auditLogs).where(and(eq(auditLogs.eventId, s.event.id), eq(auditLogs.action, "rsvp.recorded")));
    expect(audits).toHaveLength(2);
  });

  it("freezes a due caterer lock before the reply lands (RSV-07)", async () => {
    const s = await setup();
    const H = { eventId: s.event.id, actor: s.actor, subject: { isAppAdmin: false, membership: { role: "host", giftAccess: "none" } } as PolicySubject };
    const catering = (await listServiceTypes(db(), s.event.id)).find((t) => t.systemKey === "catering")!;
    const svc = (await addService(db(), H, { functionId: s.mehendi.id, serviceTypeId: catering.id, useTemplates: false, ownerUserId: s.host.id })).service;
    const req = (
      await addRequirement(db(), H, svc.id, { title: "Lunch", quantity: 100, unit: "plates", specs: null, startsAt: null, endsAt: null, venue: null, estimatePaise: 1_00_000_00, priority: "must", payer: null })
    ).requirement;
    const vendor = await createVendor(db(), s.event.id, s.actor, { name: "Spice", contactName: null, phone: null, email: null, gstin: null, notes: null, serviceTypeIds: [catering.id] });
    const [requestId] = await createQuoteRequests(db(), s.event.id, s.actor, { vendorIds: [vendor.id], serviceIds: [svc.id], dueDate: null, message: null });
    const q = await saveQuote(db(), s.event.id, s.actor, { requestId }, {
      vendorRef: null,
      receivedOn: "2026-11-01",
      validUntil: null,
      terms: null,
      taxType: "none",
      allOrNothing: false,
      minFunctions: null,
      lines: [{ scope: "requirement", serviceId: svc.id, requirementId: req.id, description: null, quantity: null, amountPaise: 1_00_000_00, gstRateBps: 0, conditional: false, allocation: null }],
    });
    const v = await getQuote(db(), s.event.id, q.id);
    const { booking } = await proposeBooking(db(), H, { quoteId: q.id, lineIds: [v.lines[0].id], today: "2026-11-01" });

    const fam = await s.family("A", [{ name: "A1" }, { name: "A2" }], [s.mehendi.id]);
    await setRsvp(db(), s.event.id, s.actor, { guestId: fam.guests[0].id, functionId: s.mehendi.id, status: "attending" }, new Date("2026-12-01T00:00:00Z"));
    await setHeadcountLock(db(), { eventId: s.event.id, actor: s.actor, bookingId: booking.id, functionId: s.mehendi.id, lockAt: new Date("2026-12-06T13:30:00Z"), now: new Date("2026-12-01T00:00:00Z") });

    await setRsvp(db(), s.event.id, s.actor, { guestId: fam.guests[1].id, functionId: s.mehendi.id, status: "attending" }, new Date("2026-12-07T00:00:00Z"));
    const [st] = await db().select().from(catererHeadcountState).where(eq(catererHeadcountState.bookingId, booking.id));
    expect(st.frozenAt?.toISOString()).toBe("2026-12-07T00:00:00.000Z");
    expect(st.lockedSnapshot?.confirmed).toBe(1);
  });
});

describe("rsvpDesk", () => {
  it("counts the whole function and filters by search and reply tab, grouped by family", async () => {
    const s = await setup();
    const sharma = await s.family("Sharma", [{ name: "Rajesh", phone: "+919876543210" }, { name: "Sunita" }], [s.mehendi.id, s.sangeet.id]);
    const verma = await s.family("Verma", [{ name: "Anil" }, { name: "Kiran" }, { name: "Dev" }], [s.mehendi.id]);
    await s.family("Gupta", [{ name: "Neha" }], [s.sangeet.id]);
    await setRsvp(db(), s.event.id, s.actor, { guestId: sharma.guests[0].id, functionId: s.mehendi.id, status: "attending" });
    await setRsvp(db(), s.event.id, s.actor, { guestId: verma.guests[0].id, functionId: s.mehendi.id, status: "maybe" });
    await setRsvp(db(), s.event.id, s.actor, { guestId: verma.guests[1].id, functionId: s.mehendi.id, status: "declined" });
    // Replies for another function don't count here.
    await setRsvp(db(), s.event.id, s.actor, { guestId: sharma.guests[1].id, functionId: s.sangeet.id, status: "attending" });

    const all = await rsvpDesk(db(), s.event.id, s.mehendi.id);
    expect(all.counts).toEqual({ invited: 5, attending: 1, maybe: 1, declined: 1, pending: 2, households: 2 });
    expect(all.households.map((h) => [h.name, h.members.map((m) => [m.name, m.status])])).toEqual([
      ["Sharma", [["Rajesh", "attending"], ["Sunita", null]]],
      ["Verma", [["Anil", "maybe"], ["Kiran", "declined"], ["Dev", null]]],
    ]);

    const pending = await rsvpDesk(db(), s.event.id, s.mehendi.id, { status: "pending" });
    expect(pending.households.flatMap((h) => h.members.map((m) => m.name))).toEqual(["Sunita", "Dev"]);
    expect(pending.counts.invited).toBe(5);
    expect((await rsvpDesk(db(), s.event.id, s.mehendi.id, { status: "declined" })).matchingGuests).toBe(1);
    expect((await rsvpDesk(db(), s.event.id, s.mehendi.id, { q: "verma" })).matchingGuests).toBe(3);
    expect((await rsvpDesk(db(), s.event.id, s.mehendi.id, { q: "98765 432" })).households.map((h) => h.name)).toEqual(["Sharma"]);
    expect((await rsvpDesk(db(), s.event.id, s.mehendi.id, { q: "100%_" })).matchingGuests).toBe(0);
    // Unknown tab values are ignored, not errors.
    expect((await rsvpDesk(db(), s.event.id, s.mehendi.id, { status: "x" })).matchingGuests).toBe(5);

    // Another event's id for the function returns nothing.
    const other = await createEvent(db(), s.actor, { name: "Other" });
    expect((await rsvpDesk(db(), other.id, s.mehendi.id)).counts.invited).toBe(0);
  });

  it("on a filtered view, whole-family only changes the members shown", async () => {
    const s = await setup();
    const fam = await s.family("Verma", [{ name: "Anil" }, { name: "Kiran" }, { name: "Dev" }], [s.mehendi.id]);
    await setRsvp(db(), s.event.id, s.actor, { guestId: fam.guests[0].id, functionId: s.mehendi.id, status: "declined" });

    // Pending tab: Kiran and Dev shown, Anil hidden.
    const pending = await rsvpDesk(db(), s.event.id, s.mehendi.id, { status: "pending" });
    expect(pending.households[0]).toMatchObject({ invitedMembers: 3 });
    expect(pending.households[0].members.map((m) => m.name)).toEqual(["Kiran", "Dev"]);
    // Unfiltered, the family is complete.
    expect((await rsvpDesk(db(), s.event.id, s.mehendi.id)).households[0]).toMatchObject({ invitedMembers: 3 });

    const shownIds = pending.households[0].members.map((m) => m.id);
    expect(await setHouseholdRsvp(db(), s.event.id, s.actor, { householdId: fam.household.id, guestIds: shownIds, functionId: s.mehendi.id, status: "attending" })).toBe(2);
    expect((await answerOf(fam.guests[0].id, s.mehendi.id))?.status).toBe("declined");
    expect((await answerOf(fam.guests[2].id, s.mehendi.id))?.status).toBe("attending");

    // Ids from another family are ignored, and an empty list is rejected rather than meaning "everyone".
    const other = await s.family("Sharma", [{ name: "Rajesh" }], [s.mehendi.id]);
    await expect(
      setHouseholdRsvp(db(), s.event.id, s.actor, { householdId: fam.household.id, guestIds: [other.guests[0].id], functionId: s.mehendi.id, status: "declined" }),
    ).rejects.toMatchObject({ code: "not_invited" });
    await expect(setHouseholdRsvp(db(), s.event.id, s.actor, { householdId: fam.household.id, guestIds: [], functionId: s.mehendi.id, status: "declined" })).rejects.toMatchObject({
      code: "not_invited",
    });
    expect(await answerOf(other.guests[0].id, s.mehendi.id)).toBeUndefined();
  });

  it("pages by family", async () => {
    const s = await setup();
    for (let i = 0; i < 45; i++) await s.family(`F${String(i).padStart(2, "0")}`, [{ name: `G${i}` }], [s.mehendi.id]);
    const p1 = await rsvpDesk(db(), s.event.id, s.mehendi.id, { page: 1 });
    expect(p1).toMatchObject({ totalHouseholds: 45, pages: 2, page: 1 });
    expect(p1.households).toHaveLength(40);
    const p2 = await rsvpDesk(db(), s.event.id, s.mehendi.id, { page: 9 });
    expect(p2.page).toBe(2);
    expect(p2.households.map((h) => h.name)).toEqual(["F40", "F41", "F42", "F43", "F44"]);
  });
});
