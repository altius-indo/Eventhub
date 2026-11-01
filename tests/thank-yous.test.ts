import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { checkIns, devOutbox, eventMembers, notifications, outboundMessages, thankYous } from "@/db/schema";
import { createEvent } from "@/lib/events";
import { createFunction } from "@/lib/functions";
import { createGift, thankedStats, type GiftCtx } from "@/lib/gifts";
import { createHousehold, guestSchema } from "@/lib/guests";
import { processOutbox } from "@/lib/outbox";
import { ForbiddenError } from "@/lib/policy";
import {
  containsAmount,
  draftMany,
  estimateSend,
  listTracker,
  renderNote,
  saveDraft,
  saveTemplate,
  sendThankYous,
  sendThankYouReminders,
  setStatus,
  unthankedCount,
  validateTemplate,
  ThankYouError,
} from "@/lib/thank-yous";
import { actorOf, db, makeUser, resetDb } from "./helpers";

beforeEach(resetDb);

const blank = { startTime: null, endTime: null, venueName: null, venueAddress: null, mapUrl: null, dressCode: null, description: null };
const hh = (name: string) => ({ name, side: "bride" as const, address: null, city: null, postalCode: null, notes: null });
const g = (v: Record<string, unknown>) => guestSchema.parse(v);

async function setup() {
  const hostUser = await makeUser("host@example.com", "Asha");
  const actor = actorOf(hostUser);
  const event = await createEvent(db(), actor, { name: "Wedding", coupleNames: "Priya & Arjun" });
  const sangeet = await createFunction(db(), event.id, actor, { name: "Sangeet", date: "2026-12-10", ...blank });
  const sharma = await createHousehold(db(), event.id, actor, { household: hh("Sharma family"), members: [g({ name: "Rajesh", email: "rajesh@example.com" })], functionIds: [sangeet.id] });
  const verma = await createHousehold(db(), event.id, actor, { household: hh("Verma"), members: [g({ name: "Anil", email: "anil@example.com" })] });
  const nocontact = await createHousehold(db(), event.id, actor, { household: hh("Gupta"), members: [g({ name: "Raj" })] });
  const H: GiftCtx = { eventId: event.id, actor, subject: { isAppAdmin: false, membership: { role: "host", giftAccess: "none" } } };
  return { hostUser, event, sangeet, sharma, verma, nocontact, H };
}

