import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { auditLogs, cashHandovers, eventMembers, functions, giftItemRecipients, giftItems, gifts, notifications } from "@/db/schema";
import { createTranslator } from "@/i18n/core";
import { buildGiftsWorkbook } from "@/lib/exports";
import { renderNotification } from "@/lib/notifications";
import { createEvent } from "@/lib/events";
import { createFunction, deleteFunction } from "@/lib/functions";
import {
  autoStatus,
  createGiftItem,
  deleteGiftItem,
  getGiftItem,
  giftSummary,
  listGiftItems,
  markGiven,
  neededQuantityOf,
  recordBought,
  sendGiftReminders,
  setGiftRecipients,
  setGiftStatus,
  updateGiftItem,
  whenDate,
  type GiftCtx,
  type GiftItemInput,
} from "@/lib/gifts";
import { createHousehold, deleteHousehold, guestSchema } from "@/lib/guests";
import { ForbiddenError } from "@/lib/policy";
import { actorOf, db, makeUser, resetDb } from "./helpers";

beforeEach(resetDb);

const blank = { startTime: null, endTime: null, venueName: null, venueAddress: null, mapUrl: null, dressCode: null, description: null };
const hh = (name: string) => ({ name, side: "bride" as const, address: null, city: null, postalCode: null, notes: null });
const g = (v: Record<string, unknown>) => guestSchema.parse(v);
const NOW = new Date("2026-12-05T06:00:00Z"); // 11:30 IST

async function setup() {
  const hostUser = await makeUser("host@example.com", "Asha");
  const actor = actorOf(hostUser);
  const event = await createEvent(db(), actor, { name: "Wedding", coupleNames: "Priya & Arjun" });
  const sangeet = await createFunction(db(), event.id, actor, { name: "Sangeet", date: "2026-12-10", ...blank });
  const wedding = await createFunction(db(), event.id, actor, { name: "Wedding", date: "2026-12-20", ...blank });
  // Sangeet: 3 families, 6 guests, 4 adults. Wedding: 1 family.
  const sharma = await createHousehold(db(), event.id, actor, {
    household: hh("Sharma"),
    members: [g({ name: "Rajesh" }), g({ name: "Meena" }), g({ name: "Chintu", ageGroup: "child" })],
    functionIds: [sangeet.id, wedding.id],
  });
  const verma = await createHousehold(db(), event.id, actor, { household: hh("Verma"), members: [g({ name: "Anil" }), g({ name: "Baby", ageGroup: "infant" })], functionIds: [sangeet.id] });
  const gupta = await createHousehold(db(), event.id, actor, { household: hh("Gupta"), members: [g({ name: "Raj" })], functionIds: [sangeet.id] });
  const plannerUser = await makeUser("planner@example.com", "Ravi");
  await db().insert(eventMembers).values({ eventId: event.id, userId: plannerUser.id, role: "planner" });
  const H: GiftCtx = { eventId: event.id, actor, subject: { isAppAdmin: false, membership: { role: "host", giftAccess: "none" } } };
  const P: GiftCtx = { eventId: event.id, actor: actorOf(plannerUser), subject: { isAppAdmin: false, membership: { role: "planner", giftAccess: "none" } } };
  return { hostUser, plannerUser, actor, event, sangeet, wedding, sharma, verma, gupta, H, P };
}

const fixed = (name: string, n: number, extra: Partial<GiftItemInput> = {}): GiftItemInput => ({ name, quantityMode: "fixed", quantityFixed: n, ...extra });

