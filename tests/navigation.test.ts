import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, eventMembers, events, storageDeletions, storageReservations, storageUsage, users } from "@/db/schema";
import { initials } from "@/components/event-avatar";
import { EventLogoError, isLogoKey, logoVersion, readEventLogo, removeEventLogo, saveEventLogo } from "@/lib/event-logo";
import { createEvent, softDeleteEvent } from "@/lib/events";
import { landingEventId, rememberLastEvent } from "@/lib/last-event";
import { FsStore, setStoreForTests } from "@/lib/storage";
import { reconcileUsage, setStorageOverride } from "@/lib/storage-quota";
import { actorOf, db, makeUser, resetDb } from "./helpers";

let root: string;
let store: FsStore;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "eh-nav-"));
  store = new FsStore(root);
  setStoreForTests(store);
});
afterAll(async () => {
  setStoreForTests(null);
  await rm(root, { recursive: true, force: true });
});
beforeEach(resetDb);

const lastOf = async (userId: string) => (await db().select({ v: users.lastEventId }).from(users).where(eq(users.id, userId)))[0].v;

describe("last-event landing (EVT-03)", () => {
  it("lands nowhere without events, on the only event, and on the last one among several", async () => {
    const host = await makeUser("host@example.com", "Host");
    expect(await landingEventId(db(), host.id)).toBeNull();

    const a = await createEvent(db(), actorOf(host), { name: "A" });
    expect(await landingEventId(db(), host.id)).toBe(a.id); // single event, nothing remembered

    const b = await createEvent(db(), actorOf(host), { name: "B" });
    expect(await landingEventId(db(), host.id)).toBeNull(); // several, none remembered → list

    await rememberLastEvent(db(), host.id, b.id, null);
    expect(await landingEventId(db(), host.id)).toBe(b.id);
    await rememberLastEvent(db(), host.id, a.id, b.id);
    expect(await landingEventId(db(), host.id)).toBe(a.id);
  });

  it("only writes when the event changed", async () => {
    const host = await makeUser("host@example.com", "Host");
    const a = await createEvent(db(), actorOf(host), { name: "A" });
    expect(await rememberLastEvent(db(), host.id, a.id, null)).toBe(true);
    expect(await rememberLastEvent(db(), host.id, a.id, a.id)).toBe(false);
    expect(await lastOf(host.id)).toBe(a.id);
  });

  it("falls back when membership was revoked", async () => {
    const host = await makeUser("host@example.com", "Host");
    const planner = await makeUser("planner@example.com", "Planner");
    const a = await createEvent(db(), actorOf(host), { name: "A" });
    const b = await createEvent(db(), actorOf(host), { name: "B" });
    const c = await createEvent(db(), actorOf(host), { name: "C" });
    for (const e of [a, b, c]) await db().insert(eventMembers).values({ eventId: e.id, userId: planner.id, role: "planner" });
    await rememberLastEvent(db(), planner.id, a.id, null);

    await db().delete(eventMembers).where(and(eq(eventMembers.eventId, a.id), eq(eventMembers.userId, planner.id)));
    expect(await landingEventId(db(), planner.id)).toBeNull(); // two left, last one gone → list

    await db().delete(eventMembers).where(and(eq(eventMembers.eventId, b.id), eq(eventMembers.userId, planner.id)));
    expect(await landingEventId(db(), planner.id)).toBe(c.id); // the only one left
  });

  it("never lands on a deleted event (soft delete, then purge clears the column)", async () => {
    const host = await makeUser("host@example.com", "Host");
    const a = await createEvent(db(), actorOf(host), { name: "A" });
    const b = await createEvent(db(), actorOf(host), { name: "B" });
    await rememberLastEvent(db(), host.id, a.id, null);
    await softDeleteEvent(db(), a.id, actorOf(host));
    expect(await landingEventId(db(), host.id)).toBe(b.id);

    await db().delete(events).where(eq(events.id, a.id));
    expect(await lastOf(host.id)).toBeNull(); // on delete set null
    expect(await landingEventId(db(), host.id)).toBe(b.id);
  });

  it("doesn't land a user on someone else's event even if the column points there", async () => {
    const host = await makeUser("host@example.com", "Host");
    const other = await makeUser("other@example.com", "Other");
    const a = await createEvent(db(), actorOf(host), { name: "A" });
    const mine = await createEvent(db(), actorOf(other), { name: "Mine" });
    await createEvent(db(), actorOf(other), { name: "Mine too" });
    await db().update(users).set({ lastEventId: a.id }).where(eq(users.id, other.id));
    expect(await landingEventId(db(), other.id)).toBeNull();
    await db().delete(eventMembers).where(eq(eventMembers.userId, other.id));
    await db().insert(eventMembers).values({ eventId: mine.id, userId: other.id, role: "host" });
    expect(await landingEventId(db(), other.id)).toBe(mine.id);
  });
});

const png = (w = 600, h = 400) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 198, g: 91, b: 131 } } }).png().toBuffer();
const used = async (eventId: string) => (await db().select().from(storageUsage).where(eq(storageUsage.eventId, eventId)))[0];

