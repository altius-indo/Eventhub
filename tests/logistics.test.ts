import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLogs, checkIns } from "@/db/schema";
import { addWalkIn, checkIn, checkInCounts, extractToken, lookupPass, searchForCheckIn, undoCheckIn } from "@/lib/checkin";
import { createEvent } from "@/lib/events";
import { createFunction } from "@/lib/functions";
import { makeGuestToken, makePassToken, regenerateGuestLink } from "@/lib/guest-links";
import { createHousehold, guestSchema, setGuestInvites } from "@/lib/guests";
import {
  allocationView,
  assignRoom,
  blockSchema,
  createBlock,
  createHotel,
  listHotels,
  HotelError,
  roomingList,
  roomsForHousehold,
  updateBlock,
} from "@/lib/hotels";
import { decide } from "@/lib/policy";
import { saveRsvps } from "@/lib/rsvp";
import { createItem, itemSchema, liveView, listItems, lockedOverlaps, shiftItems } from "@/lib/runsheet";
import { addTables, seatGuests, seatHousehold, seatingPlan, SeatingError } from "@/lib/seating";
import { arrivalsBoard, assignToRun, createRun, getManifest, listRuns, manifestText, runSchema, runsForHousehold, runWarnings, TransferError, updateRun } from "@/lib/transfers";
import { saveTravel, travelSchema } from "@/lib/travel";
import { parseWallClock, wallClockNow } from "@/lib/wall-clock";
import { actorOf, db, makeUser, resetDb } from "./helpers";

beforeEach(resetDb);

const blank = { startTime: null, endTime: null, venueName: null, venueAddress: null, mapUrl: null, dressCode: null, description: null };
const hh = (name: string, side: "bride" | "groom" | "both" = "bride") => ({ name, side, address: null, city: null, postalCode: null, notes: null });
const g = (v: Record<string, unknown>) => guestSchema.parse(v);

async function setup() {
  const host = await makeUser("host@example.com", "Asha");
  const actor = actorOf(host);
  const event = await createEvent(db(), actor, { name: "Wedding", startDate: "2026-12-10" });
  const sangeet = await createFunction(db(), event.id, actor, { name: "Sangeet", date: "2026-12-10", ...blank });
  const wedding = await createFunction(db(), event.id, actor, { name: "Wedding", date: "2026-12-11", ...blank });
  const sharma = await createHousehold(db(), event.id, actor, {
    household: hh("Sharma family"),
    members: [g({ name: "Rajesh", phone: "9876543210" }), g({ name: "Sunita" }), g({ name: "Baby", ageGroup: "infant" })],
    functionIds: [sangeet.id, wedding.id],
  });
  const verma = await createHousehold(db(), event.id, actor, {
    household: hh("Verma", "groom"),
    members: [g({ name: "Anil", phone: "9999988888" }), g({ name: "Kavita" })],
    functionIds: [sangeet.id],
  });
  return { host, actor, event, sangeet, wedding, sharma, verma };
}

describe("policy", () => {
  it("lets Hosts and Planners run logistics and check-in directly, never via approval", () => {
    for (const role of ["host", "planner"] as const) {
      for (const p of ["travel.edit", "seating.edit", "runsheet.edit", "checkin.operate"] as const) {
        expect(decide({ isAppAdmin: false, membership: { role, giftAccess: "none" } }, p)).toBe("allow");
      }
    }
    expect(decide({ isAppAdmin: false, membership: null }, "checkin.operate")).toBe("deny");
  });
});

describe("wall clock", () => {
  it("converts now to event-local wall-clock time", () => {
    expect(wallClockNow("Asia/Kolkata", new Date("2026-12-09T20:00:00Z")).toISOString()).toBe("2026-12-10T01:30:00.000Z");
  });
});

