import { eq } from "drizzle-orm";
import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import { events, households } from "@/db/schema";
import { createEvent } from "@/lib/events";
import { createFunction } from "@/lib/functions";
import { guestLinkUrl, makeGuestToken, regenerateGuestLink, resolveGuestToken, revokeGuestLink, whatsappShareUrl } from "@/lib/guest-links";
import { createHousehold, guestSchema, listGuests } from "@/lib/guests";
import { addPlusOne, getPortalData, headcounts, removePlusOne, RsvpError, rsvpOpen, saveRsvps, sendRsvpReminders } from "@/lib/rsvp";
import { saveTravel, travelFor, travelSchema } from "@/lib/travel";
import {
  allowAttempt,
  checkPasscode,
  defaultContent,
  findHouseholdByContact,
  getOrCreateWebsite,
  getSiteBySlug,
  isValidSlug,
  pick,
  publish,
  saveDraft,
  saveSiteImage,
  setSlug,
  setVisibility,
  siteContentSchema,
  slugify,
  WebsiteError,
} from "@/lib/website";
import { actorOf, db, makeUser, outbox, resetDb } from "./helpers";

beforeEach(resetDb);

const blank = { startTime: null, endTime: null, venueName: null, venueAddress: null, mapUrl: null, dressCode: null, description: null };

async function setup() {
  const host = await makeUser("host@example.com", "Asha");
  const actor = actorOf(host);
  const event = await createEvent(db(), actor, { name: "Priya & Arjun's Wedding", coupleNames: "Priya & Arjun", startDate: "2026-12-10" });
  const mehendi = await createFunction(db(), event.id, actor, { name: "Mehendi", date: "2026-12-10", ...blank });
  const wedding = await createFunction(db(), event.id, actor, { name: "Wedding", date: "2026-12-11", ...blank });
  const { household, members } = await createHousehold(db(), event.id, actor, {
    household: { name: "Sharma family", side: "bride", address: null, city: null, postalCode: null, notes: null },
    members: [guestSchema.parse({ name: "Rajesh", phone: "9876543210" }), guestSchema.parse({ name: "Sunita", ageGroup: "adult" })],
    functionIds: [mehendi.id, wedding.id],
  });
  const [ev] = await db().select().from(events).where(eq(events.id, event.id));
  return { host, actor, event: ev, mehendi, wedding, household, members };
}

