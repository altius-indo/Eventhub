import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLogs, eventMembers, gifts, notifications } from "@/db/schema";
import { createEvent } from "@/lib/events";
import { createFunction } from "@/lib/functions";
import { commitGiftImport, createGiftImport, getGiftImport, matchHousehold, reviewGiftImport } from "@/lib/gift-import";
import {
  createGift,
  createHandover,
  deleteGift,
  ERASED_GIVER,
  getGift,
  giftScope,
  giftSummary,
  householdsWithoutGift,
  listGifts,
  listHandovers,
  openCash,
  recordEnvelopes,
  updateGift,
  GiftError,
  type GiftCtx,
} from "@/lib/gifts";
import { createHousehold, deleteHousehold, guestSchema } from "@/lib/guests";
import { ForbiddenError, type PolicySubject } from "@/lib/policy";
import { actorOf, db, makeUser, resetDb } from "./helpers";

beforeEach(resetDb);

const blank = { startTime: null, endTime: null, venueName: null, venueAddress: null, mapUrl: null, dressCode: null, description: null };
const hh = (name: string, side: "bride" | "groom" | "both" = "bride") => ({ name, side, address: null, city: null, postalCode: null, notes: null });
const g = (v: Record<string, unknown>) => guestSchema.parse(v);
const host = (eventId: string, user: { id: string }): GiftCtx => ({ eventId, actor: actorOf({ id: user.id, isAppAdmin: false }), subject: { isAppAdmin: false, membership: { role: "host", giftAccess: "none" } } });
const planner = (eventId: string, user: { id: string }, giftAccess: "none" | "record" | "full"): GiftCtx => ({
  eventId,
  actor: actorOf({ id: user.id, isAppAdmin: false }),
  subject: { isAppAdmin: false, membership: { role: "planner", giftAccess } },
});

async function setup() {
  const hostUser = await makeUser("host@example.com", "Asha");
  const actor = actorOf(hostUser);
  const event = await createEvent(db(), actor, { name: "Wedding", coupleNames: "Priya & Arjun" });
  const sangeet = await createFunction(db(), event.id, actor, { name: "Sangeet", date: "2026-12-10", ...blank });
  const wedding = await createFunction(db(), event.id, actor, { name: "Wedding", date: "2026-12-11", ...blank });
  const sharma = await createHousehold(db(), event.id, actor, { household: hh("Sharma family"), members: [g({ name: "Rajesh Sharma", phone: "9876543210" }), g({ name: "Sunita" })] });
  const verma = await createHousehold(db(), event.id, actor, { household: hh("Verma", "groom"), members: [g({ name: "Anil Verma", phone: "9999988888" })] });
  const rec = await makeUser("rec@example.com", "Ravi");
  const rec2 = await makeUser("rec2@example.com", "Meena");
  await db().insert(eventMembers).values([
    { eventId: event.id, userId: rec.id, role: "planner", giftAccess: "record" },
    { eventId: event.id, userId: rec2.id, role: "planner", giftAccess: "record" },
  ]);
  return { hostUser, event, sangeet, wedding, sharma, verma, H: host(event.id, hostUser), R: planner(event.id, rec, "record"), R2: planner(event.id, rec2, "record"), rec, rec2 };
}

const KEY = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("gift register", () => {
  it("records, edits with a version check and audits every change without amounts", async () => {
    const s = await setup();
    const { gift } = await createGift(db(), s.H, { householdId: s.sharma.household.id, type: "cash", amountPaise: 510000, functionId: s.sangeet.id, envelopeNo: "12" });
    expect(gift.recordedBy).toBe(s.hostUser.id);
    await expect(updateGift(db(), s.H, gift.id, 99, { householdId: s.sharma.household.id, type: "cash", amountPaise: 1 })).rejects.toMatchObject({ code: "stale" });
    const { gift: g2 } = await updateGift(db(), s.H, gift.id, 1, { householdId: s.sharma.household.id, type: "item", itemDescription: "Silver lamp", amountPaise: null });
    expect([g2.type, g2.amountPaise, g2.itemDescription, g2.version]).toEqual(["item", null, "Silver lamp", 2]);
    await expect(createGift(db(), s.H, { type: "cash", amountPaise: 100 })).rejects.toMatchObject({ code: "no_giver" });
    await expect(createGift(db(), s.H, { giverName: "Uncle", type: "cash" })).rejects.toMatchObject({ code: "no_value" });
    await deleteGift(db(), s.H, gift.id);
    const logs = await db().select().from(auditLogs).where(eq(auditLogs.eventId, s.event.id));
    const giftLogs = logs.filter((l) => l.action.startsWith("gift."));
    expect(giftLogs.map((l) => l.action).sort()).toEqual(["gift.deleted", "gift.recorded", "gift.updated"]);
    for (const l of giftLogs) expect(JSON.stringify(l.data)).not.toMatch(/5100|510000/);
  });

  it("rejects a household or function from another event", async () => {
    const s = await setup();
    const other = await createEvent(db(), actorOf(s.hostUser), { name: "Other" });
    const fh = await createHousehold(db(), other.id, actorOf(s.hostUser), { household: hh("X"), members: [g({ name: "X" })] });
    await expect(createGift(db(), s.H, { householdId: fh.household.id, type: "cash", amountPaise: 100 })).rejects.toMatchObject({ code: "bad_household" });
  });
});