describe("transfers", () => {
  const run = (v: Record<string, unknown>) => runSchema.parse({ kind: "pickup", departsAt: "2026-12-09T15:00", fromPlace: "JAI T2", toPlace: "Rambagh", capacity: 4, ...v });

  it("enforces vehicle capacity all-or-nothing, even under concurrency", async () => {
    const { event, sharma, verma } = await setup();
    const r = await createRun(db(), event.id, run({ capacity: 3 }));
    await expect(assignToRun(db(), event.id, r.id, [...sharma.members, ...verma.members].map((m) => m.id))).rejects.toMatchObject({ code: "over_capacity" });
    expect(await getManifest(db(), event.id, r.id)).toHaveLength(0);
    await assignToRun(db(), event.id, r.id, sharma.members.slice(0, 2).map((m) => m.id));
    const results = await Promise.allSettled([
      assignToRun(db(), event.id, r.id, [verma.members[0].id]),
      assignToRun(db(), event.id, r.id, [verma.members[1].id]),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await getManifest(db(), event.id, r.id)).toHaveLength(3);
    await expect(updateRun(db(), event.id, r.id, run({ capacity: 2 }))).rejects.toMatchObject({ code: "capacity_below_load" });
  });

  it("creates a run with passengers atomically: a capacity error leaves no run behind", async () => {
    const { event, sharma, verma } = await setup();
    await expect(createRun(db(), event.id, run({ capacity: 2 }), [...sharma.members, ...verma.members].map((m) => m.id))).rejects.toMatchObject({
      code: "over_capacity",
    });
    expect(await listRuns(db(), event.id)).toHaveLength(0);
    const ok = await createRun(db(), event.id, run({ capacity: 5 }), [...sharma.members, ...verma.members].map((m) => m.id));
    expect(await getManifest(db(), event.id, ok.id)).toHaveLength(5);
  });

  it("rejects guests from another event", async () => {
    const { actor, event } = await setup();
    const other = await createEvent(db(), actor, { name: "Other" });
    const { members } = await createHousehold(db(), other.id, actor, { household: hh("X"), members: [g({ name: "X" })] });
    const r = await createRun(db(), event.id, run({}));
    await expect(assignToRun(db(), event.id, r.id, [members[0].id])).rejects.toBeInstanceOf(TransferError);
  });

  it("groups arrivals into windows across midnight without shifting times, and warns about mismatches", async () => {
    const { event, sharma, verma } = await setup();
    await saveTravel(db(), sharma.members[0].id, travelSchema.parse({ arrivalMode: "flight", arrivalNumber: "6E 203", arrivalAt: "2026-12-09T23:30", arrivalPoint: "JAI T2", needsPickup: true }), true);
    await saveTravel(db(), verma.members[0].id, travelSchema.parse({ arrivalMode: "train", arrivalAt: "2026-12-09T14:10", needsPickup: true }), true);
    await saveTravel(db(), verma.members[1].id, travelSchema.parse({ arrivalAt: "2026-12-10T00:20" }), true);
    const board = await arrivalsBoard(db(), event.id, { date: "2026-12-09", windowMinutes: 60, direction: "arrival" });
    expect(board.map((w) => [w.start.toISOString().slice(11, 16), w.entries.map((e) => e.guest.name)])).toEqual([
      ["14:00", ["Anil"]],
      ["23:00", ["Rajesh"]],
    ]);
    const r = await createRun(db(), event.id, run({ departsAt: "2026-12-09T14:00" }));
    await assignToRun(db(), event.id, r.id, [verma.members[0].id]);
    const manifest = await getManifest(db(), event.id, r.id);
    expect(manifest[0].contactPhone).toBe("+919999988888");
    expect(runWarnings(r, manifest).map((w) => w.code).sort()).toEqual(["no_driver_phone", "time_mismatch"]);
    // A guest changing travel after being assigned is flagged
    await new Promise((res) => setTimeout(res, 10));
    await saveTravel(db(), verma.members[0].id, travelSchema.parse({ arrivalMode: "train", arrivalAt: "2026-12-09T14:05", needsPickup: true }), true);
    expect(runWarnings(r, await getManifest(db(), event.id, r.id)).map((w) => w.code)).toContain("travel_changed");
    expect(manifestText(r, manifest, (d) => d.toISOString().slice(11, 16))).toContain("Anil (1)");
  });

  it("shows a family only their own runs plus shuttles for their functions", async () => {
    const { event, sangeet, wedding, sharma, verma } = await setup();
    const pickup = await createRun(db(), event.id, run({}));
    await assignToRun(db(), event.id, pickup.id, [verma.members[0].id]);
    await createRun(db(), event.id, run({ kind: "shuttle", functionId: wedding.id, departsAt: "2026-12-11T17:00" }));
    await createRun(db(), event.id, run({ kind: "shuttle", functionId: sangeet.id, departsAt: "2026-12-10T19:00" }));
    const sharmaRuns = await runsForHousehold(db(), event.id, sharma.household.id);
    expect(sharmaRuns.map((r) => r.run.kind)).toEqual(["shuttle", "shuttle"]);
    const vermaRuns = await runsForHousehold(db(), event.id, verma.household.id);
    expect(vermaRuns.map((r) => r.run.kind)).toEqual(["pickup", "shuttle"]);
  });
});

describe("hotels and rooms", () => {
  const block = (v: Record<string, unknown> = {}) =>
    blockSchema.parse({ roomType: "Deluxe", maxOccupancy: 2, blockedCount: 2, rate: "7,500", checkIn: "2026-12-09", checkOut: "2026-12-12", ...v });

  it("materialises rooms, refuses overlapping stays, and warns about occupancy", async () => {
    const { actor, event, sharma, verma } = await setup();
    const hotel = await createHotel(db(), event.id, { name: "Rambagh", address: null, phone: null, mapUrl: null, notes: null });
    const b = await createBlock(db(), event.id, hotel.id, block());
    expect(b.ratePaise).toBe(750000);
    let view = await allocationView(db(), event.id, hotel.id);
    const [r1, r2] = view[0].rooms;
    const res = await assignRoom(db(), event.id, r1.id, sharma.members.map((m) => m.id));
    expect(res.warnings).toEqual([]); // infant doesn't count
    const res2 = await assignRoom(db(), event.id, r1.id, [verma.members[0].id]);
    expect(res2.warnings).toEqual(expect.arrayContaining(["over_occupancy", "household_split"]));

    // Same person in another room on overlapping nights is refused; back-to-back is fine
    await expect(assignRoom(db(), event.id, r2.id, [sharma.members[0].id], { checkIn: "2026-12-11", checkOut: "2026-12-13" })).rejects.toMatchObject({
      code: "overlapping_stay",
    });
    await assignRoom(db(), event.id, r2.id, [sharma.members[0].id], { checkIn: "2026-12-12", checkOut: "2026-12-13" });

    // Shrinking the block can't remove occupied rooms
    await expect(updateBlock(db(), event.id, b.id, block({ blockedCount: 1 }), actor)).rejects.toBeInstanceOf(HotelError);
    await updateBlock(db(), event.id, b.id, block({ blockedCount: 4, rate: "8000" }), actor);
    view = await allocationView(db(), event.id, hotel.id);
    expect(view[0].rooms).toHaveLength(4);
    const [listed] = await listHotels(db(), event.id);
    expect(listed).toMatchObject({ blocked: 4, roomsUsed: 2 });
  });

  it("counts occupancy per night and lists different stays in a room separately", async () => {
    const { event, sharma, verma } = await setup();
    const hotel = await createHotel(db(), event.id, { name: "Rambagh", address: null, phone: null, mapUrl: null, notes: null });
    await createBlock(db(), event.id, hotel.id, block({ maxOccupancy: 2, checkIn: "2026-12-08", checkOut: "2026-12-12" }));
    const [room] = (await allocationView(db(), event.id, hotel.id))[0].rooms;
    await assignRoom(db(), event.id, room.id, [sharma.members[0].id, sharma.members[1].id], { checkIn: "2026-12-08", checkOut: "2026-12-10" });
    const res = await assignRoom(db(), event.id, room.id, [verma.members[0].id, verma.members[1].id], { checkIn: "2026-12-10", checkOut: "2026-12-12" });
    expect(res.warnings).not.toContain("over_occupancy");
    expect((await allocationView(db(), event.id, hotel.id))[0].rooms[0].over).toBe(false);
    const rows = await roomingList(db(), event.id, hotel.id, "Room");
    expect(rows.map((r) => [r.guestNames, r.checkIn, r.checkOut])).toEqual([
      ["Rajesh, Sunita", "2026-12-08", "2026-12-10"],
      ["Anil, Kavita", "2026-12-10", "2026-12-12"],
    ]);
  });

  it("exports a rooming list with only names, room, dates and one phone", async () => {
    const { event, sharma } = await setup();
    const hotel = await createHotel(db(), event.id, { name: "Rambagh", address: null, phone: null, mapUrl: null, notes: null });
    await createBlock(db(), event.id, hotel.id, block());
    const [room] = (await allocationView(db(), event.id, hotel.id))[0].rooms;
    await assignRoom(db(), event.id, room.id, [sharma.members[1].id]);
    const rows = await roomingList(db(), event.id, hotel.id, "Room");
    expect(rows).toEqual([{ roomType: "Deluxe", room: "Room 1", guestNames: "Sunita", checkIn: "2026-12-09", checkOut: "2026-12-12", nights: 3, contactPhone: "+919876543210" }]);
    expect(Object.keys(rows[0]).sort()).toEqual(["checkIn", "checkOut", "contactPhone", "guestNames", "nights", "room", "roomType"]);
  });

  it("never shows another family's names on a family's room", async () => {
    const { event, sharma, verma } = await setup();
    const hotel = await createHotel(db(), event.id, { name: "Rambagh", address: null, phone: null, mapUrl: null, notes: null });
    await createBlock(db(), event.id, hotel.id, block({ maxOccupancy: 6 }));
    const [room] = (await allocationView(db(), event.id, hotel.id))[0].rooms;
    await assignRoom(db(), event.id, room.id, [sharma.members[0].id, verma.members[0].id]);
    const mine = await roomsForHousehold(db(), event.id, sharma.household.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].names).toEqual(["Rajesh"]);
  });
});

