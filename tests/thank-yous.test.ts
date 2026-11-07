import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { checkIns, devOutbox, eventMembers, notifications, outboundMessages, thankYous } from "@/db/schema";
import { createEvent } from "@/lib/events";
import { createFunction } from "@/lib/functions";
import type { GiftCtx } from "@/lib/gifts";
import { createHousehold, guestSchema } from "@/lib/guests";
import { processOutbox } from "@/lib/outbox";
import { ForbiddenError } from "@/lib/policy";
import {
  containsAmount,
  deliveryFailed,
  draftMany,
  resendThankYou,
  estimateSend,
  listTracker,
  renderNote,
  saveDraft,
  saveTemplate,
  sendThankYous,
  sendThankYouReminders,
  setStatus,
  thankedStats,
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
    expect(() => validateTemplate("Dear {guestName}, thank you for coming to {functionsAttended}. Love, {coupleNames}")).not.toThrow();
    // Older templates may still say {giftItem} (ADR-0036); other unknown fields are refused.
    expect(() => validateTemplate("Thank you for the {giftItem}")).not.toThrow();
    expect(() => validateTemplate("Thank you for the {giftAmount}")).toThrow(ThankYouError);
    expect(() => validateTemplate("Thanks for {amount}")).toThrow(ThankYouError);
    expect(() => validateTemplate("Thanks for the ₹5,100 shagun")).toThrow(ThankYouError);
    expect(() => validateTemplate("Thanks for Rs. 1100")).toThrow(ThankYouError);
    expect(() => validateTemplate("धन्यवाद 1100 रुपये के लिए")).toThrow(ThankYouError);
    expect(containsAmount("See you on 12 December")).toBe(false);
  });

  it("never renders an amount, and old templates with {giftItem} render without it", async () => {
    const s = await setup();
    const tpl = await saveTemplate(db(), s.H, null, { locale: "en", name: "Warm", body: "Dear {guestName}, thank you for coming. {personalLine} — {coupleNames}" });
    const ty = await saveDraft(db(), s.H, s.sharma.household.id, { templateId: tpl.id, personalLine: "Loved the ₹ 5,100 dance." });
    expect(ty.status).toBe("drafted");
    expect(ty.draftText).toContain("Priya & Arjun");
    expect(ty.draftText).not.toMatch(/5100|5,100|₹/);
    expect(renderNote("{guestName} {amount}", { guestName: "A", coupleNames: "", functionsAttended: "", personalLine: "" })).toBe("A");
    expect(renderNote("Thanks for the {giftItem}, {guestName}.", { guestName: "Verma", coupleNames: "", functionsAttended: "", personalLine: "" }, "gift")).toBe("Thanks for the gift, Verma.");
    await expect(saveDraft(db(), s.H, s.sharma.household.id, { text: "Thank you for ₹5,100!" })).rejects.toMatchObject({ code: "contains_amount" });
  });

  it("old templates with {giftItem} still save and draft, with the word for gift in their language", async () => {
    const s = await setup();
    const en = await saveTemplate(db(), s.H, null, { locale: "en", name: "E", body: "Thanks for the lovely {giftItem}." });
    const hi = await saveTemplate(db(), s.H, null, { locale: "hi", name: "H", body: "सुंदर {giftItem} के लिए धन्यवाद।" });
    // Re-saving an old template works too.
    await expect(saveTemplate(db(), s.H, en.id, { locale: "en", name: "E", body: en.body })).resolves.toBeTruthy();
    expect((await saveDraft(db(), s.H, s.verma.household.id, { templateId: en.id })).draftText).toBe("Thanks for the lovely gift.");
    expect((await saveDraft(db(), s.H, s.verma.household.id, { templateId: hi.id })).draftText).toBe("सुंदर उपहार के लिए धन्यवाद।");
  });

  it("lists every family of the event; attended means a member was checked in", async () => {
    const s = await setup();
    await db().insert(checkIns).values({ eventId: s.event.id, functionId: s.sangeet.id, guestId: s.sharma.members[0].id, checkedInAt: new Date(), checkedInBy: s.hostUser.id, source: "manual" });
    const all = await listTracker(db(), s.H);
    expect(all.map((r) => [r.householdName, r.attended])).toEqual([
      ["Gupta", false],
      ["Sharma family", true],
      ["Verma", false],
    ]);
    expect((await listTracker(db(), s.H, { attended: "yes" })).map((r) => r.householdName)).toEqual(["Sharma family"]);
  });

  it("is for Hosts and Planners, not outsiders (GFT-07)", async () => {
    const s = await setup();
    const planner = await makeUser("planner@example.com");
    await db().insert(eventMembers).values({ eventId: s.event.id, userId: planner.id, role: "planner" });
    const P: GiftCtx = { eventId: s.event.id, actor: actorOf(planner), subject: { isAppAdmin: false, membership: { role: "planner", giftAccess: "none" } } };
    expect(await listTracker(db(), P)).toHaveLength(3);
    await expect(saveTemplate(db(), P, null, { locale: "en", name: "x", body: "x" })).resolves.toBeTruthy();
    const O: GiftCtx = { eventId: s.event.id, actor: actorOf(planner), subject: { isAppAdmin: false, membership: null } };
    await expect(listTracker(db(), O)).rejects.toBeInstanceOf(ForbiddenError);
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

  it("sends the note as it was when sent; a sent note can't be redrafted", async () => {
    const s = await setup();
    await saveDraft(db(), s.H, s.sharma.household.id, { text: "Original note" });
    const [row] = await db().select().from(thankYous).where(eq(thankYous.householdId, s.sharma.household.id));
    await sendThankYous(db(), s.H, [row.id], { bulk: false });
    await expect(saveDraft(db(), s.H, s.sharma.household.id, { text: "Changed note" })).rejects.toMatchObject({ code: "already_sent" });
    // Even if the stored text changes before the queue drains, the snapshot goes out.
    await db().update(thankYous).set({ draftText: "Changed behind the queue" }).where(eq(thankYous.id, row.id));
    await processOutbox(db());
    const mail = (await db().select().from(devOutbox)).find((m) => m.to === "rajesh@example.com");
    expect(mail?.body).toBe("Original note");
  });

  it("shows a note that failed on every channel and lets the team send it again", async () => {
    const s = await setup();
    await saveDraft(db(), s.H, s.sharma.household.id, { text: "Thank you!" });
    const [row] = await db().select().from(thankYous).where(eq(thankYous.householdId, s.sharma.household.id));
    await sendThankYous(db(), s.H, [row.id], { bulk: false });
    await expect(resendThankYou(db(), s.H, s.sharma.household.id)).rejects.toMatchObject({ code: "not_failed" });
    // The only channel (email) gave up after its retries.
    await db().update(outboundMessages).set({ status: "failed", errorCode: "bounced" }).where(eq(outboundMessages.thankYouId, row.id));
    const tracker = await listTracker(db(), s.H);
    const sharma = tracker.find((t) => t.householdName === "Sharma family")!;
    expect([sharma.status, sharma.delivery, deliveryFailed(sharma.delivery)]).toEqual(["sent", "failed", true]);
    const r = await resendThankYou(db(), s.H, s.sharma.household.id);
    expect(r.sent).toBe(1);
    await processOutbox(db());
    const tracker2 = await listTracker(db(), s.H);
    expect(tracker2.find((t) => t.householdName === "Sharma family")?.delivery).toBe("sent");
    expect((await db().select().from(devOutbox)).filter((m) => m.to === "rajesh@example.com")).toHaveLength(1);
  });

  it("% thanked counts sent over families that need thanks", async () => {
    const s = await setup();
    await setStatus(db(), s.H, s.verma.household.id, "not_needed");
    await setStatus(db(), s.H, s.sharma.household.id, "sent", "printed");
    expect(await thankedStats(db(), s.event.id)).toMatchObject({ total: 3, sent: 1, notNeeded: 1, pct: 50 });
  });
});

describe("reminders (GFT-10)", () => {
  it("weekly from four weeks after the last function while families who came are unthanked", async () => {
    const s = await setup();
    const mehendi = await createFunction(db(), s.event.id, actorOf(s.hostUser), { name: "Mehendi", date: "2026-12-09", ...blank });
    await db().insert(checkIns).values({ eventId: s.event.id, functionId: s.sangeet.id, guestId: s.sharma.members[0].id, checkedInAt: new Date(), checkedInBy: s.hostUser.id, source: "manual" });
    await db().insert(checkIns).values({ eventId: s.event.id, functionId: mehendi.id, guestId: s.verma.members[0].id, checkedInAt: new Date(), checkedInBy: s.hostUser.id, source: "manual" });
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
