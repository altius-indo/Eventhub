import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, like } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditLogs,
  documents,
  eventMetrics,
  events,
  guestErasureRequests,
  households,
  notifications,
  outboundMessages,
  retentionNotices,
  storageDeletions,
  vendorContacts,
} from "@/db/schema";
import { createTranslator } from "@/i18n/core";
import { partEntries, registerArchivePart, zipStream, type ArchiveContext } from "@/lib/archive";
import { saveDocument } from "@/lib/documents";
import { createEvent, purgeDeletedEvents, softDeleteEvent } from "@/lib/events";
import { createFunction } from "@/lib/functions";
import { createGift } from "@/lib/gifts";
import { createHousehold, guestSchema } from "@/lib/guests";
import { decide } from "@/lib/policy";
import {
  addOneYear,
  deletionDateFor,
  getRetention,
  listErasureRequests,
  processErasureRequest,
  purgeExpiredEvents,
  recordErasureRequest,
  retentionFor,
  sendRetentionReminders,
} from "@/lib/retention";
import { FsStore, setStoreForTests } from "@/lib/storage";
import { processStorageDeletions } from "@/lib/storage-gc";
import { createVendor } from "@/lib/vendors";
import { actorOf, db, makeUser, resetDb } from "./helpers";

let root: string;
let store: FsStore;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "eh-retention-"));
  store = new FsStore(root);
  setStoreForTests(store);
});
afterAll(async () => {
  setStoreForTests(null);
  await rm(root, { recursive: true, force: true });
});
beforeEach(resetDb);

const blank = { startTime: null, endTime: null, venueName: null, venueAddress: null, mapUrl: null, dressCode: null, description: null };
const PDF = Buffer.from("%PDF-1.7 contract body for the archive");
/** 06:00 IST on a given day. */
const ist = (d: string) => new Date(`${d}T00:30:00Z`);

async function setup(opts: { lastFunction?: string } = {}) {
  const host = await makeUser("host@example.com", "Asha");
  const actor = actorOf(host);
  const event = await createEvent(db(), actor, { name: "Priya weds Arjun", coupleNames: "Priya & Arjun" });
  await createFunction(db(), event.id, actor, { name: "Sangeet", date: "2026-12-10", ...blank });
  await createFunction(db(), event.id, actor, { name: "Wedding", date: opts.lastFunction ?? "2026-12-11", ...blank });
  const { household } = await createHousehold(db(), event.id, actor, {
    household: { name: "Sharma family", side: "bride", address: null, city: null, postalCode: null, notes: null },
    members: [guestSchema.parse({ name: "Rajesh Sharma", phone: "9876543210" })],
  });
  const vendor = await createVendor(db(), event.id, actor, { name: "Annapurna Caterers", contactName: null, phone: null, email: null, gstin: null, notes: null, serviceTypeIds: [] });
  return { host, actor, event, household, vendor };
}

describe("deletion date (EVT-07)", () => {
  it("is one year after the last function, else the end date, else never", () => {
    expect(addOneYear("2026-12-11")).toBe("2027-12-11");
    expect(addOneYear("2028-02-29")).toBe("2029-03-01");
    expect(deletionDateFor("2026-12-11", "2026-12-20")).toBe("2027-12-11");
    expect(deletionDateFor(null, "2026-12-20")).toBe("2027-12-20");
    expect(deletionDateFor(null, null)).toBeNull();
  });

  it("starts the banner when the last function's day is over in the event's timezone", () => {
    const ev = { endDate: null, timezone: "Asia/Kolkata" };
    // 19:00 UTC on 11 Dec is already 12 Dec 00:30 in India.
    const late = new Date("2026-12-11T19:00:00Z");
    expect(retentionFor(ev, "2026-12-11", late)).toMatchObject({ started: true, deletionDate: "2027-12-11", daysLeft: 364 });
    expect(retentionFor({ ...ev, timezone: "UTC" }, "2026-12-11", late)).toMatchObject({ started: false, daysLeft: 365 });
    expect(retentionFor(ev, null, late)).toEqual({ clockDate: null, deletionDate: null, started: false, daysLeft: null });
  });

  it("uses the latest function", async () => {
    const { event } = await setup();
    expect((await getRetention(db(), event)).deletionDate).toBe("2027-12-11");
  });
});