describe("seating", () => {
  it("seats invited guests once per function, keeps families together and warns", async () => {
    const { event, sangeet, wedding, sharma, verma } = await setup();
    await addTables(db(), event.id, sangeet.id, { count: 2, capacity: 2, prefix: "Table" });
    let plan = await seatingPlan(db(), event.id, sangeet.id);
    const [t1, t2] = plan.tables;
    expect(plan.tables.map((t) => t.name)).toEqual(["Table 1", "Table 2"]);
    await seatHousehold(db(), event.id, sangeet.id, t1.id, sharma.household.id);
    plan = await seatingPlan(db(), event.id, sangeet.id);
    expect(plan.tables[0].seatsUsed).toBe(2); // infant takes no seat
    expect(plan.unassigned.map((u) => u.name)).toEqual(["Anil", "Kavita"]);

    // Moving a guest updates, never duplicates
    await seatGuests(db(), event.id, sangeet.id, t2.id, [sharma.members[0].id]);
    plan = await seatingPlan(db(), event.id, sangeet.id);
    expect(plan.seated).toBe(3);
    expect(plan.warnings).toContainEqual({ code: "household_split", household: "Sharma family" });

    // Can't seat someone not invited, or at another function's table
    await addTables(db(), event.id, wedding.id, { count: 1, capacity: 10, prefix: "W" });
    const [wt] = (await seatingPlan(db(), event.id, wedding.id)).tables;
    await expect(seatGuests(db(), event.id, wedding.id, wt.id, [verma.members[0].id])).rejects.toBeInstanceOf(SeatingError);
    await expect(seatGuests(db(), event.id, sangeet.id, wt.id, [sharma.members[1].id])).rejects.toBeInstanceOf(SeatingError);

    // Un-inviting removes the seat (foreign key cascade)
    await setGuestInvites(db(), event.id, sharma.members[0].id, [wedding.id]);
    plan = await seatingPlan(db(), event.id, sangeet.id);
    expect(plan.seated).toBe(2);
  });

  it("leaves people who declined out of the unassigned list", async () => {
    const { event, sangeet, verma } = await setup();
    await saveRsvps(db(), { household: verma.household, event, recordedBy: null, answers: [{ guestId: verma.members[1].id, functionId: sangeet.id, status: "declined" }] });
    const plan = await seatingPlan(db(), event.id, sangeet.id);
    expect(plan.unassigned.map((u) => u.name)).not.toContain("Kavita");
  });
});

