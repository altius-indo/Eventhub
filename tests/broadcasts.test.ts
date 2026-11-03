import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  auditLogs,
  broadcasts,
  devOutbox,
  eventLimitOverrides,
  functionInvites,
  functions,
  guests,
  guestTravel,
  hotels,
  households,
  messageOptOuts,
  outboundMessages,
  roomAssignments,
  roomBlocks,
  rooms,
  rsvps,
} from "@/db/schema";
import {
  broadcastStats,
  createDraft,
  deleteDraft,
  estimateBroadcast,
  householdOptOut,
  makeUnsubscribeToken,
  readUnsubscribeToken,
  resolveSegment,
  sendBroadcast,
  setHouseholdOptOut,
  unsubscribe,
  updateDraft,
  type BroadcastInput,
} from "@/lib/broadcasts";
import { createEvent } from "@/lib/events";
import { makeGuestToken } from "@/lib/guest-links";
import { processOutbox } from "@/lib/outbox";
import { actorOf, db, makeUser, resetDb } from "./helpers";

beforeEach(resetDb);

const APP = "https://app.test";

async function setup() {
  const host = await makeUser("host@example.com", "Asha");
  const ev = await createEvent(db(), actorOf(host), { name: "Wedding" });
  const [mehendi] = await db().insert(functions).values({ eventId: ev.id, name: "Mehendi", date: "2026-12-09" }).returning();
  const [sangeet] = await db().insert(functions).values({ eventId: ev.id, name: "Sangeet", date: "2026-12-10" }).returning();
  const fam = async (name: string, side: "bride" | "groom" | "both", locale = "en") =>
    (await db().insert(households).values({ eventId: ev.id, name, side, locale }).returning())[0];
  const guest = async (householdId: string, name: string, over: Partial<typeof guests.$inferInsert> = {}) =>
    (await db().insert(guests).values({ eventId: ev.id, householdId, name, ...over }).returning())[0];

  // Sharma (bride, Hindi): head with phone + email, adult son with email; VIP; invited to Mehendi, attending; needs pickup; hotel.
  const sharma = await fam("Sharma", "bride", "hi");
  const sHead = await guest(sharma.id, "Mr Sharma", { isHead: true, phone: "+919800000001", email: "sharma@example.com", tags: ["VIP"] });
  const sSon = await guest(sharma.id, "Son Sharma", { email: "son@example.com", sortOrder: 1 });
  await guest(sharma.id, "Little Sharma", { ageGroup: "child", email: "kid@example.com", sortOrder: 2 });
  // Verma (groom): head has no contact; first adult with email gets it. Invited to Sangeet, no reply; self travel.
  const verma = await fam("Verma", "groom");
  const vHead = await guest(verma.id, "Mr Verma", { isHead: true });
  const vAdult = await guest(verma.id, "Mrs Verma", { email: "verma@example.com", sortOrder: 1 });
  // Gupta (both): no contact details at all; no travel.
  const gupta = await fam("Gupta", "both");
  const gHead = await guest(gupta.id, "Mr Gupta", { isHead: true });

  await db().insert(functionInvites).values([
    { functionId: mehendi.id, guestId: sHead.id },
    { functionId: mehendi.id, guestId: sSon.id },
    { functionId: sangeet.id, guestId: vHead.id },
    { functionId: sangeet.id, guestId: vAdult.id },
    { functionId: sangeet.id, guestId: gHead.id },
  ]);
  await db().insert(rsvps).values([
    { functionId: mehendi.id, guestId: sHead.id, status: "attending" },
    { functionId: mehendi.id, guestId: sSon.id, status: "attending" },
    { functionId: sangeet.id, guestId: gHead.id, status: "declined" },
  ]);
  await db().insert(guestTravel).values([
    { guestId: sHead.id, needsPickup: true },
    { guestId: vAdult.id, needsPickup: false },
  ]);
  const [hotel] = await db().insert(hotels).values({ eventId: ev.id, name: "Taj" }).returning();
  const [block] = await db().insert(roomBlocks).values({ eventId: ev.id, hotelId: hotel.id, roomType: "Deluxe", blockedCount: 1, checkIn: "2026-12-08", checkOut: "2026-12-11" }).returning();
  const [room] = await db().insert(rooms).values({ eventId: ev.id, blockId: block.id }).returning();
  await db().insert(roomAssignments).values({ eventId: ev.id, roomId: room.id, guestId: sSon.id, checkIn: "2026-12-08", checkOut: "2026-12-11" });
  return { host, ev, mehendi, sangeet, sharma, verma, gupta, hotel, sHead, vAdult };
}