describe("retention reminders (EVT-08)", () => {
  it("reminds Hosts and vendors at 60, 30 and 7 days, once each", async () => {
    const { event, vendor } = await setup();
    const chef = await makeUser("chef@example.com", "Chef");
    await db().insert(vendorContacts).values({ eventId: event.id, vendorId: vendor.id, identifierType: "email", identifierValue: "chef@example.com", userId: chef.id, acceptedAt: new Date() });
    // Deletion on 2027-12-11.
    expect(await sendRetentionReminders(db(), ist("2027-10-11"))).toBe(0); // 61 days
    expect(await sendRetentionReminders(db(), ist("2027-10-12"))).toBe(1); // 60 days
    expect(await sendRetentionReminders(db(), ist("2027-10-12"))).toBe(0);
    expect(await sendRetentionReminders(db(), ist("2027-10-30"))).toBe(0);
    expect(await sendRetentionReminders(db(), ist("2027-11-11"))).toBe(1); // 30 days
    // The job missed the 7-day mark; it still goes out once.
    expect(await sendRetentionReminders(db(), ist("2027-12-06"))).toBe(1);
    expect(await sendRetentionReminders(db(), ist("2027-12-07"))).toBe(0);
    const hostNotes = await db().select().from(notifications).where(eq(notifications.kind, "retention.reminder"));
    expect(hostNotes.map((n) => n.data?.days)).toEqual([60, 30, 5]);
    expect(hostNotes[0].href).toBe(`/events/${event.id}/settings#data`);
    expect(await db().select().from(notifications).where(eq(notifications.kind, "vendor.retention"))).toHaveLength(3);
    const mails = await db().select().from(outboundMessages).where(like(outboundMessages.idempotencyKey, `retention:${event.id}:%`));
    expect(mails.filter((m) => m.toAddress === "host@example.com")).toHaveLength(3);
    expect(mails.filter((m) => m.toAddress === "chef@example.com")).toHaveLength(3);
    expect(String(mails.find((m) => m.toAddress === "chef@example.com")!.vars.text)).toContain("invoices");
  });

  it("sends only the nearest reminder when the clock started late, and restarts when the date moves", async () => {
    const { event, actor } = await setup();
    // 20 days before deletion: the 60-day reminder is skipped, the 30-day one goes.
    expect(await sendRetentionReminders(db(), ist("2027-11-21"))).toBe(1);
    expect((await db().select().from(retentionNotices)).map((r) => r.days).sort()).toEqual([30, 60]);
    expect(await sendRetentionReminders(db(), ist("2027-11-22"))).toBe(0);
    // A function is added later: deletion moves to 2028-01-20, so reminders start again.
    await createFunction(db(), event.id, actor, { name: "Reception", date: "2027-01-20", ...blank });
    expect(await sendRetentionReminders(db(), ist("2027-11-22"))).toBe(1); // 59 days → the 60-day one
  });

  it("never reminds or deletes events without dates", async () => {
    const host = await makeUser("host@example.com");
    const event = await createEvent(db(), actorOf(host), { name: "Undated" });
    expect(await sendRetentionReminders(db(), ist("2040-01-01"))).toBe(0);
    expect(await purgeExpiredEvents(db(), ist("2040-01-01"))).toBe(0);
    expect(await db().select().from(events).where(eq(events.id, event.id))).toHaveLength(1);
  });
});