describe("check-in", () => {
  it("resolves entry passes and old guest links, rejects tampered, rotated and foreign passes", async () => {
    const { actor, event, sangeet, sharma } = await setup();
    const pass = makePassToken(sharma.household.id, 1);
    expect(extractToken(`https://x.test/c/${pass}`)).toEqual({ token: pass, kind: "pass" });
    const viaPass = await lookupPass(db(), event.id, sangeet.id, `https://x.test/c/${pass}`);
    expect(viaPass.members.map((m) => [m.name, m.invited])).toEqual([["Rajesh", true], ["Sunita", true], ["Baby", true]]);
    const legacy = makeGuestToken(sharma.household.id, 1);
    expect((await lookupPass(db(), event.id, sangeet.id, `https://x.test/g/${legacy}`)).household.id).toBe(sharma.household.id);
    // A pass token isn't a guest link: it can't be used as /g/
    await expect(lookupPass(db(), event.id, sangeet.id, `https://x.test/g/${pass}`)).rejects.toMatchObject({ code: "invalid_pass" });
    await expect(lookupPass(db(), event.id, sangeet.id, pass.slice(0, -2) + "zz")).rejects.toMatchObject({ code: "invalid_pass" });

    await regenerateGuestLink(db(), event.id, sharma.household.id);
    await expect(lookupPass(db(), event.id, sangeet.id, pass)).rejects.toMatchObject({ code: "invalid_pass" });

    const other = await createEvent(db(), actor, { name: "Other" });
    const otherFn = await createFunction(db(), other.id, actor, { name: "X", date: null, ...blank });
    const fresh = makePassToken(sharma.household.id, 2);
    await expect(lookupPass(db(), other.id, otherFn.id, fresh)).rejects.toMatchObject({ code: "wrong_event" });
  });

  it("is idempotent, counts arrivals, handles walk-ins, uninvited guests and undo", async () => {
    const { actor, event, sangeet, wedding, sharma, verma } = await setup();
    await saveRsvps(db(), {
      household: sharma.household, event, recordedBy: null,
      answers: sharma.members.map((m) => ({ guestId: m.id, functionId: sangeet.id, status: "attending" as const })),
    });
    const items = sharma.members.slice(0, 2).map((m) => ({ guestId: m.id, source: "scan" as const }));
    expect((await checkIn(db(), event.id, sangeet.id, actor, items)).created).toHaveLength(2);
    const again = await checkIn(db(), event.id, sangeet.id, actor, items);
    expect(again).toEqual({ created: [], alreadyIn: items.map((i) => i.guestId), rejected: [] });
    expect(await db().select().from(checkIns)).toHaveLength(2);

    // Verma isn't invited to the wedding: reported per guest, the rest of the batch still saves
    const mixed = await checkIn(db(), event.id, wedding.id, actor, [
      { guestId: verma.members[0].id, source: "manual" },
      { guestId: sharma.members[1].id, source: "manual" },
      { guestId: "00000000-0000-4000-8000-000000000000", source: "manual" },
    ]);
    expect(mixed.created).toEqual([sharma.members[1].id]);
    expect(mixed.rejected).toEqual([
      { guestId: verma.members[0].id, code: "not_invited" },
      { guestId: "00000000-0000-4000-8000-000000000000", code: "not_found" },
    ]);
    await checkIn(db(), event.id, wedding.id, actor, [{ guestId: verma.members[0].id, source: "manual" }], { allowUninvited: true });

    await addWalkIn(db(), event.id, sangeet.id, actor, { name: "Mr Kapoor", side: "groom", count: 2 });
    const c = await checkInCounts(db(), event.id, sangeet.id);
    expect(c).toMatchObject({ expected: 3, arrived: 4, arrivedExpected: 2, walkIns: 2, noReply: 2 });
    expect(c.arrivedByAge).toEqual({ adult: 4, child: 0, infant: 0 });
    expect((await checkInCounts(db(), event.id, wedding.id)).arrivedUninvited).toBe(1);
    const audits = (await db().select().from(auditLogs).where(eq(auditLogs.eventId, event.id))).map((a) => a.action);
    expect(audits).toContain("checkin.walk_in");

    await undoCheckIn(db(), event.id, sangeet.id, sharma.members[0].id, actor);
    expect((await checkInCounts(db(), event.id, sangeet.id)).arrived).toBe(3);

    // Device times in the future are clamped to now
    const now = new Date();
    await checkIn(db(), event.id, sangeet.id, actor, [{ guestId: sharma.members[0].id, source: "scan", at: new Date(now.getTime() + 3600_000) }], { now });
    const [row] = await db().select().from(checkIns).where(eq(checkIns.guestId, sharma.members[0].id));
    expect(row.checkedInAt.getTime()).toBe(now.getTime());
  });

  it("finds families by name or last phone digits", async () => {
    const { event, sangeet } = await setup();
    expect((await searchForCheckIn(db(), event.id, sangeet.id, "verm")).map((h) => h.household.name)).toEqual(["Verma"]);
    expect((await searchForCheckIn(db(), event.id, sangeet.id, "3210")).map((h) => h.household.name)).toEqual(["Sharma family"]);
    expect(await searchForCheckIn(db(), event.id, sangeet.id, "%")).toEqual([]);
  });
});