describe("guest links", () => {
  it("resolves valid links and rejects tampered, regenerated or revoked ones", async () => {
    const { event, household } = await setup();
    const token = makeGuestToken(household.id, household.linkVersion);
    expect(token).toHaveLength(44);
    expect((await resolveGuestToken(db(), token))?.household.id).toBe(household.id);
    expect(await resolveGuestToken(db(), token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(await resolveGuestToken(db(), "short")).toBeNull();

    const next = await regenerateGuestLink(db(), event.id, household.id);
    expect(await resolveGuestToken(db(), token)).toBeNull();
    const fresh = makeGuestToken(household.id, next!.linkVersion);
    expect(await resolveGuestToken(db(), fresh)).not.toBeNull();

    await revokeGuestLink(db(), event.id, household.id);
    expect(await resolveGuestToken(db(), fresh)).toBeNull();
    expect(guestLinkUrl("https://x.test", next!)).toBe(`https://x.test/g/${fresh}`);
    expect(whatsappShareUrl("+91 98765 43210", "hi there")).toBe("https://wa.me/919876543210?text=hi%20there");
  });
});

describe("RSVP", () => {
  it("saves answers per person and function and rejects uninvited pairs", async () => {
    const { event, household, members, mehendi, wedding } = await setup();
    await saveRsvps(db(), {
      household,
      event,
      recordedBy: null,
      answers: [
        { guestId: members[0].id, functionId: mehendi.id, status: "attending" },
        { guestId: members[0].id, functionId: wedding.id, status: "maybe" },
        { guestId: members[1].id, functionId: mehendi.id, status: "declined" },
      ],
      diets: [{ guestId: members[0].id, diet: "jain", dietNotes: "No onion, garlic" }],
    });
    const portal = await getPortalData(db(), household);
    expect(portal.members[0].rsvp).toEqual({ [mehendi.id]: "attending", [wedding.id]: "maybe" });
    expect(portal.members[0].diet).toBe("jain");
    expect(portal.functions.map((f) => f.name)).toEqual(["Mehendi", "Wedding"]);

    const other = await createFunction(db(), event.id, actorOf(await makeUser("x@example.com")), { name: "Haldi", date: null, ...blank });
    await expect(
      saveRsvps(db(), { household, event, recordedBy: null, answers: [{ guestId: members[0].id, functionId: other.id, status: "attending" }] }),
    ).rejects.toMatchObject({ code: "not_invited" });

    // clearing an answer
    await saveRsvps(db(), { household, event, recordedBy: null, answers: [{ guestId: members[0].id, functionId: wedding.id, status: null }] });
    expect((await getPortalData(db(), household)).members[0].rsvp).toEqual({ [mehendi.id]: "attending" });
  });

  it("closes for guests after the deadline but not for the team", async () => {
    const { host, event, household, members, mehendi } = await setup();
    await db().update(events).set({ rsvpDeadline: "2026-11-20" }).where(eq(events.id, event.id));
    const ev = { ...event, rsvpDeadline: "2026-11-20" };
    expect(rsvpOpen(ev, new Date("2026-11-20T18:00:00Z"))).toBe(true); // 23:30 IST
    expect(rsvpOpen(ev, new Date("2026-11-20T18:31:00Z"))).toBe(false); // 00:01 IST next day
    const answers = [{ guestId: members[0].id, functionId: mehendi.id, status: "attending" as const }];
    await expect(saveRsvps(db(), { household, event: ev, recordedBy: null, answers, now: new Date("2026-11-22T00:00:00Z") })).rejects.toBeInstanceOf(RsvpError);
    expect(await saveRsvps(db(), { household, event: ev, recordedBy: actorOf(host), answers, now: new Date("2026-11-22T00:00:00Z") })).toBe(1);
  });

  it("lets families add +1s within their allowance, inheriting invites and answers", async () => {
    const { event, household, members, mehendi, wedding } = await setup();
    await expect(addPlusOne(db(), { household, event, name: "Guest", ageGroup: "adult", invitedWithId: members[0].id, byGuest: true })).rejects.toMatchObject({
      code: "no_allowance",
    });
    await db().update(households).set({ plusOnesAllowed: 1 }).where(eq(households.id, household.id));
    await saveRsvps(db(), { household, event, recordedBy: null, answers: [{ guestId: members[0].id, functionId: mehendi.id, status: "attending" }] });
    const kid = await addPlusOne(db(), { household, event, name: "Anya", ageGroup: "child", invitedWithId: members[0].id, byGuest: true });
    const portal = await getPortalData(db(), household);
    const anya = portal.members.find((m) => m.id === kid.id)!;
    expect(anya.functionIds.sort()).toEqual([mehendi.id, wedding.id].sort());
    expect(anya.rsvp).toEqual({ [mehendi.id]: "attending" });
    expect(portal.plusOnesUsed).toBe(1);
    await expect(addPlusOne(db(), { household, event, name: "More", ageGroup: "adult", invitedWithId: members[0].id, byGuest: true })).rejects.toMatchObject({
      code: "no_allowance",
    });
    await expect(removePlusOne(db(), { household, event, guestId: members[1].id, byGuest: true })).rejects.toBeInstanceOf(RsvpError);
    await removePlusOne(db(), { household, event, guestId: kid.id, byGuest: true });
  });

  it("counts headcount by status, side, age and food, and filters the guest list", async () => {
    const { actor, event, household, members, mehendi, wedding } = await setup();
    const { household: h2, members: m2 } = await createHousehold(db(), event.id, actor, {
      household: { name: "Verma", side: "groom", address: null, city: null, postalCode: null, notes: null },
      members: [guestSchema.parse({ name: "Anil", diet: "non_veg" }), guestSchema.parse({ name: "Kabir", ageGroup: "child", dietNotes: "nut allergy" })],
      functionIds: [mehendi.id],
    });
    await saveRsvps(db(), {
      household, event, recordedBy: null,
      answers: [
        { guestId: members[0].id, functionId: mehendi.id, status: "attending" },
        { guestId: members[1].id, functionId: mehendi.id, status: "declined" },
      ],
    });
    await saveRsvps(db(), {
      household: h2, event, recordedBy: null,
      answers: [
        { guestId: m2[0].id, functionId: mehendi.id, status: "attending" },
        { guestId: m2[1].id, functionId: mehendi.id, status: "attending" },
      ],
    });
    const hc = (await headcounts(db(), event.id)).get(mehendi.id)!;
    expect(hc).toMatchObject({ invited: 4, attending: 3, declined: 1, maybe: 0, pending: 0, households: { invited: 2, responded: 2 } });
    expect(hc.attendingBy.side).toEqual({ bride: 1, groom: 2, both: 0 });
    expect(hc.attendingBy.age).toEqual({ adult: 2, child: 1, infant: 0 });
    expect(hc.attendingBy.diet).toMatchObject({ non_veg: 1, unknown: 2 });
    expect(hc.attendingBy.allergies).toBe(1);
    expect((await headcounts(db(), event.id)).get(wedding.id)).toMatchObject({ invited: 2, pending: 2 });

    const names = async (f: Record<string, string>) => (await listGuests(db(), event.id, f)).households.flatMap((h) => h.members.map((m) => m.name)).sort();
    expect(await names({ fn: mehendi.id, rsvp: "attending" })).toEqual(["Anil", "Kabir", "Rajesh"]);
    expect(await names({ fn: mehendi.id, rsvp: "declined" })).toEqual(["Sunita"]);
    expect(await names({ rsvp: "pending" })).toEqual(["Rajesh", "Sunita"]);

    await saveTravel(db(), members[0].id, travelSchema.parse({ arrivalMode: "flight", arrivalNumber: "6E 203", arrivalAt: "2026-12-09T14:30", needsPickup: true }), true);
    expect(await names({ travel: "pickup" })).toEqual(["Rajesh"]);
    expect(await names({ travel: "missing" })).toEqual(["Anil", "Kabir", "Sunita"]);
  });

  it("reminds families who haven't replied when the deadline is near, every 3 days", async () => {
    const { event, household, members, mehendi, wedding } = await setup();
    await db().update(events).set({ rsvpDeadline: "2026-11-20" }).where(eq(events.id, event.id));
    const now = new Date("2026-11-10T04:00:00Z");
    expect(await sendRsvpReminders(db(), "https://app.test", now)).toBe(1);
    const msg = (await outbox()).at(-1)!;
    expect(msg).toMatchObject({ channel: "sms", to: "+919876543210" });
    expect(msg.body).toContain("https://app.test/g/");
    expect(await sendRsvpReminders(db(), "https://app.test", new Date("2026-11-12T04:00:00Z"))).toBe(0);
    // Once everyone has replied, no more reminders
    await saveRsvps(db(), {
      household, event: { ...event, rsvpDeadline: "2026-11-20" }, recordedBy: null, now,
      answers: members.flatMap((m) => [mehendi, wedding].map((f) => ({ guestId: m.id, functionId: f.id, status: "attending" as const }))),
    });
    expect(await sendRsvpReminders(db(), "https://app.test", new Date("2026-11-14T04:00:00Z"))).toBe(0);
  });
});

describe("travel", () => {
  it("validates and stores wall-clock times", async () => {
    const { members } = await setup();
    expect(travelSchema.safeParse({ arrivalAt: "2026-12-09T14:30", departureAt: "2026-12-08T10:00" }).success).toBe(false);
    await saveTravel(db(), members[0].id, travelSchema.parse({ arrivalMode: "train", arrivalAt: "2026-12-09T06:15", arrivalPoint: "Jaipur Jn" }), true);
    const t = (await travelFor(db(), [members[0].id])).get(members[0].id)!;
    expect(t.arrivalAt?.toISOString()).toBe("2026-12-09T06:15:00.000Z");
    expect(t).toMatchObject({ arrivalMode: "train", arrivalPoint: "Jaipur Jn", updatedByGuest: true });
  });
});

describe("website", () => {
  it("makes friendly, unique, non-reserved slugs", async () => {
    expect(slugify("Priya & Arjun")).toBe("priya-weds-arjun");
    expect(slugify("  Zoë   Café!! ")).toBe("zoe-cafe");
    expect(isValidSlug("events")).toBe(false);
    expect(isValidSlug("ab")).toBe(false);
    expect(isValidSlug("priya-weds-arjun")).toBe(true);

    const { host, event } = await setup();
    const site = await getOrCreateWebsite(db(), event);
    expect(site.slug).toBe("priya-weds-arjun");
    const other = await createEvent(db(), actorOf(host), { name: "Other", coupleNames: "Priya & Arjun" });
    expect((await getOrCreateWebsite(db(), other)).slug).toBe("priya-weds-arjun-2");
    await expect(setSlug(db(), other.id, "priya-weds-arjun")).rejects.toMatchObject({ code: "slug_taken" });
    await expect(setSlug(db(), other.id, "admin")).rejects.toMatchObject({ code: "slug_invalid" });
  });

  it("validates content, publishes the draft and checks passcodes", async () => {
    const { host, event } = await setup();
    let site = await getOrCreateWebsite(db(), event);
    const content = defaultContent(event);
    expect(content.monogram).toBe("P & A");
    content.sections.story.visible = true;
    content.sections.story.body = { en: "We met in college.", hi: "" };
    await saveDraft(db(), event.id, content);
    expect(() => siteContentSchema.parse({ ...content, accent: "#000000" })).toThrow();

    site = (await getSiteBySlug(db(), site.slug))!.website;
    expect(site.published).toBeNull();
    await publish(db(), site, actorOf(host));
    site = (await getSiteBySlug(db(), site.slug))!.website;
    expect(site.published?.sections.story.body.en).toBe("We met in college.");
    expect(pick(site.published!.sections.story.body, "hi")).toBe("We met in college."); // falls back to English

    await expect(setVisibility(db(), site, "passcode")).rejects.toBeInstanceOf(WebsiteError);
    await setVisibility(db(), site, "passcode", "Shaadi2026");
    site = (await getSiteBySlug(db(), site.slug))!.website;
    expect(checkPasscode(site, "shaadi2026 ")).toBe(true);
    expect(checkPasscode(site, "wrong")).toBe(false);
  });

  it("stores uploaded images as resized WebP and rejects non-images", async () => {
    const { event } = await setup();
    const jpg = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#c33" } }).jpeg().toBuffer();
    const id = await saveSiteImage(db(), event.id, jpg.buffer.slice(jpg.byteOffset, jpg.byteOffset + jpg.byteLength) as ArrayBuffer);
    const { siteImages } = await import("@/db/schema");
    const [img] = await db().select().from(siteImages).where(eq(siteImages.id, id));
    expect(img).toMatchObject({ mime: "image/webp", width: 1800, height: 1200 });
    await expect(saveSiteImage(db(), event.id, new TextEncoder().encode("<svg/>").buffer as ArrayBuffer)).rejects.toMatchObject({ code: "image_invalid" });
  });

  it("rate-limits attempts and finds families by phone or email", async () => {
    const { event, household } = await setup();
    for (let i = 0; i < 3; i++) expect(await allowAttempt(db(), "find", "1.2.3.4", 3, 60_000)).toBe(true);
    expect(await allowAttempt(db(), "find", "1.2.3.4", 3, 60_000)).toBe(false);
    expect(await allowAttempt(db(), "find", "5.6.7.8", 3, 60_000)).toBe(true);
    expect((await findHouseholdByContact(db(), event.id, "+91 98765-43210"))?.household.id).toBe(household.id);
    expect(await findHouseholdByContact(db(), event.id, "11111")).toBeNull();
    await revokeGuestLink(db(), event.id, household.id);
    expect(await findHouseholdByContact(db(), event.id, "9876543210")).toBeNull();
  });
});
