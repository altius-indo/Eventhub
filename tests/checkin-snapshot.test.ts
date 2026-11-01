import { beforeEach, describe, expect, it } from "vitest";
import { checkIn, checkInSnapshot, CheckInError } from "@/lib/checkin";
import { sha256 } from "@/lib/crypto";
import { createEvent } from "@/lib/events";
import { createFunction } from "@/lib/functions";
import { makePassToken, regenerateGuestLink, revokeGuestLink } from "@/lib/guest-links";
import { createHousehold, guestSchema } from "@/lib/guests";
import { saveRsvps } from "@/lib/rsvp";
import { actorOf, db, makeUser, resetDb } from "./helpers";

beforeEach(resetDb);

const blank = { startTime: null, endTime: null, venueName: null, venueAddress: null, mapUrl: null, dressCode: null, description: null };
const hh = (name: string, side: "bride" | "groom" | "both" = "bride") => ({ name, side, address: "12 MG Road", city: "Jaipur", postalCode: "302001", notes: "Private note" });
const g = (v: Record<string, unknown>) => guestSchema.parse(v);

async function setup() {
  const host = await makeUser("host@example.com", "Asha");
  const actor = actorOf(host);
  const event = await createEvent(db(), actor, { name: "Wedding", startDate: "2026-12-10" });
  const sangeet = await createFunction(db(), event.id, actor, { name: "Sangeet", date: "2026-12-10", ...blank });
  const wedding = await createFunction(db(), event.id, actor, { name: "Wedding", date: "2026-12-11", ...blank });
  const sharma = await createHousehold(db(), event.id, actor, {
    household: hh("Sharma family"),
    members: [
      g({ name: "Rajesh", phone: "9876543210", email: "rajesh@example.com", dietNotes: "Peanut allergy", accessibilityNotes: "Wheelchair" }),
      g({ name: "Baby", ageGroup: "infant" }),
    ],
    functionIds: [sangeet.id, wedding.id],
  });
  const verma = await createHousehold(db(), event.id, actor, {
    household: hh("Verma", "groom"),
    members: [g({ name: "Anil", phone: "9999988888" })],
    functionIds: [wedding.id],
  });
  return { host, actor, event, sangeet, wedding, sharma, verma };
}

describe("checkInSnapshot (SEAT-04, ADR-0034)", () => {
  it("lists only families invited to the function, with minimal fields", async () => {
    const { event, sangeet, sharma } = await setup();
    const snap = await checkInSnapshot(db(), event.id, sangeet.id, new Date("2026-12-10T10:00:00Z"));
    expect(snap.functionId).toBe(sangeet.id);
    expect(snap.generatedAt).toBe("2026-12-10T10:00:00.000Z");
    expect(snap.households.map((h) => h.name)).toEqual(["Sharma family"]);
    const [h] = snap.households;
    expect(Object.keys(h).sort()).toEqual(["id", "members", "name", "passHash", "side"]);
    expect(h.id).toBe(sharma.household.id);
    expect(h.members.map((m) => m.name)).toEqual(["Rajesh", "Baby"]);
    for (const m of h.members) expect(Object.keys(m).sort()).toEqual(["ageGroup", "checkedInAt", "id", "invited", "name", "rsvp"]);
    // No contact details, addresses, notes or usable tokens anywhere in the payload.
    const json = JSON.stringify(snap);
    for (const secret of ["9876543210", "rajesh@example.com", "MG Road", "Jaipur", "Private note", "Peanut", "Wheelchair", makePassToken(sharma.household.id, 1)]) {
      expect(json).not.toContain(secret);
    }
  });

  it("stores the pass as a hash that matches the current pass only", async () => {
    const { event, sangeet, sharma } = await setup();
    let [h] = (await checkInSnapshot(db(), event.id, sangeet.id)).households;
    expect(h.passHash).toBe(sha256(makePassToken(sharma.household.id, 1)));
    await regenerateGuestLink(db(), event.id, sharma.household.id);
    [h] = (await checkInSnapshot(db(), event.id, sangeet.id)).households;
    expect(h.passHash).toBe(sha256(makePassToken(sharma.household.id, 2)));
    expect(h.passHash).not.toBe(sha256(makePassToken(sharma.household.id, 1)));
    await revokeGuestLink(db(), event.id, sharma.household.id);
    [h] = (await checkInSnapshot(db(), event.id, sangeet.id)).households;
    expect(h.passHash).toBeNull();
  });

  it("includes RSVP and check-in state for this function", async () => {
    const { actor, event, wedding, sharma, verma } = await setup();
    const rajesh = sharma.members[0];
    await saveRsvps(db(), {
      household: sharma.household,
      event,
      answers: [{ guestId: rajesh.id, functionId: wedding.id, status: "attending" }],
      recordedBy: actor,
    });
    await checkIn(db(), event.id, wedding.id, actor, [{ guestId: verma.members[0].id, source: "manual" }], { now: new Date("2026-12-11T12:00:00Z") });
    const snap = await checkInSnapshot(db(), event.id, wedding.id);
    expect(snap.households.map((h) => h.name)).toEqual(["Sharma family", "Verma"]);
    const s = snap.households[0].members.find((m) => m.id === rajesh.id)!;
    expect(s).toMatchObject({ invited: true, rsvp: "attending", checkedInAt: null });
    expect(snap.households[1].members[0].checkedInAt).toBe("2026-12-11T12:00:00.000Z");
  });

  it("is scoped to the event: another event's function is not found", async () => {
    const { actor, sangeet } = await setup();
    const other = await createEvent(db(), actor, { name: "Other", startDate: "2026-12-20" });
    await expect(checkInSnapshot(db(), other.id, sangeet.id)).rejects.toBeInstanceOf(CheckInError);
    const otherFn = await createFunction(db(), other.id, actor, { name: "Mehendi", date: "2026-12-20", ...blank });
    expect((await checkInSnapshot(db(), other.id, otherFn.id)).households).toEqual([]);
  });
});
