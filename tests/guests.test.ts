import { beforeEach, describe, expect, it } from "vitest";
import { createEvent } from "@/lib/events";
import { createFunction, functionsToIcs, groupByDay, invitedCounts, listFunctions } from "@/lib/functions";
import {
  addGuest,
  bulkInvite,
  createHousehold,
  deleteHousehold,
  getHouseholdWithMembers,
  guestSchema,
  guestStats,
  GuestError,
  listGuests,
  listTags,
  normalizeTags,
  removeGuest,
  setHouseholdInvites,
} from "@/lib/guests";
import { actorOf, db, makeUser, resetDb } from "./helpers";

beforeEach(resetDb);

const g = (input: Record<string, unknown>) => {
  const res = guestSchema.safeParse(input);
  if (!res.success) throw new Error(JSON.stringify(res.error.issues));
  return res.data;
};

async function setup() {
  const host = await makeUser("host@example.com", "Asha");
  const actor = actorOf(host);
  const event = await createEvent(db(), actor, { name: "Wedding", startDate: "2026-12-10" });
  const mehendi = await createFunction(db(), event.id, actor, {
    name: "Mehendi", date: "2026-12-10", startTime: "16:00", endTime: null, venueName: "Lawn", venueAddress: null, mapUrl: null, dressCode: "Green", description: null,
  });
  const sangeet = await createFunction(db(), event.id, actor, {
    name: "Sangeet", date: "2026-12-10", startTime: "19:30", endTime: "23:00", venueName: null, venueAddress: null, mapUrl: null, dressCode: null, description: null,
  });
  const wedding = await createFunction(db(), event.id, actor, {
    name: "Wedding", date: "2026-12-11", startTime: null, endTime: null, venueName: null, venueAddress: null, mapUrl: null, dressCode: null, description: null,
  });
  return { host, actor, event, mehendi, sangeet, wedding };
}

describe("guest validation", () => {
  it("normalises phones, emails and tags", () => {
    const v = g({ name: " Ravi ", phone: "98765 43210", email: "Ravi@Example.com", tags: "VIP, vip, Elders ,  college  friends" });
    expect(v).toMatchObject({ name: "Ravi", phone: "+919876543210", email: "ravi@example.com", tags: ["VIP", "Elders", "college friends"] });
    expect(guestSchema.safeParse({ name: "X", phone: "123" }).success).toBe(false);
    expect(guestSchema.safeParse({ name: "X", email: "nope" }).success).toBe(false);
    expect(guestSchema.safeParse({ name: "" }).success).toBe(false);
    expect(normalizeTags(["a", "A", " b "])).toEqual(["a", "b"]);
  });
});