describe("gift list items (GFT-01..05)", () => {
  it("creates and edits items, with a version check", async () => {
    const s = await setup();
    const item = await createGiftItem(db(), s.H, fixed("Shawl", 4, { category: "family", forWhom: "Groom's sisters", giveBy: "2026-12-08", unitCostPaise: 1500_00, source: "Lajpat Nagar" }));
    expect(item).toMatchObject({ name: "Shawl", category: "family", forWhom: "Groom's sisters", status: "to_buy", quantityBought: 0, version: 1 });
    const v2 = await updateGiftItem(db(), s.H, item.id, 1, fixed("Pashmina shawl", 5, { category: "family" }));
    expect(v2).toMatchObject({ name: "Pashmina shawl", quantityFixed: 5, version: 2, forWhom: null });
    await expect(updateGiftItem(db(), s.H, item.id, 1, fixed("Again", 5))).rejects.toMatchObject({ code: "stale" });
    await expect(createGiftItem(db(), s.H, { name: "", quantityMode: "fixed", quantityFixed: 1 })).rejects.toMatchObject({ code: "invalid" });
    await expect(createGiftItem(db(), s.H, { name: "No number", quantityMode: "fixed" })).rejects.toMatchObject({ code: "needs_quantity" });
    await deleteGiftItem(db(), s.H, item.id);
    expect(await db().select().from(giftItems)).toHaveLength(0);
  });

  it("rejects functions, families and assignees from another event", async () => {
    const s = await setup();
    const other = await createEvent(db(), s.actor, { name: "Other" });
    const otherFn = await createFunction(db(), other.id, s.actor, { name: "Haldi", date: "2026-12-01", ...blank });
    const otherHh = await createHousehold(db(), other.id, s.actor, { household: hh("Kapoor"), members: [g({ name: "K" })] });
    const outsider = await makeUser("out@example.com");
    await expect(createGiftItem(db(), s.H, fixed("A", 1, { functionId: otherFn.id }))).rejects.toMatchObject({ code: "bad_function" });
    await expect(createGiftItem(db(), s.H, fixed("A", 1, { householdIds: [otherHh.household.id] }))).rejects.toMatchObject({ code: "bad_household" });
    await expect(createGiftItem(db(), s.H, fixed("A", 1, { assigneeId: outsider.id }))).rejects.toMatchObject({ code: "bad_assignee" });
    const item = await createGiftItem(db(), s.H, fixed("A", 1, { householdIds: [s.sharma.household.id] }));
    await expect(setGiftRecipients(db(), s.H, item.id, [s.verma.household.id, otherHh.household.id])).rejects.toMatchObject({ code: "bad_household" });
    // Nothing changed on the failed attempt.
    expect((await getGiftItem(db(), s.H, item.id)).recipients.map((r) => r.name)).toEqual(["Sharma"]);
    // Another event's item looks like a missing one.
    const O: GiftCtx = { ...s.H, eventId: other.id };
    await expect(getGiftItem(db(), O, item.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(setGiftStatus(db(), O, item.id, "bought")).rejects.toMatchObject({ code: "not_found" });
  });

  it("links quantities to the guest list: per family / guest / adult, plus spares", async () => {
    const s = await setup();
    const perFamily = await createGiftItem(db(), s.H, { name: "Mithai box", category: "return_gift", functionId: s.sangeet.id, quantityMode: "per_family", quantityExtra: 5 });
    const perGuest = await createGiftItem(db(), s.H, { name: "Bangles", functionId: s.sangeet.id, quantityMode: "per_guest" });
    const perAdult = await createGiftItem(db(), s.H, { name: "Potli", functionId: s.wedding.id, quantityMode: "per_adult", quantityFunctionId: s.sangeet.id, quantityExtra: 1 });
    expect(await neededQuantityOf(db(), s.event.id, perFamily)).toBe(8); // 3 families + 5
    expect(await neededQuantityOf(db(), s.event.id, perGuest)).toBe(6);
    expect(await neededQuantityOf(db(), s.event.id, perAdult)).toBe(5); // 4 adults at the Sangeet + 1
    // A family invited later raises the count.
    await createHousehold(db(), s.event.id, s.actor, { household: hh("Jain"), members: [g({ name: "J" })], functionIds: [s.sangeet.id] });
    expect((await getGiftItem(db(), s.H, perFamily.id)).needed).toBe(9);
  });

  it("needs a function for linked quantities", async () => {
    const s = await setup();
    await expect(createGiftItem(db(), s.H, { name: "Box", quantityMode: "per_family" })).rejects.toMatchObject({ code: "needs_function" });
    const item = await createGiftItem(db(), s.H, { name: "Box", functionId: s.sangeet.id, quantityMode: "per_family" });
    await deleteFunction(db(), s.event.id, s.sangeet.id, s.actor);
    const [row] = await db().select().from(giftItems).where(eq(giftItems.id, item.id));
    await expect(neededQuantityOf(db(), s.event.id, row)).rejects.toMatchObject({ code: "needs_function" });
    // The list still shows it, without a count.
    expect((await getGiftItem(db(), s.H, item.id)).needed).toBeNull();
  });

  it("moves to bought when enough are bought; 'given' never moves back", async () => {
    const s = await setup();
    const item = await createGiftItem(db(), s.H, { name: "Mithai box", functionId: s.sangeet.id, quantityMode: "per_family", quantityExtra: 5 });
    let r = await recordBought(db(), s.H, item.id, { add: 3 });
    expect(r).toMatchObject({ quantityBought: 3, status: "to_buy" });
    r = await setGiftStatus(db(), s.H, item.id, "ordered");
    r = await recordBought(db(), s.H, item.id, { add: 5 });
    expect(r).toMatchObject({ quantityBought: 8, status: "bought" });
    r = await recordBought(db(), s.H, item.id, { add: -100 });
    expect(r.quantityBought).toBe(0);
    // Marking given leaves the count alone.
    r = await markGiven(db(), s.H, item.id);
    expect(r).toMatchObject({ status: "given", quantityBought: 0 });
    r = await recordBought(db(), s.H, item.id, { set: 2 });
    expect(r.status).toBe("given");
    // Reopening a given item follows the counts: 2 of 8 → to buy.
    r = await setGiftStatus(db(), s.H, item.id, "to_buy");
    expect(r).toMatchObject({ status: "to_buy", quantityBought: 2 });
    expect(autoStatus("given", 0, 10)).toBe("given");
    expect(autoStatus("to_buy", 0, 0)).toBe("to_buy");
    // Marking bought fills the count up to what's needed.
    const coins = await createGiftItem(db(), s.H, fixed("Coins", 10));
    expect(await setGiftStatus(db(), s.H, coins.id, "bought")).toMatchObject({ quantityBought: 10 });
    // All bought, then given, then reopened: back to "bought", not stuck on "to buy".
    await markGiven(db(), s.H, coins.id);
    expect(await setGiftStatus(db(), s.H, coins.id, "to_buy")).toMatchObject({ status: "bought", quantityBought: 10 });
  });

  it("rejects a bought count from a stale page", async () => {
    const s = await setup();
    const item = await createGiftItem(db(), s.H, fixed("Coins", 10));
    await recordBought(db(), s.P, item.id, { add: 2 }); // someone else, meanwhile (version 2)
    await expect(recordBought(db(), s.H, item.id, { set: 5 }, 1)).rejects.toMatchObject({ code: "stale" });
    expect(await recordBought(db(), s.H, item.id, { set: 5 }, 2)).toMatchObject({ quantityBought: 5, version: 3 });
  });

  it("removes a family's recipient link when the family is deleted", async () => {
    const s = await setup();
    const item = await createGiftItem(db(), s.H, fixed("Shawl", 2, { householdIds: [s.sharma.household.id, s.verma.household.id] }));
    await deleteHousehold(db(), s.event.id, s.verma.household.id, s.actor);
    expect((await getGiftItem(db(), s.H, item.id)).recipients.map((r) => r.name)).toEqual(["Sharma"]);
    expect(await db().select().from(giftItemRecipients)).toHaveLength(1);
  });
});

describe("views and summary (GFT-06)", () => {
  it("filters, orders by when it's needed, and summarises", async () => {
    const s = await setup();
    // Sangeet 12-10 (within 7 days of 12-05), Wedding 12-20, give-by 12-03 (overdue), undated.
    const box = await createGiftItem(db(), s.H, { name: "Mithai box", category: "return_gift", functionId: s.sangeet.id, quantityMode: "per_family", quantityExtra: 5, unitCostPaise: 250_00 });
    const shawl = await createGiftItem(db(), s.H, fixed("Shawl", 4, { category: "family", forWhom: "Groom's sisters", functionId: s.wedding.id, giveBy: "2026-12-03", assigneeId: s.plannerUser.id }));
    const envelope = await createGiftItem(db(), s.H, fixed("Envelopes for staff", 20, { category: "helpers_staff", functionId: s.wedding.id, unitCostPaise: 100_00 }));
    const later = await createGiftItem(db(), s.H, fixed("Thank-you hamper", 2, { category: "vendor" }));
    await setGiftStatus(db(), s.H, envelope.id, "bought");

    const all = await listGiftItems(db(), s.H, {}, NOW);
    expect(all.map((r) => r.name)).toEqual(["Shawl", "Mithai box", "Envelopes for staff", "Thank-you hamper"]);
    expect(whenDate("2026-12-03", "2026-12-20")).toBe("2026-12-03");
    const byName = Object.fromEntries(all.map((r) => [r.name, r]));
    expect(byName["Shawl"]).toMatchObject({ when: "2026-12-03", overdue: true, dueSoon: true, assigneeName: "Ravi" });
    expect(byName["Mithai box"]).toMatchObject({ needed: 8, remaining: 8, dueSoon: true, overdue: false, totalCostPaise: 2000_00 });
    expect(byName["Envelopes for staff"]).toMatchObject({ dueSoon: false, remaining: 0 });
    expect(byName["Thank-you hamper"]).toMatchObject({ when: null, dueSoon: false });

    const names = async (f: Record<string, string>, c: GiftCtx = s.H) => (await listGiftItems(db(), c, f, NOW)).map((r) => r.name);
    expect(await names({ due: "week" })).toEqual(["Shawl", "Mithai box"]);
    expect(await names({ category: "return_gift" })).toEqual(["Mithai box"]);
    expect(await names({ status: "bought" })).toEqual(["Envelopes for staff"]);
    expect(await names({ fn: s.wedding.id })).toEqual(["Shawl", "Envelopes for staff"]);
    expect(await names({ fn: "none" })).toEqual(["Thank-you hamper"]);
    expect(await names({ q: "sisters" })).toEqual(["Shawl"]);
    expect(await names({ q: "50%_" })).toEqual([]);
    expect(await names({ mine: "1" }, s.P)).toEqual(["Shawl"]);

    const sum = await giftSummary(db(), s.H, NOW);
    expect(sum).toEqual({ items: 4, itemsDone: 1, totalNeeded: 34, totalBought: 20, remaining: 14, dueSoon: 2, estimatedCostPaise: 2000_00 + 2000_00 });
    // A limited page keeps the same stable order; the summary still counts everything.
    expect((await listGiftItems(db(), s.H, {}, NOW, 2)).map((r) => r.name)).toEqual(["Shawl", "Mithai box"]);
    expect((await giftSummary(db(), s.H, NOW)).items).toBe(4);
    void box;
    void shawl;
    void later;
  });
});

describe("access and audit (GFT-07)", () => {
  it("lets Planners view and edit; outsiders and vendors can't", async () => {
    const s = await setup();
    const item = await createGiftItem(db(), s.P, fixed("Coins", 10));
    await recordBought(db(), s.P, item.id, { add: 4 });
    expect((await listGiftItems(db(), s.P)).map((r) => r.quantityBought)).toEqual([4]);
    const outsider: GiftCtx = { ...s.P, subject: { isAppAdmin: false, membership: null } };
    const vendor: GiftCtx = { ...s.P, subject: { isAppAdmin: false, membership: null, vendor: { vendorId: "v1" } } };
    await expect(listGiftItems(db(), outsider)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createGiftItem(db(), vendor, fixed("X", 1))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("audits create, edit, status and delete with the name only (no costs)", async () => {
    const s = await setup();
    const item = await createGiftItem(db(), s.H, fixed("Silver coin", 10, { unitCostPaise: 1234_00 }));
    await updateGiftItem(db(), s.H, item.id, 1, fixed("Silver coin", 12, { unitCostPaise: 1234_00 }));
    await recordBought(db(), s.H, item.id, { add: 12 });
    await deleteGiftItem(db(), s.H, item.id);
    const logs = await db().select().from(auditLogs).where(and(eq(auditLogs.eventId, s.event.id), eq(auditLogs.entityType, "gift_item")));
    expect(logs.map((l) => l.action)).toEqual(["gift_item.created", "gift_item.updated", "gift_item.status_changed", "gift_item.deleted"]);
    for (const l of logs) expect(l.data).toEqual({ name: "Silver coin" });
    expect(JSON.stringify(logs)).not.toMatch(/1234|123400/);
  });
});

describe("due-soon reminder (GFT-06)", () => {
  it("notifies the assignee once, or the Hosts when nobody is assigned", async () => {
    const s = await setup();
    await createGiftItem(db(), s.H, fixed("Shawl", 4, { giveBy: "2026-12-11", assigneeId: s.plannerUser.id }));
    await createGiftItem(db(), s.H, { name: "Mithai box", functionId: s.sangeet.id, quantityMode: "per_family" });
    const later = await createGiftItem(db(), s.H, fixed("Hamper", 2, { functionId: s.wedding.id }));
    const done = await createGiftItem(db(), s.H, fixed("Coins", 3, { giveBy: "2026-12-06" }));
    await setGiftStatus(db(), s.H, done.id, "bought");

    expect(await sendGiftReminders(db(), NOW)).toBe(2);
    expect(await sendGiftReminders(db(), new Date("2026-12-06T06:00:00Z"))).toBe(0);
    const rows = await db().select().from(notifications).where(eq(notifications.kind, "gift.due"));
    expect(rows.map((n) => [n.userId, n.data.name]).sort()).toEqual(
      [
        [s.plannerUser.id, "Shawl"],
        [s.hostUser.id, "Mithai box"],
      ].sort(),
    );
    expect(rows.every((n) => n.href === `/events/${s.event.id}/gifts`)).toBe(true);
    // The Wedding (12-20) comes within 7 days on 12-13 (IST): reminded then, once.
    expect(await sendGiftReminders(db(), new Date("2026-12-12T18:00:00Z"))).toBe(0);
    expect(await sendGiftReminders(db(), new Date("2026-12-12T19:00:00Z"))).toBe(1);
    // Rescheduling the function re-arms the reminder for the new date, once.
    await db().update(functions).set({ date: "2026-12-16" }).where(eq(functions.id, s.wedding.id));
    expect(await sendGiftReminders(db(), new Date("2026-12-13T06:00:00Z"))).toBe(1);
    expect(await sendGiftReminders(db(), new Date("2026-12-14T06:00:00Z"))).toBe(0);
    // So does moving the give-by date.
    await updateGiftItem(db(), s.H, later.id, 1, fixed("Hamper", 2, { giveBy: "2026-12-15" }));
    expect(await sendGiftReminders(db(), new Date("2026-12-14T06:00:00Z"))).toBe(1);
    const [row] = await db().select().from(giftItems).where(eq(giftItems.id, later.id));
    expect(row.remindedFor).toBe("2026-12-15");
  });

  it("shows the date in the reader's language", async () => {
    const s = await setup();
    await createGiftItem(db(), s.H, fixed("Shawl", 4, { giveBy: "2026-12-10" }));
    await sendGiftReminders(db(), NOW);
    const [n] = await db().select().from(notifications).where(eq(notifications.kind, "gift.due"));
    expect(n.data.date).toBe("2026-12-10");
    const en = renderNotification("en", n);
    const hi = renderNotification("hi", n);
    expect(en).toContain("Shawl");
    expect(en).not.toContain("2026-12-10");
    expect(en).toMatch(/10 Dec 2026/);
    expect(hi).not.toContain("2026-12-10");
    expect(hi).toMatch(/10 दिस॰? 2026|10 दिसं॰? 2026|10 दिसंबर 2026/);
  });
});

describe("archive (EVT-08)", () => {
  const sheetsOf = async (buf: Buffer) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    return wb;
  };

  it("adds read-only sheets for gifts received before the change, only when there are any", async () => {
    const s = await setup();
    const t = createTranslator("en");
    await createGiftItem(db(), s.H, fixed("Shawl", 4));
    let wb = await sheetsOf(await buildGiftsWorkbook(db(), s.H, t, "en"));
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Gifts to give", "Thank-you notes"]);

    await db().insert(gifts).values({ eventId: s.event.id, householdId: s.sharma.household.id, type: "cash", amountPaise: 5100_00, envelopeNo: "12", recordedBy: s.hostUser.id });
    await db().insert(cashHandovers).values({ eventId: s.event.id, functionId: s.sangeet.id, collectorUserId: s.hostUser.id, recordedTotalPaise: 5100_00, countedPaise: 5000_00, handedToName: "Papa" });
    wb = await sheetsOf(await buildGiftsWorkbook(db(), s.H, t, "en"));
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Gifts to give", "Thank-you notes", "Gifts received to 7 Nov 2026", "Cash hand-overs (old)"]);
    const received = wb.getWorksheet("Gifts received to 7 Nov 2026")!;
    expect(received.getRow(2).values).toEqual(expect.arrayContaining(["Sharma", "Cash shagun (envelope)", 5100, "12", "Asha"]));
    const cash = wb.getWorksheet("Cash hand-overs (old)")!;
    expect(cash.getRow(2).values).toEqual(expect.arrayContaining(["Sangeet", "Asha", 5100, 5000, -100, "Papa"]));
  });
});