describe("event logo", () => {
  async function setup() {
    const host = await makeUser("host@example.com", "Host");
    const event = await createEvent(db(), actorOf(host), { name: "Priya weds Arjun" });
    return { host, event, actor: actorOf(host) };
  }

  it("stores a 256px square WebP, counts it in the quota and audits it", async () => {
    const { event, actor } = await setup();
    const { key, bytes } = await saveEventLogo(db(), event.id, actor, await png());
    expect(isLogoKey(event.id, key)).toBe(true);
    expect(key.startsWith(`events/${event.id}/branding/logo-`)).toBe(true);
    const data = await readEventLogo(event.id, key);
    const meta = await sharp(data!).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", 256, 256]);
    expect(data!.length).toBe(bytes);

    const [row] = await db().select().from(events).where(eq(events.id, event.id));
    expect(row.logoKey).toBe(key);
    expect(row.logoBytes).toBe(bytes);
    expect(logoVersion(event.id, key)).toMatch(/^[0-9a-f-]{36}$/);
    expect((await used(event.id)).usedBytes).toBe(bytes);
    expect((await used(event.id)).reservedBytes).toBe(0);
    expect(await db().select().from(storageReservations)).toHaveLength(0);
    // Reconciliation agrees with the counter (the logo is a usage source).
    expect(await db().transaction((tx) => reconcileUsage(tx, event.id))).toBe(bytes);
    const logs = await db().select().from(auditLogs).where(eq(auditLogs.action, "event.logo_added"));
    expect(logs).toHaveLength(1);
  });

  it("replacing frees the old bytes and deletes the old object", async () => {
    const { event, actor } = await setup();
    const first = await saveEventLogo(db(), event.id, actor, await png());
    const second = await saveEventLogo(db(), event.id, actor, await png(300, 900));
    expect(second.key).not.toBe(first.key);
    expect(await store.head(first.key)).toBeNull();
    expect(await store.head(second.key)).not.toBeNull();
    expect((await used(event.id)).usedBytes).toBe(second.bytes);
    expect(await db().select().from(storageDeletions)).toHaveLength(0); // ran right away
    expect(await db().select().from(auditLogs).where(eq(auditLogs.action, "event.logo_replaced"))).toHaveLength(1);
  });

  it("removal clears the column, frees the quota and deletes the object", async () => {
    const { event, actor } = await setup();
    const { key } = await saveEventLogo(db(), event.id, actor, await png());
    await removeEventLogo(db(), event.id, actor);
    const [row] = await db().select().from(events).where(eq(events.id, event.id));
    expect([row.logoKey, row.logoBytes]).toEqual([null, 0]);
    expect(await store.head(key)).toBeNull();
    expect((await used(event.id)).usedBytes).toBe(0);
    expect(await db().select().from(auditLogs).where(eq(auditLogs.action, "event.logo_removed"))).toHaveLength(1);
    await expect(removeEventLogo(db(), event.id, actor)).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects non-images, oversized and unreadable files", async () => {
    const { event, actor } = await setup();
    const err = (p: Promise<unknown>) => p.then(() => null, (e: EventLogoError) => e.code);
    expect(await err(saveEventLogo(db(), event.id, actor, Buffer.alloc(0)))).toBe("empty");
    expect(await err(saveEventLogo(db(), event.id, actor, Buffer.from("%PDF-1.7 not an image at all")))).toBe("bad_type");
    expect(await err(saveEventLogo(db(), event.id, actor, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")))).toBe("bad_type");
    const big = Buffer.concat([await png(), Buffer.alloc(4 * 1024 * 1024)]);
    expect(await err(saveEventLogo(db(), event.id, actor, big))).toBe("too_large");
    // Right magic bytes, garbage body.
    const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
    expect(await err(saveEventLogo(db(), event.id, actor, fake))).toBe("bad_image");
    const [row] = await db().select().from(events).where(eq(events.id, event.id));
    expect(row.logoKey).toBeNull();
  });

  it("is refused when storage is full, leaving nothing behind", async () => {
    const { event, actor } = await setup();
    await setStorageOverride(db(), event.id, { storageBytes: 100 });
    await expect(saveEventLogo(db(), event.id, actor, await png())).rejects.toMatchObject({ code: "quota" });
    const [row] = await db().select().from(events).where(eq(events.id, event.id));
    expect(row.logoKey).toBeNull();
    const left = [];
    for await (const o of store.list(`events/${event.id}/`)) left.push(o);
    expect(left).toHaveLength(0);
  });

  it("refuses deleted events and keys that aren't logo keys", async () => {
    const { event, actor } = await setup();
    await softDeleteEvent(db(), event.id, actor);
    await expect(saveEventLogo(db(), event.id, actor, await png())).rejects.toMatchObject({ code: "not_found" });
    expect(isLogoKey(event.id, `events/${event.id}/documents/x`)).toBe(false);
    expect(await readEventLogo(event.id, `events/${event.id}/documents/x`)).toBeNull();
  });
});

describe("initials avatar", () => {
  it("picks two initials and skips connecting words", () => {
    expect(initials("Priya weds Arjun")).toBe("PA");
    expect(initials("Sharma wedding")).toBe("SW");
    expect(initials("  ")).toBe("•");
    expect(initials("प्रिया और अर्जुन")).toBe("पअ");
  });
});