describe("households and invites", () => {
  it("creates a family, invites everyone, and new members inherit the head's invites", async () => {
    const { event, mehendi, sangeet } = await setup();
    const { household, members } = await createHousehold(db(), event.id, actorOf({ id: (await makeUser("x@example.com")).id, isAppAdmin: false }), {
      household: { name: "Sharma family", side: "bride", address: null, city: "Delhi", postalCode: null, notes: null },
      members: [g({ name: "Rajesh Sharma" }), g({ name: "Sunita Sharma" })],
      functionIds: [mehendi.id, sangeet.id],
    });
    expect(members[0].isHead).toBe(true);
    const kid = await addGuest(db(), event.id, household.id, g({ name: "Anya", ageGroup: "child" }));
    const full = await getHouseholdWithMembers(db(), event.id, household.id);
    expect(full.members.find((m) => m.id === kid.id)?.functionIds.sort()).toEqual([mehendi.id, sangeet.id].sort());

    const counts = await invitedCounts(db(), event.id);
    expect(counts.get(mehendi.id)).toEqual({ guests: 3, households: 1, adults: 2, children: 1, infants: 0 });
  });

  it("rejects functions from another event", async () => {
    const { event, actor } = await setup();
    const other = await createEvent(db(), actor, { name: "Other" });
    const foreign = await createFunction(db(), other.id, actor, {
      name: "X", date: null, startTime: null, endTime: null, venueName: null, venueAddress: null, mapUrl: null, dressCode: null, description: null,
    });
    await expect(
      createHousehold(db(), event.id, actor, {
        household: { name: "A", side: "both", address: null, city: null, postalCode: null, notes: null },
        members: [g({ name: "A" })],
        functionIds: [foreign.id],
      }),
    ).rejects.toThrow();
  });

  it("supports member-level invites and keeps at least one member", async () => {
    const { event, actor, mehendi, wedding } = await setup();
    const { household, members } = await createHousehold(db(), event.id, actor, {
      household: { name: "Verma", side: "groom", address: null, city: null, postalCode: null, notes: null },
      members: [g({ name: "Anil" }), g({ name: "Kavita" })],
    });
    await setHouseholdInvites(db(), event.id, household.id, { [members[0].id]: [mehendi.id, wedding.id], [members[1].id]: [wedding.id] });
    let full = await getHouseholdWithMembers(db(), event.id, household.id);
    expect(full.members.map((m) => m.functionIds.length)).toEqual([2, 1]);

    await removeGuest(db(), event.id, members[0].id);
    full = await getHouseholdWithMembers(db(), event.id, household.id);
    expect(full.members).toHaveLength(1);
    expect(full.members[0].isHead).toBe(true);
    await expect(removeGuest(db(), event.id, members[1].id)).rejects.toBeInstanceOf(GuestError);

    await deleteHousehold(db(), event.id, household.id, actor);
    expect((await guestStats(db(), event.id)).guests).toBe(0);
  });

  it("filters by search, side, tag, function, age and diet, and pages by family", async () => {
    const { event, actor, mehendi, sangeet } = await setup();
    await createHousehold(db(), event.id, actor, {
      household: { name: "Sharma", side: "bride", address: null, city: null, postalCode: null, notes: null },
      members: [g({ name: "Rajesh", phone: "9876543210", tags: "VIP", diet: "jain" }), g({ name: "Anya", ageGroup: "child" })],
      functionIds: [mehendi.id],
    });
    await createHousehold(db(), event.id, actor, {
      household: { name: "Verma", side: "groom", address: null, city: null, postalCode: null, notes: null },
      members: [g({ name: "Anil", tags: "vip, elders", diet: "veg" })],
      functionIds: [sangeet.id],
    });
    await createHousehold(db(), event.id, actor, {
      household: { name: "Khan", side: "both", address: null, city: null, postalCode: null, notes: null },
      members: [g({ name: "Imran" })],
    });

    const names = async (f: Record<string, string>) =>
      (await listGuests(db(), event.id, f)).households.flatMap((h) => h.members.map((m) => m.name)).sort();
    expect(await names({})).toEqual(["Anil", "Anya", "Imran", "Rajesh"]);
    expect(await names({ q: "sharma" })).toEqual(["Anya", "Rajesh"]);
    expect(await names({ q: "43210" })).toEqual(["Rajesh"]);
    expect(await names({ side: "groom" })).toEqual(["Anil"]);
    expect(await names({ tag: "VIP" })).toEqual(["Anil", "Rajesh"]);
    expect(await names({ fn: mehendi.id })).toEqual(["Anya", "Rajesh"]);
    expect(await names({ fn: "none" })).toEqual(["Imran"]);
    expect(await names({ age: "child" })).toEqual(["Anya"]);
    expect(await names({ diet: "jain" })).toEqual(["Rajesh"]);
    expect(await names({ diet: "unknown" })).toEqual(["Anya", "Imran"]);
    expect(await names({ q: "%" })).toEqual([]);

    expect(await listTags(db(), event.id)).toEqual(["elders", "VIP"]);
    expect(await guestStats(db(), event.id)).toMatchObject({ households: 3, guests: 4, bride: 2, groom: 1, both: 1, children: 1, uninvited: 1 });

    await bulkInvite(db(), event.id, (await listGuests(db(), event.id, { tag: "vip" })).households.flatMap((h) => h.members.map((m) => m.id)), sangeet.id, true);
    expect(await names({ fn: sangeet.id })).toEqual(["Anil", "Rajesh"]);
  });

  it("paginates by household without splitting families", async () => {
    const { event, actor } = await setup();
    for (let i = 0; i < 55; i++) {
      await createHousehold(db(), event.id, actor, {
        household: { name: `Family ${String(i).padStart(2, "0")}`, side: "both", address: null, city: null, postalCode: null, notes: null },
        members: [g({ name: `A${i}` }), g({ name: `B${i}` })],
      });
    }
    const p1 = await listGuests(db(), event.id, {}, 1);
    const p2 = await listGuests(db(), event.id, {}, 2);
    expect(p1.totalHouseholds).toBe(55);
    expect(p1.households).toHaveLength(50);
    expect(p2.households).toHaveLength(5);
    expect(p1.households.every((h) => h.members.length === 2)).toBe(true);
    expect(p1.matchingGuests).toBe(110);
  });
});

describe("schedule", () => {
  it("orders by date and time, groups by day, and exports a calendar", async () => {
    const { event, actor } = await setup();
    await createFunction(db(), event.id, actor, {
      name: "Haldi", date: "2026-12-10", startTime: "09:00", endTime: null, venueName: null, venueAddress: null, mapUrl: null, dressCode: null, description: null,
    });
    await createFunction(db(), event.id, actor, {
      name: "Thank-you lunch", date: null, startTime: null, endTime: null, venueName: null, venueAddress: null, mapUrl: null, dressCode: null, description: null,
    });
    const fns = await listFunctions(db(), event.id);
    expect(fns.map((f) => f.name)).toEqual(["Haldi", "Mehendi", "Sangeet", "Wedding", "Thank-you lunch"]);
    expect(groupByDay(fns).map((d) => [d.date, d.functions.length])).toEqual([
      ["2026-12-10", 3],
      ["2026-12-11", 1],
      [null, 1],
    ]);

    const ics = functionsToIcs({ id: event.id, name: "Priya, Arjun; Wedding", timezone: "Asia/Kolkata" }, fns, new Date("2026-01-01T00:00:00Z"));
    expect(ics).toContain("DTSTART;TZID=Asia/Kolkata:20261210T193000");
    expect(ics).toContain("DTEND;TZID=Asia/Kolkata:20261210T230000");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261211");
    expect(ics).toContain("DTEND;VALUE=DATE:20261212");
    expect(ics).toContain("Priya\\, Arjun\\; Wedding");
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(4); // undated function is left out
    expect(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
  });
});