describe("purge (EVT-07)", () => {
  it("keeps anonymised counts, queues storage and deletes everything on the deletion date", async () => {
    const { event, actor, vendor } = await setup();
    const doc = await saveDocument(db(), event.id, actor, { owner: { vendorId: vendor.id }, kind: "contract", filename: "contract.pdf", data: PDF });
    expect(await purgeExpiredEvents(db(), ist("2027-12-10"))).toBe(0);
    // 23:00 IST on 10 Dec is still the day before; 00:30 IST on 11 Dec is the day.
    expect(await purgeExpiredEvents(db(), new Date("2027-12-10T17:30:00Z"))).toBe(0);
    expect(await purgeExpiredEvents(db(), new Date("2027-12-10T19:00:00Z"))).toBe(1);

    expect(await db().select().from(events).where(eq(events.id, event.id))).toHaveLength(0);
    expect(await db().select().from(households).where(eq(households.eventId, event.id))).toHaveLength(0);
    expect(await db().select().from(documents).where(eq(documents.eventId, event.id))).toHaveLength(0);
    const [metric] = await db().select().from(eventMetrics);
    expect(metric.reason).toBe("retention");
    expect(metric.counts).toMatchObject({ households: 1, guests: 1, functions: 2, vendors: 1, documents: 1, members: 1 });
    expect(metric.lastFunctionMonth).toBe("2026-12");
    const stored = JSON.stringify(metric);
    for (const pii of ["Sharma", "Priya", "Annapurna", event.id]) expect(stored).not.toContain(pii);

    const queued = await db().select().from(storageDeletions);
    expect(queued.map((q) => q.prefix)).toContain(`events/${event.id}/`);
    expect(await store.head(doc.storageKey!)).not.toBeNull();
    await processStorageDeletions(db(), store, new Date("2027-12-11T02:00:00Z"));
    expect(await store.head(doc.storageKey!)).toBeNull();
    expect(await db().select().from(storageDeletions)).toHaveLength(0);
  });

  it("purges soft-deleted events through the same queue (EVT-09)", async () => {
    const { event, actor, vendor } = await setup();
    const doc = await saveDocument(db(), event.id, actor, { owner: { vendorId: vendor.id }, kind: "contract", filename: "contract.pdf", data: PDF });
    const t0 = new Date("2027-01-01T00:00:00Z");
    await softDeleteEvent(db(), event.id, actor, t0);
    expect(await purgeDeletedEvents(db(), new Date(t0.getTime() + 8 * 86_400_000))).toBe(1);
    const [metric] = await db().select().from(eventMetrics);
    expect(metric.reason).toBe("deleted");
    expect((await db().select().from(storageDeletions)).map((q) => q.prefix)).toEqual([`events/${event.id}/`]);
    await processStorageDeletions(db(), store, new Date(t0.getTime() + 9 * 86_400_000));
    expect(await store.head(doc.storageKey!)).toBeNull();
  });
});

