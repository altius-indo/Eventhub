import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { documentBlobs, documents, eventStorageOverrides, notifications, platformSettings, storageDeletions, storageHouseholdUsage, storageReservations, storageUsage } from "@/db/schema";
import { deleteDocument, getDocument, saveDocument } from "@/lib/documents";
import { createEvent } from "@/lib/events";
import { createHousehold, guestSchema } from "@/lib/guests";
import { documentKey, eventKey, FsStore, householdPrefix, isValidKey, isValidPrefix, setStoreForTests, StorageError, storageMisconfigured } from "@/lib/storage";
import { signedDevUrl, verifyDevUrl } from "@/lib/storage/fs";
import { mimeAllowed } from "@/lib/storage/types";
import { processStorageDeletions, queueStorageDeletion, reconcileStorage, stuckStorageDeletions } from "@/lib/storage-gc";
import { usageSources } from "@/lib/storage-sources";
import {
  commit,
  DEFAULT_STORAGE_LIMITS,
  free,
  getStorageLimits,
  getStorageUsage,
  reconcileUsage,
  registerUsageSource,
  release,
  releaseExpiredReservations,
  reserve,
  StorageQuotaError,
} from "@/lib/storage-quota";
import { createVendor } from "@/lib/vendors";
import { actorOf, db, makeUser, resetDb } from "./helpers";

let root: string;
let store: FsStore;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "eh-store-"));
  store = new FsStore(root);
  setStoreForTests(store);
});
afterAll(async () => {
  setStoreForTests(null);
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetDb();
  await store.deleteByPrefix(`events/${EID}/`);
});

const EID = "11111111-2222-4333-8444-555555555555";
const PDF = Buffer.from("%PDF-1.7 a small contract body");
const text = async (s: ReadableStream<Uint8Array>) => Buffer.from(await new Response(s).arrayBuffer()).toString();

async function setup() {
  const host = await makeUser("host@example.com", "Asha");
  const event = await createEvent(db(), actorOf(host), { name: "Wedding", coupleNames: "Priya & Arjun" });
  return { host, event, actor: actorOf(host) };
}

describe("object keys", () => {
  it("accepts only server-shaped keys under events/<uuid>/", () => {
    expect(isValidKey(`events/${EID}/documents/abc`)).toBe(true);
    expect(isValidKey(`events/${EID}/households/h1/photo.jpg`)).toBe(true);
    for (const bad of [`events/${EID}/../x`, `events/${EID}/.hidden`, `events/not-a-uuid/x`, `x/${EID}/a`, `events/${EID}/`, `events/${EID}/a//b`, `/events/${EID}/a`]) {
      expect(isValidKey(bad)).toBe(false);
    }
    expect(isValidPrefix(`events/${EID}/`)).toBe(true);
    expect(isValidPrefix("events/")).toBe(false);
    expect(isValidPrefix("")).toBe(false);
    expect(() => eventKey(EID, "..", "x")).toThrow(StorageError);
    expect(householdPrefix(EID, "h1")).toBe(`events/${EID}/households/h1/`);
  });

  it("matches content types with wildcards", () => {
    expect(mimeAllowed("image/jpeg", ["image/*"])).toBe(true);
    expect(mimeAllowed("video/mp4", ["image/*"])).toBe(false);
    expect(mimeAllowed("application/pdf; charset=x", ["application/pdf"])).toBe(true);
  });
});

