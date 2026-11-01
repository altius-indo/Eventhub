import { beforeAll, describe, expect, it } from "vitest";
import { functionInvites, guestTravel, guests, households, rsvps } from "@/db/schema";
import { resolveSegment, recipientsFor } from "@/lib/broadcasts";
import { checkInSnapshot } from "@/lib/checkin";
import { createEvent } from "@/lib/events";
import { createFunction } from "@/lib/functions";
import { listAllGuests, listGuests, type GuestFilters } from "@/lib/guests";
import { headcounts } from "@/lib/rsvp";
import { actorOf, db, makeUser, resetDb } from "./helpers";

/**
 * §4 performance: lists of 1,000 guests filter and search in under 300 ms (p95).
 * Seeds one event with 250 families / 1,000 guests, 5 functions, RSVPs and travel,
 * then times the queries the guest list, RSVP headcount and broadcast pages run.
 */
const blank = { startTime: null, endTime: null, venueName: null, venueAddress: null, mapUrl: null, dressCode: null, description: null };
const SIDES = ["bride", "groom", "both"] as const;
const DIETS = ["veg", "non_veg", "jain", "vegan", null] as const;
const STATUSES = ["attending", "maybe", "declined", null] as const;
const SURNAMES = ["Sharma", "Verma", "Gupta", "Iyer", "Reddy", "Patel", "Singh", "Khan", "Das", "Mehta"];

let eventId = "";
const fnIds: string[] = [];

function p95(samples: number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
}

async function time(fn: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

beforeAll(async () => {
  await resetDb();
  const host = await makeUser("perf-host@example.com", "Host");
  const actor = actorOf(host);
  const event = await createEvent(db(), actor, { name: "Big wedding", startDate: "2026-12-10" });
  eventId = event.id;
  for (const [i, name] of ["Mehendi", "Haldi", "Sangeet", "Wedding", "Reception"].entries()) {
    const f = await createFunction(db(), eventId, actor, { name, date: `2026-12-${10 + Math.floor(i / 2)}`, ...blank });
    fnIds.push(f.id);
  }
  const hhRows = await db()
    .insert(households)
    .values(Array.from({ length: 250 }, (_, i) => ({ eventId, name: `${SURNAMES[i % 10]} family ${i}`, side: SIDES[i % 3] })))
    .returning({ id: households.id });
  const guestRows = await db()
    .insert(guests)
    .values(
      hhRows.flatMap((h, i) =>
        Array.from({ length: 4 }, (_, j) => ({
          eventId,
          householdId: h.id,
          name: `${["Rajesh", "Sunita", "Aarav", "Diya"][j]} ${SURNAMES[i % 10]} ${i}`,
          isHead: j === 0,
          sortOrder: j,
          ageGroup: j === 3 && i % 2 ? ("child" as const) : ("adult" as const),
          phone: j === 0 ? `+9198${String(10000000 + i).padStart(8, "0")}` : null,
          email: j === 1 ? `guest${i}@example.com` : null,
          diet: DIETS[(i + j) % 5],
          tags: i % 7 === 0 ? ["VIP"] : i % 5 === 0 ? ["college friends"] : [],
        })),
      ),
    )
    .returning({ id: guests.id });
  // Most guests are invited to most functions; ~3,900 invites, ~3,000 RSVPs.
  const invites = guestRows.flatMap((g, k) => fnIds.filter((_, f) => (k + f) % 5 !== 0).map((functionId) => ({ functionId, guestId: g.id })));
  for (let k = 0; k < invites.length; k += 1000) await db().insert(functionInvites).values(invites.slice(k, k + 1000));
  const answers = invites
    .map((inv, k) => ({ ...inv, status: STATUSES[k % 4] }))
    .filter((r): r is typeof r & { status: "attending" | "maybe" | "declined" } => r.status !== null);
  for (let k = 0; k < answers.length; k += 1000) await db().insert(rsvps).values(answers.slice(k, k + 1000));
  await db()
    .insert(guestTravel)
    .values(
      guestRows
        .filter((_, k) => k % 3 === 0)
        .map((g, k) => ({ guestId: g.id, arrivalMode: "flight" as const, arrivalAt: new Date(`2026-12-09T${String(6 + (k % 14)).padStart(2, "0")}:00:00Z`), needsPickup: k % 2 === 0 })),
    );
  await db().execute("analyze");
}, 120_000);

describe("performance at 1,000 guests (§4)", () => {
  it("filters and searches the guest list with p95 under 300 ms", async () => {
    const filters: GuestFilters[] = [
      {},
      { q: "sharma" },
      { q: "Diya" },
      { q: "9810000" },
      { q: "guest12" },
      { side: "bride" },
      { tag: "VIP" },
      { fn: fnIds[2] },
      { fn: "none" },
      { rsvp: "pending" },
      { rsvp: "attending", fn: fnIds[3] },
      { travel: "pickup" },
      { travel: "missing" },
      { diet: "jain", side: "groom" },
      { age: "child" },
      { q: "family 1", rsvp: "declined" },
      { q: "zzz-nobody" },
      { side: "both", travel: "submitted", fn: fnIds[1] },
      { diet: "unknown" },
      { tag: "college friends", rsvp: "maybe" },
    ];
    await listGuests(db(), eventId, {}); // warm-up (connection, plan cache)
    const samples: number[] = [];
    for (const [i, f] of filters.entries()) samples.push(await time(() => listGuests(db(), eventId, f, i % 3 === 0 ? 2 : 1)));
    const result = p95(samples);
    console.info(`[perf] listGuests p95 ${result.toFixed(1)} ms (max ${Math.max(...samples).toFixed(1)} ms)`);
    expect(result).toBeLessThan(300);
    const all = await listGuests(db(), eventId, {});
    expect(all.totalHouseholds).toBe(250);
    expect(all.households).toHaveLength(50);
  });

  it("exports all 1,000 guests quickly", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) samples.push(await time(() => listAllGuests(db(), eventId)));
    console.info(`[perf] listAllGuests p95 ${p95(samples).toFixed(1)} ms`);
    expect(p95(samples)).toBeLessThan(1000);
    expect(await listAllGuests(db(), eventId)).toHaveLength(1000);
  });

  it("computes RSVP headcounts and broadcast segments quickly", async () => {
    const hc: number[] = [];
    const seg: number[] = [];
    for (let i = 0; i < 10; i++) {
      hc.push(await time(() => headcounts(db(), eventId)));
      seg.push(
        await time(async () => {
          const ids = await resolveSegment(db(), eventId, { sides: ["bride"], rsvp: ["pending"], functionIds: [fnIds[i % 5]], travel: ["needs_pickup", "none"] });
          await recipientsFor(db(), eventId, ids);
        }),
      );
    }
    console.info(`[perf] headcounts p95 ${p95(hc).toFixed(1)} ms; segment+recipients p95 ${p95(seg).toFixed(1)} ms`);
    expect(p95(hc)).toBeLessThan(300);
    expect(p95(seg)).toBeLessThan(300);
    const all = await resolveSegment(db(), eventId, {});
    const recipients = await time(() => recipientsFor(db(), eventId, all, true));
    console.info(`[perf] recipientsFor(all families) ${recipients.toFixed(1)} ms`);
    expect(recipients).toBeLessThan(300);
  });

  it("builds the offline check-in snapshot quickly", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) samples.push(await time(() => checkInSnapshot(db(), eventId, fnIds[3])));
    console.info(`[perf] checkInSnapshot p95 ${p95(samples).toFixed(1)} ms`);
    expect(p95(samples)).toBeLessThan(500);
  });
});