const input = (over: Partial<BroadcastInput> = {}): BroadcastInput => ({
  title: "Bus timings",
  bodyEn: "Buses leave at 5 pm.",
  bodyHi: "बसें शाम 5 बजे चलेंगी।",
  channels: ["email"],
  segment: {},
  ...over,
});

describe("segments", () => {
  it("filters by side, tag, function, RSVP (incl. pending), travel and hotel", async () => {
    const { ev, mehendi, sangeet, sharma, verma, gupta, hotel } = await setup();
    const r = (s: Parameters<typeof resolveSegment>[2]) => resolveSegment(db(), ev.id, s).then((ids) => ids.sort());
    const sorted = (...ids: string[]) => ids.sort();
    expect(await r({})).toEqual(sorted(sharma.id, verma.id, gupta.id));
    expect(await r({ sides: ["groom", "both"] })).toEqual(sorted(verma.id, gupta.id));
    expect(await r({ tags: ["VIP"] })).toEqual([sharma.id]);
    expect(await r({ functionIds: [sangeet.id] })).toEqual(sorted(verma.id, gupta.id));
    expect(await r({ rsvp: ["pending"] })).toEqual([verma.id]);
    expect(await r({ rsvp: ["attending"], functionIds: [mehendi.id] })).toEqual([sharma.id]);
    expect(await r({ rsvp: ["attending"], functionIds: [sangeet.id] })).toEqual([]);
    expect(await r({ rsvp: ["declined", "pending"], functionIds: [sangeet.id] })).toEqual(sorted(verma.id, gupta.id));
    expect(await r({ travel: ["needs_pickup"] })).toEqual([sharma.id]);
    expect(await r({ travel: ["self"] })).toEqual([verma.id]);
    expect(await r({ travel: ["none"] })).toEqual([gupta.id]);
    expect(await r({ hotelIds: [hotel.id] })).toEqual([sharma.id]);
    expect(await r({ sides: ["bride"], travel: ["none"] })).toEqual([]);
  });

  it("rejects functions or hotels from another event", async () => {
    const { ev, host } = await setup();
    const other = await createEvent(db(), actorOf(host), { name: "Other" });
    const [fn] = await db().insert(functions).values({ eventId: other.id, name: "Haldi" }).returning();
    await expect(createDraft(db(), ev.id, actorOf(host), input({ segment: { functionIds: [fn.id] } }))).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("estimate and sending", () => {
  it("sends one message per family to the head or first adult, and the estimate matches what's queued", async () => {
    const { ev, host } = await setup();
    const b = await createDraft(db(), ev.id, actorOf(host), input());
    const est = await estimateBroadcast(db(), b, APP);
    expect(est.households).toBe(3);
    expect(est.byChannel.email).toBe(2);
    expect(est.skipped.no_address).toBe(1);
    expect(est.overLimit).toEqual([]);
    const res = await sendBroadcast(db(), ev.id, b.id, actorOf(host), APP);
    expect(res.queued).toBe(est.messages);
    const rows = await db().select().from(outboundMessages);
    expect(rows.map((r) => r.toAddress).sort()).toEqual(["sharma@example.com", "verma@example.com"]);
    const [after] = await db().select().from(broadcasts).where(eq(broadcasts.id, b.id));
    expect([after.status, after.recipientCount]).toEqual(["queued", 2]);
    const audits = await db().select().from(auditLogs).where(eq(auditLogs.action, "broadcast.sent"));
    expect(audits).toHaveLength(1);
    // A sent broadcast can't be sent, edited or deleted again.
    await expect(sendBroadcast(db(), ev.id, b.id, actorOf(host), APP)).rejects.toMatchObject({ code: "not_draft" });
    await expect(updateDraft(db(), ev.id, b.id, input())).rejects.toMatchObject({ code: "not_draft" });
    await expect(deleteDraft(db(), ev.id, b.id)).rejects.toMatchObject({ code: "not_draft" });
  });

  it("sends to every adult with allAdults (children excluded)", async () => {
    const { ev, host } = await setup();
    const b = await createDraft(db(), ev.id, actorOf(host), input({ segment: { allAdults: true } }));
    const res = await sendBroadcast(db(), ev.id, b.id, actorOf(host), APP);
    expect(res.queued).toBe(3);
    const rows = await db().select().from(outboundMessages);
    expect(rows.map((r) => r.toAddress).sort()).toEqual(["sharma@example.com", "son@example.com", "verma@example.com"]);
  });

  it("excludes opted-out addresses", async () => {
    const { ev, host } = await setup();
    await db().insert(messageOptOuts).values({ eventId: ev.id, channel: "email", address: "verma@example.com", source: "test" });
    const b = await createDraft(db(), ev.id, actorOf(host), input());
    const est = await estimateBroadcast(db(), b, APP);
    expect(est.skipped.opted_out).toBe(1);
    expect(est.byChannel.email).toBe(1);
    expect((await sendBroadcast(db(), ev.id, b.id, actorOf(host), APP)).queued).toBe(1);
  });

  it("refuses the whole broadcast when over the limit, and leaves it a draft", async () => {
    const { ev, host } = await setup();
    await db().insert(eventLimitOverrides).values({ eventId: ev.id, channel: "email", limit: 1 });
    const b = await createDraft(db(), ev.id, actorOf(host), input());
    expect((await estimateBroadcast(db(), b, APP)).overLimit).toEqual(["email"]);
    await expect(sendBroadcast(db(), ev.id, b.id, actorOf(host), APP)).rejects.toMatchObject({ code: "quota", channel: "email" });
    expect(await db().select().from(outboundMessages)).toHaveLength(0);
    const [after] = await db().select().from(broadcasts).where(eq(broadcasts.id, b.id));
    expect(after.status).toBe("draft");
  });

  it("refuses a broadcast nobody can receive", async () => {
    const { ev, host } = await setup();
    const b = await createDraft(db(), ev.id, actorOf(host), input({ segment: { sides: ["both"] } }));
    await expect(sendBroadcast(db(), ev.id, b.id, actorOf(host), APP)).rejects.toMatchObject({ code: "no_recipients" });
  });

  it("renders Hindi for Hindi families, the family's own link only, and an unsubscribe link for email", async () => {
    const { ev, host, sharma, verma } = await setup();
    const b = await createDraft(db(), ev.id, actorOf(host), input());
    await sendBroadcast(db(), ev.id, b.id, actorOf(host), APP);
    await processOutbox(db());
    const sent = await db().select().from(devOutbox);
    const toSharma = sent.find((m) => m.to === "sharma@example.com")!;
    const toVerma = sent.find((m) => m.to === "verma@example.com")!;
    expect(toSharma.body).toContain("बसें शाम 5 बजे चलेंगी।");
    expect(toVerma.body).toContain("Buses leave at 5 pm.");
    const sharmaLink = `${APP}/g/${makeGuestToken(sharma.id, sharma.linkVersion)}`;
    const vermaLink = `${APP}/g/${makeGuestToken(verma.id, verma.linkVersion)}`;
    expect(toSharma.body).toContain(sharmaLink);
    expect(toSharma.body).not.toContain(vermaLink);
    expect(toVerma.body).toContain(vermaLink);
    expect(toVerma.body).not.toContain(sharmaLink);
    expect(toVerma.body).toMatch(new RegExp(`${APP}/u/[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{32}`));
    // Links are rendered at send time, never stored.
    const stored = await db().select().from(outboundMessages);
    expect(JSON.stringify(stored)).not.toContain("/g/");
    const stats = await broadcastStats(db(), ev.id, b.id);
    expect(stats.email.sent).toBe(2);
  });
});

describe("staff opt-out for WhatsApp/SMS (DPDP)", () => {
  it("WhatsApp/SMS broadcasts say how to stop; staff can stop and restart a family, audited", async () => {
    const { ev, host, sharma } = await setup();
    const b = await createDraft(db(), ev.id, actorOf(host), input({ channels: ["sms"], segment: { sides: ["bride"] } }));
    await sendBroadcast(db(), ev.id, b.id, actorOf(host), APP);
    await processOutbox(db());
    const [sms] = (await db().select().from(devOutbox)).filter((m) => m.to === "+919800000001");
    expect(sms.body).toContain("STOP लिखकर जवाब दें");

    expect((await householdOptOut(db(), ev.id, sharma.id)).optedOut).toBe(false);
    await setHouseholdOptOut(db(), { eventId: ev.id, householdId: sharma.id, actor: actorOf(host), optedOut: true });
    const st = await householdOptOut(db(), ev.id, sharma.id);
    expect(st.optedOut).toBe(true);
    expect(st.channels.sort()).toEqual(["email", "sms", "whatsapp"]);
    const b2 = await createDraft(db(), ev.id, actorOf(host), input({ channels: ["sms", "email"], segment: { sides: ["bride"] } }));
    await expect(sendBroadcast(db(), ev.id, b2.id, actorOf(host), APP)).rejects.toMatchObject({ code: "no_recipients" });

    await setHouseholdOptOut(db(), { eventId: ev.id, householdId: sharma.id, actor: actorOf(host), optedOut: false });
    expect((await householdOptOut(db(), ev.id, sharma.id)).optedOut).toBe(false);
    const actions = (await db().select().from(auditLogs).where(eq(auditLogs.eventId, ev.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["household.broadcasts_stopped", "household.broadcasts_resumed"]));
    // Another event's family can't be touched.
    const other = await createEvent(db(), actorOf(host), { name: "Other" });
    await expect(setHouseholdOptOut(db(), { eventId: other.id, householdId: sharma.id, actor: actorOf(host), optedOut: true })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("unsubscribe links", () => {
  it("opts out with a valid token; invalid tokens do nothing and look the same", async () => {
    const { ev } = await setup();
    const token = makeUnsubscribeToken(ev.id, "email", "Verma@Example.com");
    expect(readUnsubscribeToken(token)).toEqual({ eventId: ev.id, channel: "email", address: "verma@example.com" });
    const tampered = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    expect(readUnsubscribeToken(tampered)).toBeNull();
    expect(readUnsubscribeToken("garbage")).toBeNull();
    const forged = `${Buffer.from(`${ev.id}|email|someone@example.com`).toString("base64url")}.${"A".repeat(32)}`;
    await expect(unsubscribe(db(), forged)).resolves.toBeUndefined();
    await expect(unsubscribe(db(), "garbage")).resolves.toBeUndefined();
    expect(await db().select().from(messageOptOuts)).toHaveLength(0);
    await expect(unsubscribe(db(), token)).resolves.toBeUndefined();
    const rows = await db().select().from(messageOptOuts);
    expect(rows.map((r) => [r.address, r.source])).toEqual([["verma@example.com", "unsubscribe_link"]]);
  });
});