describe("templates and rendering (GFT-09)", () => {
  it("allows only whitelisted fields and no amounts", () => {
    expect(() => validateTemplate("Dear {guestName}, thank you for the {giftItem}. Love, {coupleNames}")).not.toThrow();
    expect(() => validateTemplate("Thanks for {amount}")).toThrow(ThankYouError);
    expect(() => validateTemplate("Thanks for the ₹5,100 shagun")).toThrow(ThankYouError);
    expect(() => validateTemplate("Thanks for Rs. 1100")).toThrow(ThankYouError);
    expect(() => validateTemplate("धन्यवाद 1100 रुपये के लिए")).toThrow(ThankYouError);
    expect(containsAmount("See you on 12 December")).toBe(false);
  });

  it("never renders an amount, even when the family gave cash and an item note has one", async () => {
    const s = await setup();
    await createGift(db(), s.H, { householdId: s.sharma.household.id, type: "cash", amountPaise: 5100_00 });
    await createGift(db(), s.H, { householdId: s.sharma.household.id, type: "item", itemDescription: "Silver lamp (₹ 4,500)" });
    const tpl = await saveTemplate(db(), s.H, null, { locale: "en", name: "Warm", body: "Dear {guestName}, thank you for the {giftItem}. {personalLine} — {coupleNames}" });
    const ty = await saveDraft(db(), s.H, s.sharma.household.id, { templateId: tpl.id, personalLine: "Loved dancing with you." });
    expect(ty.status).toBe("drafted");
    expect(ty.draftText).toContain("Silver lamp");
    expect(ty.draftText).toContain("Priya & Arjun");
    expect(ty.draftText).not.toMatch(/5100|5,100|4,500|4500|₹/);
    expect(renderNote("{guestName} {amount}", { guestName: "A", coupleNames: "", functionsAttended: "", giftItem: "", personalLine: "" })).toBe("A");
    await expect(saveDraft(db(), s.H, s.sharma.household.id, { text: "Thank you for ₹5,100!" })).rejects.toMatchObject({ code: "contains_amount" });
  });

  it("uses a plain word for the gift when no item is recorded, in the template's language", async () => {
    const s = await setup();
    await createGift(db(), s.H, { householdId: s.verma.household.id, type: "cash", amountPaise: 1100_00 });
    const en = await saveTemplate(db(), s.H, null, { locale: "en", name: "E", body: "Thanks for the lovely {giftItem}." });
    const hi = await saveTemplate(db(), s.H, null, { locale: "hi", name: "H", body: "सुंदर {giftItem} के लिए धन्यवाद।" });
    expect((await saveDraft(db(), s.H, s.verma.household.id, { templateId: en.id })).draftText).toBe("Thanks for the lovely gift.");
    expect((await saveDraft(db(), s.H, s.verma.household.id, { templateId: hi.id })).draftText).toBe("सुंदर उपहार के लिए धन्यवाद।");
  });

  it("is Hosts / full access only", async () => {
    const s = await setup();
    const rec = await makeUser("rec@example.com");
    await db().insert(eventMembers).values({ eventId: s.event.id, userId: rec.id, role: "planner", giftAccess: "record" });
    const R: GiftCtx = { eventId: s.event.id, actor: actorOf(rec), subject: { isAppAdmin: false, membership: { role: "planner", giftAccess: "record" } } };
    await expect(listTracker(db(), R)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveTemplate(db(), R, null, { locale: "en", name: "x", body: "x" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("sending (GFT-08/09)", () => {
  it("bulk send only sends drafted rows, once, and marks them sent", async () => {
    const s = await setup();
    const tpl = await saveTemplate(db(), s.H, null, { locale: "en", name: "Short", body: "Dear {guestName}, thank you! {coupleNames}" });
    expect(await draftMany(db(), s.H, tpl.id, [s.sharma.household.id, s.nocontact.household.id])).toBe(2);
    await setStatus(db(), s.H, s.verma.household.id, "not_needed");
    const rows = await db().select().from(thankYous).where(eq(thankYous.eventId, s.event.id));
    const ids = rows.map((r) => r.id);
    const est = await estimateSend(db(), s.H, ids);
    expect(est.count).toBe(2);
    expect(est.byChannel.email).toBe(1);
    expect(est.skipped.no_address).toBe(1);
    const r = await sendThankYous(db(), s.H, ids, { bulk: true });
    expect(r).toMatchObject({ sent: 1, noAddress: 1, notDrafted: 1 });
    const again = await sendThankYous(db(), s.H, ids, { bulk: true });
    expect(again.sent).toBe(0);
    const out = await db().select().from(outboundMessages).where(eq(outboundMessages.purpose, "thank_you"));
    expect(out).toHaveLength(1);
    expect(out[0].bulk).toBe(true);
    await processOutbox(db());
    const mail = (await db().select().from(devOutbox)).find((m) => m.to === "rajesh@example.com");
    expect(mail?.body).toContain("Dear Sharma family, thank you!");
    const tracker = await listTracker(db(), s.H);
    expect(Object.fromEntries(tracker.map((t) => [t.householdName, t.status]))).toEqual({ Gupta: "drafted", "Sharma family": "sent", Verma: "not_needed" });
    expect(tracker.find((t) => t.householdName === "Sharma family")?.delivery).toBe("sent");
  });

  it("% thanked counts sent over families that need thanks", async () => {
    const s = await setup();
    await setStatus(db(), s.H, s.verma.household.id, "not_needed");
    await setStatus(db(), s.H, s.sharma.household.id, "sent", "printed");
    expect(await thankedStats(db(), s.event.id)).toMatchObject({ total: 3, sent: 1, notNeeded: 1, pct: 50 });
  });
});

describe("reminders (GFT-10)", () => {
  it("weekly from four weeks after the last function while families who gave or came are unthanked", async () => {
    const s = await setup();
    await createGift(db(), s.H, { householdId: s.verma.household.id, type: "cash", amountPaise: 100 });
    await db().insert(checkIns).values({ eventId: s.event.id, functionId: s.sangeet.id, guestId: s.sharma.members[0].id, checkedInAt: new Date(), checkedInBy: s.hostUser.id, source: "manual" });
    expect(await unthankedCount(db(), s.event.id)).toBe(2);
    // Last function 2026-12-10 → reminders on 01-07, 01-14, … (IST).
    expect(await sendThankYouReminders(db(), new Date("2027-01-06T06:00:00Z"))).toBe(0);
    expect(await sendThankYouReminders(db(), new Date("2027-01-07T06:00:00Z"))).toBe(1);
    expect(await sendThankYouReminders(db(), new Date("2027-01-10T06:00:00Z"))).toBe(0);
    expect(await sendThankYouReminders(db(), new Date("2027-01-14T06:00:00Z"))).toBe(1);
    const n = await db().select().from(notifications).where(eq(notifications.kind, "thank_you.reminder"));
    expect(n.map((x) => [x.userId, x.data.count])).toEqual([
      [s.hostUser.id, 2],
      [s.hostUser.id, 2],
    ]);
    await setStatus(db(), s.H, s.verma.household.id, "sent", "in_person");
    await setStatus(db(), s.H, s.sharma.household.id, "not_needed");
    expect(await sendThankYouReminders(db(), new Date("2027-01-21T06:00:00Z"))).toBe(0);
  });
});