describe("filesystem store", () => {
  it("round-trips bytes, metadata and listing", async () => {
    const key = `events/${EID}/documents/one`;
    await store.put(key, Buffer.from("hello"), "text/plain");
    expect((await store.head(key))?.size).toBe(5);
    expect((await store.head(key))?.mime).toBe("text/plain");
    expect((await store.getBytes(key))?.toString()).toBe("hello");
    const got = await store.get(key);
    expect(got && (await text(got.stream))).toBe("hello");
    await store.put(`events/${EID}/documents/two`, Buffer.from("x"), "text/plain");
    const keys: string[] = [];
    for await (const o of store.list(`events/${EID}/documents/`)) keys.push(o.key);
    expect(keys.sort()).toEqual([`events/${EID}/documents/one`, `events/${EID}/documents/two`]);
    await store.delete(key);
    expect(await store.head(key)).toBeNull();
    expect(await store.get(key)).toBeNull();
    await store.delete(key); // idempotent
  });

  it("deletes by prefix without touching other events", async () => {
    const other = "99999999-2222-4333-8444-555555555555";
    await store.put(`events/${EID}/households/h1/a.jpg`, Buffer.from("a"), "image/jpeg");
    await store.put(`events/${EID}/households/h1/b/c.jpg`, Buffer.from("b"), "image/jpeg");
    await store.put(`events/${EID}/households/h2/a.jpg`, Buffer.from("c"), "image/jpeg");
    await store.put(`events/${other}/households/h1/a.jpg`, Buffer.from("d"), "image/jpeg");
    expect(await store.deleteByPrefix(`events/${EID}/households/h1/`)).toBe(2);
    expect(await store.head(`events/${EID}/households/h2/a.jpg`)).not.toBeNull();
    expect(await store.deleteByPrefix(`events/${EID}/`)).toBe(1);
    expect(await store.head(`events/${other}/households/h1/a.jpg`)).not.toBeNull();
    await expect(store.deleteByPrefix("events/")).rejects.toBeInstanceOf(StorageError);
  });

  it("signs short-lived GET URLs that can't be forged or reused for another key", async () => {
    const key = `events/${EID}/documents/one`;
    const url = new URL(await store.presignedGet(key, { ttlSeconds: 60 }), "http://x");
    expect(url.pathname).toBe(`/api/dev-blob/${key}`);
    expect(verifyDevUrl(key, "get", url.searchParams).op).toBe("get");
    // Expired
    expect(() => verifyDevUrl(key, "get", url.searchParams, new Date(Date.now() + 120_000))).toThrow(expect.objectContaining({ code: "expired" }));
    // Another key, another operation, a tampered expiry
    expect(() => verifyDevUrl(`events/${EID}/documents/two`, "get", url.searchParams)).toThrow(expect.objectContaining({ code: "bad_signature" }));
    expect(() => verifyDevUrl(key, "put", url.searchParams)).toThrow(expect.objectContaining({ code: "bad_signature" }));
    const tampered = new URLSearchParams(url.searchParams);
    tampered.set("exp", String(Number(tampered.get("exp")) + 3600));
    expect(() => verifyDevUrl(key, "get", tampered)).toThrow(expect.objectContaining({ code: "bad_signature" }));
    tampered.set("sig", "AAAA");
    expect(() => verifyDevUrl(key, "get", tampered)).toThrow(expect.objectContaining({ code: "bad_signature" }));
  });

  it("issues upload grants bound to key, size and types; streamed uploads enforce them", async () => {
    const key = `events/${EID}/gallery/p1.jpg`;
    const grant = await store.authorizeUpload({ key, maxBytes: 10, contentTypes: ["image/*"] });
    expect(grant.driver).toBe("fs");
    const url = new URL(grant.url!, "http://x");
    const p = verifyDevUrl(key, "put", url.searchParams);
    expect(p.max).toBe(10);
    expect(p.ct).toBe("image/*");
    // Raising the size limit breaks the signature.
    const bigger = new URLSearchParams(url.searchParams);
    bigger.set("max", "1000000");
    expect(() => verifyDevUrl(key, "put", bigger)).toThrow(StorageError);
    // Over the limit: refused, nothing left behind.
    await expect(store.putStream(key, new Blob([Buffer.alloc(11)]).stream(), "image/jpeg", 10)).rejects.toMatchObject({ code: "too_large" });
    expect(await store.head(key)).toBeNull();
    await store.putStream(key, new Blob([Buffer.alloc(10)]).stream(), "image/jpeg", 10);
    expect((await store.head(key))?.size).toBe(10);
    // No overwrite through a grant.
    await expect(store.putStream(key, new Blob([Buffer.alloc(1)]).stream(), "image/jpeg", 10)).rejects.toMatchObject({ code: "exists" });
  });

  it("signed URLs for other actions don't verify as uploads", () => {
    const key = `events/${EID}/a`;
    const exp = Math.floor(Date.now() / 1000) + 60;
    const get = new URL(signedDevUrl(key, { op: "get", exp }), "http://x");
    get.searchParams.set("op", "put");
    expect(() => verifyDevUrl(key, "put", get.searchParams)).toThrow(StorageError);
  });
});