describe("privacy (GFT-07)", () => {
  it("a planner without gift access gets nothing", async () => {
    const s = await setup();
    const none = planner(s.event.id, s.rec, "none");
    expect(() => giftScope(none.subject)).toThrow(ForbiddenError);
    await expect(listGifts(db(), none)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createGift(db(), none, { giverName: "A", type: "cash", amountPaise: 100 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordEnvelopes(db(), none, s.sangeet.id, [{ clientKey: KEY(1), giverName: "A", amountPaise: 100 }])).rejects.toBeInstanceOf(ForbiddenError);
    await expect(openCash(db(), none)).rejects.toBeInstanceOf(ForbiddenError);
    const vendorish: PolicySubject = { isAppAdmin: false, membership: null, vendor: { vendorId: KEY(9) } };
    await expect(listGifts(db(), { ...none, subject: vendorish })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("record-only planners see and edit only their own entries, and no totals", async () => {
    const s = await setup();
    const { gift: hostGift } = await createGift(db(), s.H, { householdId: s.verma.household.id, type: "cash", amountPaise: 1100_00 });
    const { gift: mine } = await createGift(db(), s.R, { householdId: s.sharma.household.id, type: "cash", amountPaise: 500_00 });
    expect((await listGifts(db(), s.R)).map((x) => x.id)).toEqual([mine.id]);
    expect((await listGifts(db(), s.R2)).map((x) => x.id)).toEqual([]);
    expect((await listGifts(db(), s.H)).length).toBe(2);
    await expect(getGift(db(), s.R, hostGift.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(updateGift(db(), s.R, hostGift.id, 1, { giverName: "x", type: "cash", amountPaise: 1 })).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteGift(db(), s.R2, mine.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(giftSummary(db(), s.R)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(householdsWithoutGift(db(), s.R)).rejects.toBeInstanceOf(ForbiddenError);
    const full = planner(s.event.id, s.rec, "full");
    expect((await giftSummary(db(), full)).total.amountPaise).toBe(1600_00);
  });
});

describe("envelope mode (GFT-02)", () => {
  it("stores an entry once across retries and two devices", async () => {
    const s = await setup();
    const item = { clientKey: KEY(1), householdId: s.sharma.household.id, amountPaise: 2100_00, envelopeNo: "7" };
    const first = await recordEnvelopes(db(), s.R, s.sangeet.id, [item]);
    expect(first.created).toEqual([KEY(1)]);
    for (let i = 0; i < 3; i++) {
      const again = await recordEnvelopes(db(), s.R, s.sangeet.id, [item, item]);
      expect([again.created, again.existing]).toEqual([[], [KEY(1)]]);
    }
    // Same queue synced from a second device (and concurrently).
    const both = await Promise.all([recordEnvelopes(db(), s.R, s.sangeet.id, [item]), recordEnvelopes(db(), s.R, s.sangeet.id, [item, { ...item, clientKey: KEY(2), envelopeNo: "8" }])]);
    expect(both.flatMap((b) => b.created)).toEqual([KEY(2)]);
    const rows = await db().select().from(gifts).where(eq(gifts.eventId, s.event.id));
    expect(rows.filter((r) => r.clientKey === KEY(1))).toHaveLength(1);
    expect(rows[0].source).toBe("envelope");
  });

  it("flags a duplicate envelope number in the same function, allows unknown givers, rejects per item", async () => {
    const s = await setup();
    await recordEnvelopes(db(), s.R, s.sangeet.id, [{ clientKey: KEY(1), householdId: s.sharma.household.id, amountPaise: 100_00, envelopeNo: "15" }]);
    const r = await recordEnvelopes(db(), s.R2, s.sangeet.id, [
      { clientKey: KEY(2), giverName: "Unknown uncle", amountPaise: 501_00, envelopeNo: "15" },
      { clientKey: KEY(3), giverName: "No value", amountPaise: null },
      { clientKey: KEY(4), householdId: KEY(99), amountPaise: 100 },
    ]);
    expect(r.created).toEqual([KEY(2)]);
    expect(r.duplicateEnvelopes).toEqual([{ clientKey: KEY(2), envelopeNo: "15" }]);
    expect(r.rejected).toEqual([
      { clientKey: KEY(3), code: "no_value" },
      { clientKey: KEY(4), code: "bad_household" },
    ]);
    // Another function: the same number is fine.
    const w = await recordEnvelopes(db(), s.R2, s.wedding.id, [{ clientKey: KEY(5), giverName: "A", amountPaise: 100, envelopeNo: "15" }]);
    expect(w.duplicateEnvelopes).toEqual([]);
    const { duplicateEnvelope } = await createGift(db(), s.H, { giverName: "B", type: "cash", amountPaise: 100, functionId: s.sangeet.id, envelopeNo: "15" });
    expect(duplicateEnvelope).toBe(true);
  });
});

describe("cash reconciliation (GFT-03)", () => {
  it("snapshots open cash, flags a discrepancy to Hosts only, and leaves later entries open", async () => {
    const s = await setup();
    await recordEnvelopes(db(), s.R, s.sangeet.id, [
      { clientKey: KEY(1), householdId: s.sharma.household.id, amountPaise: 2100_00 },
      { clientKey: KEY(2), giverName: "Guest", amountPaise: 1100_00 },
      { clientKey: KEY(3), giverName: "Item", type: "item", itemDescription: "Watch" },
    ]);
    await recordEnvelopes(db(), s.R2, s.sangeet.id, [{ clientKey: KEY(4), giverName: "Other", amountPaise: 500_00 }]);
    const open = await openCash(db(), s.R);
    expect(open).toEqual([expect.objectContaining({ functionId: s.sangeet.id, collectorUserId: s.rec.id, count: 2, totalPaise: 3200_00 })]);
    expect((await openCash(db(), s.H)).length).toBe(2);
    // A record-only collector can't record someone else's hand-over.
    await expect(createHandover(db(), s.R, { functionId: s.sangeet.id, collectorUserId: s.rec2.id, countedPaise: 0, handedToName: "Dad" })).rejects.toBeInstanceOf(GiftError);
    const h = await createHandover(db(), s.R, { functionId: s.sangeet.id, collectorUserId: s.rec.id, countedPaise: 3100_00, handedToUserId: s.hostUser.id });
    expect([h.count, h.handover.recordedTotalPaise, h.discrepancyPaise]).toEqual([2, 3200_00, -100_00]);
    const notes = await db().select().from(notifications).where(eq(notifications.eventId, s.event.id));
    expect(notes.map((n) => [n.userId, n.kind])).toEqual([[s.hostUser.id, "gift.handover_discrepancy"]]);
    expect(notes[0].data).toMatchObject({ function: "Sangeet" });

    // Synced after the hand-over: open again, not part of the snapshot.
    await recordEnvelopes(db(), s.R, s.sangeet.id, [{ clientKey: KEY(5), giverName: "Late", amountPaise: 300_00 }]);
    expect(await openCash(db(), s.R)).toEqual([expect.objectContaining({ count: 1, totalPaise: 300_00 })]);
    const hs = await listHandovers(db(), s.R);
    expect(hs.map((x) => [x.recordedTotalPaise, x.currentTotalPaise])).toEqual([[3200_00, 3200_00]]);
    expect(await listHandovers(db(), s.R2)).toEqual([]);

    // Handed-over cash: locked for the collector; a Host's edit shows up as a changed total.
    const [handed] = (await listGifts(db(), s.R)).filter((x) => x.handedOver && x.giverName === "Guest");
    await expect(updateGift(db(), s.R, handed.id, handed.version, { giverName: "Guest", type: "cash", amountPaise: 1000_00 })).rejects.toMatchObject({ code: "handed_over" });
    await updateGift(db(), s.H, handed.id, handed.version, { giverName: "Guest", type: "cash", amountPaise: 1000_00, functionId: s.sangeet.id });
    const [after] = await listHandovers(db(), s.H);
    expect([after.recordedTotalPaise, after.currentTotalPaise]).toEqual([3200_00, 3100_00]);
  });

  it("matching counts don't notify", async () => {
    const s = await setup();
    await recordEnvelopes(db(), s.R, s.sangeet.id, [{ clientKey: KEY(1), giverName: "A", amountPaise: 100_00 }]);
    const h = await createHandover(db(), s.R, { functionId: s.sangeet.id, collectorUserId: s.rec.id, countedPaise: 100_00, handedToName: "Papa" });
    expect(h.discrepancyPaise).toBe(0);
    expect(await db().select().from(notifications)).toHaveLength(0);
    await expect(createHandover(db(), s.R, { functionId: s.sangeet.id, collectorUserId: s.rec.id, countedPaise: 0, handedToName: "Papa" })).rejects.toMatchObject({ code: "nothing_to_hand_over" });
  });
});

describe("summaries (GFT-05)", () => {
  it("totals by function, received-for and type, and lists families with no gift", async () => {
    const s = await setup();
    await createGift(db(), s.H, { householdId: s.sharma.household.id, type: "cash", amountPaise: 1100_00, functionId: s.sangeet.id, receivedFor: "bride" });
    await createGift(db(), s.H, { giverName: "Friend", type: "item", itemDescription: "Vase", estValuePaise: 2000_00, functionId: s.wedding.id });
    const sum = await giftSummary(db(), s.H);
    expect(sum.total).toEqual({ count: 2, amountPaise: 1100_00, estValuePaise: 2000_00 });
    expect(sum.byFunction.map((r) => [r.label, r.amountPaise])).toEqual([
      ["Sangeet", 1100_00],
      ["Wedding", 0],
    ]);
    expect(sum.byReceivedFor.find((r) => r.key === "bride")?.count).toBe(1);
    expect(sum.byType.find((r) => r.key === "item")?.estValuePaise).toBe(2000_00);
    expect((await householdsWithoutGift(db(), s.H)).map((h) => h.name)).toEqual(["Verma"]);
  });
});

describe("import (GFT-04)", () => {
  const csv = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

  it("matches names, keeps unmatched rows for review, and commits once", async () => {
    const s = await setup();
    const file = csv(
      ["Name,Amount,Envelope,Function,Item", "sharma  FAMILY,\"5,100\",1,Sangeet,", "Anil Verma,2100,2,wedding,", "Mystery guest,1100,3,,", ",500,4,,", "Gupta ji,,5,,Silver bowl", "Bad,abc,6,,"].join("\n"),
    );
    const imp = await createGiftImport(db(), s.H, "tally.csv", file);
    expect(imp.rows.map((r) => [r.decision, r.error ?? null])).toEqual([
      ["match", null],
      ["match", null],
      ["free_text", null],
      ["skip", "no_name"],
      ["free_text", null],
      ["skip", "bad_amount"],
    ]);
    expect(imp.rows[0].householdId).toBe(s.sharma.household.id);
    expect(imp.rows[0].amountPaise).toBe(5100_00);
    expect(imp.rows[1].householdId).toBe(s.verma.household.id);
    // Review: link the mystery guest to Verma, skip Gupta ji.
    await reviewGiftImport(db(), s.H, imp.id, [
      { index: 2, decision: "match", householdId: s.verma.household.id },
      { index: 4, decision: "skip" },
    ]);
    await expect(reviewGiftImport(db(), s.H, imp.id, [{ index: 3, decision: "free_text" }])).rejects.toMatchObject({ code: "invalid" });
    const r = await commitGiftImport(db(), s.H, imp.id, "2026-12-20");
    expect(r).toEqual({ created: 3, skipped: 3 });
    await expect(commitGiftImport(db(), s.H, imp.id, "2026-12-20")).rejects.toMatchObject({ code: "already_done" });
    const rows = await listGifts(db(), s.H, { source: "import" });
    expect(rows.map((x) => x.householdName).sort()).toEqual(["Sharma family", "Verma", "Verma"]);
    expect((await getGiftImport(db(), s.H, imp.id)).committedAt).not.toBeNull();
    // Imported tallies aren't cash anyone is holding.
    expect(await openCash(db(), s.H)).toEqual([]);
    await expect(createGiftImport(db(), s.R, "x.csv", file)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("matching is case/space-insensitive, then phone, then a unique partial", () => {
    const list = [
      { id: "a", name: "Sharma Family", members: ["Rajesh Sharma"], phones: ["+919876543210"] },
      { id: "b", name: "Verma", members: ["Anil"], phones: [] },
      { id: "c", name: "Vermani", members: [], phones: [] },
    ];
    expect(matchHousehold("  sharma   family ", null, list)).toBe("a");
    expect(matchHousehold("Unknown", "+919876543210", list)).toBe("a");
    expect(matchHousehold("rajesh", null, list)).toBe("a");
    expect(matchHousehold("verm", null, list)).toBeNull();
  });
});

describe("erasure (EVT-09)", () => {
  it("anonymises a family's gifts when they are deleted, keeping totals", async () => {
    const s = await setup();
    await recordEnvelopes(db(), s.R, s.sangeet.id, [{ clientKey: KEY(1), householdId: s.sharma.household.id, amountPaise: 2100_00 }]);
    await deleteHousehold(db(), s.event.id, s.sharma.household.id, actorOf(s.hostUser));
    const [row] = await db().select().from(gifts).where(eq(gifts.eventId, s.event.id));
    expect([row.householdId, row.guestId, row.giverName, row.amountPaise]).toEqual([null, null, ERASED_GIVER, 2100_00]);
    expect(await openCash(db(), s.R)).toEqual([expect.objectContaining({ totalPaise: 2100_00 })]);
  });
});