describe("run sheet", () => {
  const item = (v: Record<string, unknown>) => itemSchema.parse({ startsAt: "2026-12-10T19:00", title: "x", ...v });

  it("shows now/next/late at a wall-clock time, shifts later items but not locked ones", async () => {
    const { event, sangeet } = await setup();
    await createItem(db(), event.id, sangeet.id, item({ title: "Guests arrive", startsAt: "2026-12-10T19:00", durationMin: 30 }));
    const dance = await createItem(db(), event.id, sangeet.id, item({ title: "Family dances", startsAt: "2026-12-10T19:30", durationMin: 60 }));
    await createItem(db(), event.id, sangeet.id, item({ title: "Muhurat", startsAt: "2026-12-10T21:00", durationMin: 15, timeLocked: true }));
    await createItem(db(), event.id, sangeet.id, item({ title: "Dinner", startsAt: "2026-12-10T21:15", durationMin: 60 }));
    await createItem(db(), event.id, sangeet.id, item({ title: "DJ after midnight", startsAt: "2026-12-11T00:15" }));

    const items = (await listItems(db(), event.id, sangeet.id)).map((r) => r.item);
    const v = liveView(items, parseWallClock("2026-12-10T19:45")!);
    expect(v.current.map((i) => i.title)).toEqual(["Family dances"]);
    expect(v.late.map((i) => i.title)).toEqual(["Guests arrive"]);
    expect(v.next?.title).toBe("Muhurat");

    const parallel = await createItem(db(), event.id, sangeet.id, item({ title: "Welcome drinks", startsAt: "2026-12-10T19:30", durationMin: 30 }));
    expect(await shiftItems(db(), event.id, dance.id, 45)).toBe(4); // dance + parallel drinks, dinner, DJ; muhurat stays
    const drinks = (await listItems(db(), event.id, sangeet.id)).find((r) => r.item.id === parallel.id)!;
    expect(drinks.item.startsAt.toISOString().slice(11, 16)).toBe("20:15");
    const after = (await listItems(db(), event.id, sangeet.id)).map((r) => [r.item.title, r.item.startsAt.toISOString().slice(11, 16)]);
    expect(after.filter(([title]) => title !== "Welcome drinks")).toEqual([
      ["Guests arrive", "19:00"],
      ["Family dances", "20:15"],
      ["Muhurat", "21:00"],
      ["Dinner", "22:00"],
      ["DJ after midnight", "01:00"],
    ]);
    const overlaps = lockedOverlaps((await listItems(db(), event.id, sangeet.id)).map((r) => r.item));
    expect(overlaps.map((o) => o.other.title).sort()).toEqual(["Family dances"]);
  });

  it("only allows team members as owners", async () => {
    const { event, sangeet } = await setup();
    const stranger = await makeUser("x@example.com");
    await expect(createItem(db(), event.id, sangeet.id, item({ ownerUserId: stranger.id }))).rejects.toMatchObject({ code: "bad_owner" });
    const ok = await createItem(db(), event.id, sangeet.id, item({ ownerName: "DJ Bunty", ownerPhone: "98111 22233" }));
    expect(ok.ownerPhone).toBe("+919811122233");
  });
});