describe("storage quota (LIM-01/03)", () => {
  it("reads limits from platform settings and event overrides", async () => {
    const { event } = await setup();
    expect(await getStorageLimits(db(), event.id)).toEqual(DEFAULT_STORAGE_LIMITS);
    await db().insert(platformSettings).values({ key: "limits", value: { whatsapp: 10, storageBytes: 5000, guestItems: 3 } });
    expect(await getStorageLimits(db(), event.id)).toMatchObject({ storageBytes: 5000, guestItems: 3, guestBytes: DEFAULT_STORAGE_LIMITS.guestBytes });
    await db().insert(eventStorageOverrides).values({ eventId: event.id, storageBytes: 9000 });
    expect((await getStorageLimits(db(), event.id)).storageBytes).toBe(9000);
  });

  it("reserves, commits and releases; members blocked at 100%, vendors may use 110%", async () => {
    const { event } = await setup();
    await db().insert(eventStorageOverrides).values({ eventId: event.id, storageBytes: 1000 });
    await db().transaction((tx) => reserve(tx, event.id, 600, "member"));
    let u = await getStorageUsage(db(), event.id);
    expect([u.used, u.reserved, u.remaining]).toEqual([0, 600, 400]);
    await db().transaction((tx) => commit(tx, event.id, 600, 550));
    u = await getStorageUsage(db(), event.id);
    expect([u.used, u.reserved]).toEqual([550, 0]);
    await db().transaction((tx) => reserve(tx, event.id, 450, "guest"));
    await expect(db().transaction((tx) => reserve(tx, event.id, 1, "member"))).rejects.toMatchObject({ code: "storage_full", remaining: 0 });
    await expect(db().transaction((tx) => reserve(tx, event.id, 1, "guest"))).rejects.toBeInstanceOf(StorageQuotaError);
    // Vendors: up to 1100 in total.
    await db().transaction((tx) => reserve(tx, event.id, 100, "vendor"));
    await expect(db().transaction((tx) => reserve(tx, event.id, 1, "vendor"))).rejects.toMatchObject({ code: "storage_full" });
    await db().transaction((tx) => release(tx, event.id, 450));
    u = await getStorageUsage(db(), event.id);
    expect([u.used, u.reserved]).toEqual([550, 100]);
    await db().transaction((tx) => free(tx, event.id, 10_000));
    expect((await getStorageUsage(db(), event.id)).used).toBe(0);
    await expect(db().transaction((tx) => reserve(tx, event.id, 0, "member"))).rejects.toMatchObject({ code: "invalid" });
  });

  it("concurrent reservations can't overshoot the limit", async () => {
    const { event } = await setup();
    await db().insert(eventStorageOverrides).values({ eventId: event.id, storageBytes: 1000 });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => db().transaction((tx) => reserve(tx, event.id, 200, "member"))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect((await getStorageUsage(db(), event.id)).reserved).toBe(1000);
  });

  it("caps guest uploads per household (items and bytes)", async () => {
    const { event, actor } = await setup();
    const { household: h } = await createHousehold(db(), event.id, actor, {
      household: { name: "Sharma", side: "bride", address: null, city: null, postalCode: null, notes: null },
      members: [guestSchema.parse({ name: "Rajesh" })],
    });
    await db().insert(eventStorageOverrides).values({ eventId: event.id, guestItems: 2, guestBytes: 100 });
    await db().transaction((tx) => reserve(tx, event.id, 40, "guest", { householdId: h.id }));
    await db().transaction((tx) => reserve(tx, event.id, 40, "guest", { householdId: h.id }));
    await expect(db().transaction((tx) => reserve(tx, event.id, 1, "guest", { householdId: h.id }))).rejects.toMatchObject({ code: "household_items" });
    await db().transaction((tx) => release(tx, event.id, 40, { householdId: h.id }));
    await expect(db().transaction((tx) => reserve(tx, event.id, 61, "guest", { householdId: h.id }))).rejects.toMatchObject({ code: "household_bytes" });
    await db().transaction((tx) => reserve(tx, event.id, 60, "guest", { householdId: h.id }));
  });

  it("gives back reservations of abandoned uploads when they expire", async () => {
    const { event, actor } = await setup();
    const { household: h } = await createHousehold(db(), event.id, actor, {
      household: { name: "Sharma", side: "bride", address: null, city: null, postalCode: null, notes: null },
      members: [guestSchema.parse({ name: "Rajesh" })],
    });
    await db().insert(eventStorageOverrides).values({ eventId: event.id, storageBytes: 1000, guestItems: 1 });
    const t0 = new Date("2026-12-10T10:00:00Z");
    // A guest upload that never finishes, and one by a member that does.
    const abandoned = await db().transaction((tx) => reserve(tx, event.id, 700, "guest", { householdId: h.id, now: t0, ttlSeconds: 3600 }));
    expect(abandoned.expiresAt.toISOString()).toBe("2026-12-10T11:00:00.000Z");
    const ok = await db().transaction((tx) => reserve(tx, event.id, 200, "member", { now: t0 }));
    await db().transaction((tx) => commit(tx, event.id, 200, 150, { reservationId: ok.id }));
    expect(await db().select().from(storageReservations)).toHaveLength(1);
    expect((await getStorageUsage(db(), event.id)).reserved).toBe(700);
    await expect(db().transaction((tx) => reserve(tx, event.id, 200, "member", { now: t0 }))).rejects.toMatchObject({ code: "storage_full" });

    // The daily job gives the space (and the family's allowance) back after expiry.
    expect(await releaseExpiredReservations(db(), new Date("2026-12-10T10:59:00Z"))).toBe(0);
    expect(await releaseExpiredReservations(db(), new Date("2026-12-10T11:00:00Z"))).toBe(1);
    expect((await getStorageUsage(db(), event.id)).reserved).toBe(0);
    const [hh] = await db().select().from(storageHouseholdUsage).where(eq(storageHouseholdUsage.householdId, h.id));
    expect([hh.items, hh.bytes]).toEqual([0, 0]);
    await db().transaction((tx) => reserve(tx, event.id, 1, "guest", { householdId: h.id, now: new Date("2026-12-10T11:01:00Z") }));

    // A late commit of the expired one still counts the object; a late release does nothing.
    await db().transaction((tx) => commit(tx, event.id, 700, 700, { reservationId: abandoned.id }));
    expect((await getStorageUsage(db(), event.id)).used).toBe(850);
    await db().transaction((tx) => release(tx, event.id, 700, { reservationId: abandoned.id }));
    expect((await getStorageUsage(db(), event.id)).reserved).toBe(1);
  });

  it("reconcile recomputes reserved bytes from live reservations", async () => {
    const { event } = await setup();
    const t0 = new Date("2026-12-10T10:00:00Z");
    await db().transaction((tx) => reserve(tx, event.id, 300, "member", { now: t0, ttlSeconds: 600 }));
    await db().transaction((tx) => reserve(tx, event.id, 50, "vendor", { now: t0, ttlSeconds: 7200 }));
    // The counter drifted (e.g. a crash between steps).
    await db().update(storageUsage).set({ reservedBytes: 9999 }).where(eq(storageUsage.eventId, event.id));
    await db().transaction((tx) => reconcileUsage(tx, event.id, new Date("2026-12-10T10:30:00Z")));
    expect((await getStorageUsage(db(), event.id)).reserved).toBe(50);
    expect(await db().select().from(storageReservations)).toHaveLength(1);
  });

  it("commit and release without an id still match the right reservation", async () => {
    const { event } = await setup();
    await db().transaction((tx) => reserve(tx, event.id, 100, "member"));
    await db().transaction((tx) => reserve(tx, event.id, 40, "member"));
    await db().transaction((tx) => commit(tx, event.id, 40));
    await db().transaction((tx) => release(tx, event.id, 100));
    expect(await db().select().from(storageReservations)).toHaveLength(0);
    expect(await getStorageUsage(db(), event.id)).toMatchObject({ used: 40, reserved: 0 });
  });

  it("warns Hosts once at 80% and once at 95%", async () => {
    const { event } = await setup();
    await db().insert(eventStorageOverrides).values({ eventId: event.id, storageBytes: 1000 });
    const step = async (n: number) => db().transaction(async (tx) => {
      await reserve(tx, event.id, n, "member");
      await commit(tx, event.id, n);
    });
    const warnings = async () => (await db().select().from(notifications).where(eq(notifications.kind, "usage.storageWarning"))).map((n) => n.data?.pct);
    await step(790);
    expect(await warnings()).toEqual([]);
    await step(20);
    expect(await warnings()).toEqual([80]);
    await step(10);
    expect(await warnings()).toEqual([80]);
    await step(150);
    expect((await warnings()).sort()).toEqual([80, 95]);
    await step(10);
    expect(await warnings()).toHaveLength(2);
    const [row] = await db().select().from(storageUsage).where(eq(storageUsage.eventId, event.id));
    expect(row.warned80At).not.toBeNull();
    expect(row.warned95At).not.toBeNull();
  });
});