describe("full archive (EVT-08)", () => {
  async function unzip(ctx: ArchiveContext, partId = "main") {
    const entries = await partEntries(ctx, partId);
    const buf = new Uint8Array(await new Response(zipStream(entries!)).arrayBuffer());
    return unzipSync(buf);
  }

  it("contains the spreadsheets, printable pages and documents", async () => {
    const { event, actor, vendor, household } = await setup();
    await saveDocument(db(), event.id, actor, { owner: { vendorId: vendor.id }, kind: "contract", filename: "contract.pdf", data: PDF });
    const subject = { isAppAdmin: false, membership: { role: "host" as const, giftAccess: "none" as const } };
    await createGift(db(), { eventId: event.id, actor, subject }, { householdId: household.id, type: "cash", amountPaise: 110_000 });
    const ctx: ArchiveContext = { db: db(), event, t: createTranslator("en"), locale: "en", subject, actor, now: new Date("2026-12-20T06:00:00Z") };
    const files = await unzip(ctx);
    const names = Object.keys(files).sort();
    for (const sheet of ["Guests", "RSVPs and headcount", "Budget", "Payments", "Payables", "Vendors", "Gifts"]) {
      expect(names).toContain(`Spreadsheets/${sheet}.xlsx`);
    }
    expect(names).toContain("Printable/Run sheets.html");
    expect(names).toContain("Printable/Invoices.html");
    expect(names).toContain("README.txt");
    const docName = names.find((n) => n.startsWith("Documents/Contract/") && n.endsWith("contract.pdf"));
    expect(docName).toBeTruthy();
    expect(Buffer.from(files[docName!]).equals(PDF)).toBe(true);
    // xlsx files are real zips
    expect(strFromU8(files["Spreadsheets/Guests.xlsx"].subarray(0, 2), true)).toBe("PK");
    expect(strFromU8(files["README.txt"])).toContain("Priya weds Arjun");
  });

  it("names files in the downloader's language and accepts parts from other modules", async () => {
    const { event, actor } = await setup();
    const subject = { isAppAdmin: false, membership: { role: "host" as const, giftAccess: "none" as const } };
    registerArchivePart({
      listParts: async () => [{ id: "gallery-1", label: "Gallery 1", bytes: 3 }],
      entries: async function* () {
        yield { path: "Gallery/a.jpg", data: async () => new Blob([Buffer.from("abc")]).stream() };
      },
    });
    const ctx: ArchiveContext = { db: db(), event, t: createTranslator("hi"), locale: "hi", subject, actor, now: new Date() };
    const names = Object.keys(await unzip(ctx));
    expect(names).toContain("स्प्रेडशीट/मेहमान.xlsx");
    const gallery = await unzip(ctx, "gallery-1");
    expect(strFromU8(gallery["Gallery/a.jpg"])).toBe("abc");
    expect(await partEntries(ctx, "nope")).toBeNull();
    expect(await partEntries(ctx, "../x")).toBeNull();
  });

  it("is for Hosts and App Admins only", () => {
    expect(decide({ isAppAdmin: false, membership: { role: "host", giftAccess: "none" } }, "event.export")).toBe("allow");
    expect(decide({ isAppAdmin: true, membership: null }, "event.export")).toBe("allow");
    expect(decide({ isAppAdmin: false, membership: { role: "planner", giftAccess: "full" } }, "event.export")).toBe("deny");
  });
});

describe("guest erasure requests (EVT-09)", () => {
  it("records a request, erases the family, queues their files and keeps a log", async () => {
    const { event, actor, household } = await setup();
    await store.put(`events/${event.id}/households/${household.id}/selfie.jpg`, Buffer.from("x"), "image/jpeg");
    const req = await recordErasureRequest(db(), event.id, household.id, actor, { requestedAt: new Date("2026-12-15T10:00:00Z"), note: "Phoned the planner" });
    // Recording twice returns the open request.
    expect((await recordErasureRequest(db(), event.id, household.id, actor)).id).toBe(req.id);
    const done = await processErasureRequest(db(), event.id, req.id, actor);
    expect(done.processedAt).not.toBeNull();
    expect(await db().select().from(households).where(eq(households.id, household.id))).toHaveLength(0);
    const [logged] = await listErasureRequests(db(), event.id);
    expect(logged.request.householdName).toBe("Sharma family");
    expect(logged.request.householdId).toBeNull();
    expect((await db().select().from(storageDeletions)).map((q) => q.prefix)).toContain(`events/${event.id}/households/${household.id}/`);
    await processStorageDeletions(db(), store, new Date(Date.now() + 1000));
    expect(await store.head(`events/${event.id}/households/${household.id}/selfie.jpg`)).toBeNull();
    const actions = (await db().select().from(auditLogs).where(eq(auditLogs.eventId, event.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["erasure.requested", "household.deleted", "erasure.processed"]));
    await expect(processErasureRequest(db(), event.id, req.id, actor)).rejects.toMatchObject({ code: "already_processed" });
  });

  it("rejects households from another event", async () => {
    const { actor, household } = await setup();
    const other = await createEvent(db(), actor, { name: "Other" });
    await expect(recordErasureRequest(db(), other.id, household.id, actor)).rejects.toMatchObject({ code: "not_found" });
    expect(await db().select().from(guestErasureRequests)).toHaveLength(0);
  });
});