describe("documents in object storage (ADR-0030)", () => {
  it("stores new documents in the store, counts them and frees them on delete", async () => {
    const { event, actor } = await setup();
    const vendor = await createVendor(db(), event.id, actor, { name: "Caterer", contactName: null, phone: null, email: null, gstin: null, notes: null, serviceTypeIds: [] });
    const doc = await saveDocument(db(), event.id, actor, { owner: { vendorId: vendor.id }, kind: "contract", filename: "c.pdf", data: PDF });
    expect(doc.storageKey).toBe(documentKey(event.id, doc.id));
    expect((await store.getBytes(doc.storageKey!))?.equals(PDF)).toBe(true);
    expect(await db().select().from(documentBlobs)).toHaveLength(0);
    expect((await getDocument(db(), event.id, doc.id)).data.equals(PDF)).toBe(true);
    expect((await getStorageUsage(db(), event.id)).used).toBe(PDF.length);
    await deleteDocument(db(), event.id, actor, doc.id);
    expect(await store.head(doc.storageKey!)).toBeNull();
    expect((await getStorageUsage(db(), event.id)).used).toBe(0);
    expect(await db().select().from(storageDeletions)).toHaveLength(0);
  });

  it("refuses uploads over the storage quota without leaving files", async () => {
    const { event, actor } = await setup();
    const vendor = await createVendor(db(), event.id, actor, { name: "Caterer", contactName: null, phone: null, email: null, gstin: null, notes: null, serviceTypeIds: [] });
    await db().insert(eventStorageOverrides).values({ eventId: event.id, storageBytes: PDF.length + 5 });
    await saveDocument(db(), event.id, actor, { owner: { vendorId: vendor.id }, kind: "contract", filename: "c.pdf", data: PDF });
    await expect(saveDocument(db(), event.id, actor, { owner: { vendorId: vendor.id }, kind: "contract", filename: "d.pdf", data: PDF })).rejects.toMatchObject({ code: "quota" });
    // Vendors may use the 10% reserve.
    await db().update(eventStorageOverrides).set({ storageBytes: PDF.length * 2 - 2 }).where(eq(eventStorageOverrides.eventId, event.id));
    await saveDocument(db(), event.id, actor, { owner: { vendorId: vendor.id }, kind: "invoice", filename: "v.pdf", data: PDF, audience: "vendor" });
    let n = 0;
    for await (const o of store.list(`events/${event.id}/documents/`)) n += o.size > 0 ? 1 : 0;
    expect(n).toBe(2);
  });

  it("still reads older documents from document_blobs", async () => {
    const { event, actor } = await setup();
    const vendor = await createVendor(db(), event.id, actor, { name: "Caterer", contactName: null, phone: null, email: null, gstin: null, notes: null, serviceTypeIds: [] });
    const [legacy] = await db()
      .insert(documents)
      .values({ eventId: event.id, vendorId: vendor.id, kind: "other", filename: "old.pdf", mime: "application/pdf", bytes: PDF.length, sha256: "x" })
      .returning();
    await db().insert(documentBlobs).values({ documentId: legacy.id, data: PDF });
    expect((await getDocument(db(), event.id, legacy.id)).data.equals(PDF)).toBe(true);
  });

  it("reconciles usage and removes orphaned document objects", async () => {
    const { event, actor } = await setup();
    const vendor = await createVendor(db(), event.id, actor, { name: "Caterer", contactName: null, phone: null, email: null, gstin: null, notes: null, serviceTypeIds: [] });
    const doc = await saveDocument(db(), event.id, actor, { owner: { vendorId: vendor.id }, kind: "contract", filename: "c.pdf", data: PDF });
    // The vendor is deleted directly: its documents go by cascade, the counter drifts.
    await db().delete(documents).where(eq(documents.id, doc.id));
    expect((await getStorageUsage(db(), event.id)).used).toBe(PDF.length);
    // A day later the daily job fixes both.
    await reconcileStorage(db(), store, new Date(Date.now() + 25 * 3600_000));
    expect((await getStorageUsage(db(), event.id)).used).toBe(0);
    expect(await store.head(doc.storageKey!)).toBeNull();
  });
});

describe("usage sources", () => {
  it("reconcile adds up every centrally registered source, not just documents", async () => {
    const { event, actor } = await setup();
    const vendor = await createVendor(db(), event.id, actor, { name: "Caterer", contactName: null, phone: null, email: null, gstin: null, notes: null, serviceTypeIds: [] });
    await saveDocument(db(), event.id, actor, { owner: { vendorId: vendor.id }, kind: "contract", filename: "c.pdf", data: PDF });
    // storage-quota re-exports the central registry, so both import paths register in one place.
    registerUsageSource({ key: "test.extra", measure: async (_db, id) => (id === event.id ? 1234 : 0) });
    try {
      expect(usageSources().map((s) => s.key)).toEqual(expect.arrayContaining(["documents", "test.extra"]));
      await db().transaction((tx) => reconcileUsage(tx, event.id));
      expect((await getStorageUsage(db(), event.id)).used).toBe(PDF.length + 1234);
    } finally {
      registerUsageSource({ key: "test.extra", measure: async () => 0 });
    }
  });
});

describe("storage configuration", () => {
  it("requires STORAGE_DRIVER=fs explicitly in production without a Blob token", () => {
    expect(storageMisconfigured({ NODE_ENV: "production" })).toBe(true);
    expect(storageMisconfigured({ NODE_ENV: "production", STORAGE_DRIVER: "fs" })).toBe(false);
    expect(storageMisconfigured({ NODE_ENV: "production", BLOB_READ_WRITE_TOKEN: "x" })).toBe(false);
    expect(storageMisconfigured({ NODE_ENV: "production", STORAGE_DRIVER: "blob" })).toBe(true);
    expect(storageMisconfigured({ NODE_ENV: "development" })).toBe(false);
    expect(storageMisconfigured({ NODE_ENV: "test" })).toBe(false);
  });
});

describe("storage deletion queue", () => {
  it("counts deletions that keep failing for the App Admin", async () => {
    await db().transaction((tx) => queueStorageDeletion(tx, `events/${EID}/`, "retention"));
    await db().transaction((tx) => queueStorageDeletion(tx, `events/${EID}/households/h2/`, "erasure"));
    expect(await stuckStorageDeletions(db())).toBe(0);
    await db().update(storageDeletions).set({ attempts: 5 }).where(eq(storageDeletions.prefix, `events/${EID}/`));
    expect(await stuckStorageDeletions(db())).toBe(1);
  });

  it("deletes queued prefixes and retries failures with backoff", async () => {
    await store.put(`events/${EID}/households/h1/a.jpg`, Buffer.from("a"), "image/jpeg");
    await db().transaction((tx) => queueStorageDeletion(tx, householdPrefix(EID, "h1"), "erasure"));
    expect(await processStorageDeletions(db(), store)).toBe(1);
    expect(await store.head(`events/${EID}/households/h1/a.jpg`)).toBeNull();
    expect(await db().select().from(storageDeletions)).toHaveLength(0);

    await db().transaction((tx) => queueStorageDeletion(tx, `events/${EID}/`, "retention"));
    const failing = Object.assign(Object.create(store), { deleteByPrefix: async () => Promise.reject(new Error("store down")) }) as FsStore;
    const now = new Date();
    expect(await processStorageDeletions(db(), failing, now)).toBe(0);
    const [row] = await db().select().from(storageDeletions);
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe("store down");
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
    // Not due yet.
    expect(await processStorageDeletions(db(), store, now)).toBe(0);
    expect(await processStorageDeletions(db(), store, new Date(now.getTime() + 3600_000))).toBe(1);
    await expect(db().transaction((tx) => queueStorageDeletion(tx, "events/", "x"))).rejects.toThrow();
  });
});
