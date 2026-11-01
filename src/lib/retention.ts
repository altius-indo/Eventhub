import { and, desc, eq, inArray, isNotNull, isNull, lte, max, sql } from "drizzle-orm";
import type { Database, Tx } from "@/db";
import {
  bookings,
  broadcasts,
  documents,
  eventMembers,
  eventMetrics,
  events,
  functions,
  gifts,
  guestErasureRequests,
  guests,
  households,
  messages,
  requirements,
  retentionNotices,
  rsvps,
  services,
  tasks,
  userIdentifiers,
  users,
  vendorContacts,
  vendors,
  type Event,
  type GuestErasureRequest,
} from "@/db/schema";
import type { PgTable } from "drizzle-orm/pg-core";
import { createTranslator, formatDay, isLocale, type Locale } from "@/i18n/core";
import { audit, type Actor } from "./audit";
import { deleteHousehold, GuestError } from "./guests";
import { notify } from "./notifications";
import { enqueue, type EnqueueItem } from "./outbox";
import { eventPrefix } from "./storage";
import { queueStorageDeletion } from "./storage-gc";
import { todayIn } from "./tasks";

/**
 * Data retention and deletion (EVT-07, EVT-08, EVT-09; ADR-0033).
 *
 * - The clock starts at the event's last function; data is deleted 1 year later (on the
 *   deletion date, in the event's timezone). Without function dates the event's end date is used;
 *   with neither, the event is never deleted automatically (flagged in the admin list).
 * - Hosts are reminded 60, 30 and 7 days before; vendors are told to download their records.
 * - Purging writes anonymised counts to `event_metrics`, queues the event's storage prefix for
 *   deletion and hard-deletes the event (every event-owned table cascades).
 */

export const REMINDER_DAYS = [60, 30, 7] as const;

/** `YYYY-MM-DD` + 1 year. 29 Feb rolls to 1 Mar, so the year is never cut short. */
export function addOneYear(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y + 1, m - 1, d)).toISOString().slice(0, 10);
}

/** The deletion date for an event, or null when it has no dates at all. */
export function deletionDateFor(lastFunctionDate: string | null, endDate: string | null): string | null {
  const start = lastFunctionDate ?? endDate;
  return start ? addOneYear(start) : null;
}

const dayNum = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

export type RetentionInfo = {
  /** The day the retention clock starts from (last function, else the event's end date). */
  clockDate: string | null;
  deletionDate: string | null;
  /** True once the clock date is over in the event's timezone (show the banner). */
  started: boolean;
  /** Days from today (event timezone) to the deletion date; null when there's no date. */
  daysLeft: number | null;
};

export async function lastFunctionDate(db: Tx, eventId: string): Promise<string | null> {
  const [row] = await db.select({ d: max(functions.date) }).from(functions).where(eq(functions.eventId, eventId));
  return row?.d ?? null;
}

export function retentionFor(event: Pick<Event, "endDate" | "timezone">, lastFn: string | null, now = new Date()): RetentionInfo {
  const clockDate = lastFn ?? event.endDate;
  const deletionDate = deletionDateFor(lastFn, event.endDate);
  if (!clockDate || !deletionDate) return { clockDate: null, deletionDate: null, started: false, daysLeft: null };
  const today = todayIn(event.timezone, now);
  return { clockDate, deletionDate, started: today > clockDate, daysLeft: dayNum(deletionDate) - dayNum(today) };
}

export async function getRetention(db: Tx, event: Pick<Event, "id" | "endDate" | "timezone">, now = new Date()) {
  return retentionFor(event, await lastFunctionDate(db, event.id), now);
}

/** Every live event with its retention dates (one query). */
async function eventsWithDates(db: Tx) {
  return db
    .select({ event: events, lastFn: max(functions.date) })
    .from(events)
    .leftJoin(functions, eq(functions.eventId, events.id))
    .where(isNull(events.deletedAt))
    .groupBy(events.id);
}

/** For the App Admin events list: retention per event id. */
export async function retentionByEvent(db: Tx, ids: string[], now = new Date()) {
  if (ids.length === 0) return new Map<string, RetentionInfo>();
  const rows = await db
    .select({ id: events.id, endDate: events.endDate, timezone: events.timezone, lastFn: max(functions.date) })
    .from(events)
    .leftJoin(functions, eq(functions.eventId, events.id))
    .where(inArray(events.id, ids))
    .groupBy(events.id);
  return new Map(rows.map((r) => [r.id, retentionFor(r, r.lastFn, now)]));
}

// ---------------------------------------------------------------------------
// Reminders (EVT-08)
// ---------------------------------------------------------------------------

async function emailsOf(db: Tx, userIds: string[]) {
  if (userIds.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ userId: userIdentifiers.userId, value: userIdentifiers.value })
    .from(userIdentifiers)
    .where(and(inArray(userIdentifiers.userId, userIds), eq(userIdentifiers.type, "email")));
  return new Map(rows.map((r) => [r.userId, r.value]));
}

/**
 * Daily: reminds Hosts (in-app + email) and vendor contacts (email + in-app in their portal) at
 * 60, 30 and 7 days before deletion. Each threshold goes out once; if the job missed a threshold
 * (or the event was set up late) only the nearest one is sent. Returns events reminded.
 */
export async function sendRetentionReminders(db: Database, now = new Date(), appUrl = process.env.APP_URL ?? ""): Promise<number> {
  const base = appUrl.replace(/\/$/, "");
  let sent = 0;
  for (const { event, lastFn } of await eventsWithDates(db)) {
    const info = retentionFor(event, lastFn, now);
    if (info.daysLeft == null || !info.deletionDate || info.daysLeft <= 0) continue;
    const due = REMINDER_DAYS.filter((n) => info.daysLeft! <= n);
    if (due.length === 0) continue;
    const target = Math.min(...due);
    const deletionDate = info.deletionDate;
    const did = await db.transaction(async (tx) => {
      // A changed date (e.g. a function added later) restarts the reminders.
      await tx.delete(retentionNotices).where(and(eq(retentionNotices.eventId, event.id), sql`${retentionNotices.deletionDate} <> ${deletionDate}`));
      const claimed = await tx
        .insert(retentionNotices)
        .values(due.map((days) => ({ eventId: event.id, days, deletionDate })))
        .onConflictDoNothing()
        .returning({ days: retentionNotices.days });
      if (!claimed.some((c) => c.days === target)) return false;
      await remindEvent(tx, event, deletionDate, info.daysLeft!, target, base);
      return true;
    });
    if (did) sent++;
  }
  return sent;
}

async function remindEvent(tx: Tx, event: Event, deletionDate: string, daysLeft: number, threshold: number, base: string) {
  const hosts = await tx
    .select({ id: users.id, locale: users.locale, suspendedAt: users.suspendedAt })
    .from(eventMembers)
    .innerJoin(users, eq(users.id, eventMembers.userId))
    .where(and(eq(eventMembers.eventId, event.id), eq(eventMembers.role, "host")));
  const archiveHref = `/events/${event.id}/settings#data`;
  await notify(tx, {
    eventId: event.id,
    userIds: hosts.map((h) => h.id),
    kind: "retention.reminder",
    data: { date: deletionDate, days: daysLeft },
    href: archiveHref,
    noEmail: true,
  });
  const hostEmails = await emailsOf(tx, hosts.map((h) => h.id));
  const items: EnqueueItem[] = [];
  for (const h of hosts) {
    const email = hostEmails.get(h.id);
    if (!email || h.suspendedAt) continue;
    const locale: Locale = isLocale(h.locale) ? h.locale : "en";
    const t = createTranslator(locale);
    const date = formatDay(locale, deletionDate, { dateStyle: "long" });
    items.push({
      eventId: event.id,
      purpose: "retention",
      templateKey: "plain",
      vars: { subject: t("retention.emailSubject", { event: event.name, date }), text: t("retention.emailHost", { event: event.name, date, days: daysLeft, url: `${base}${archiveHref}` }) },
      recipient: { userId: h.id, addresses: { email }, locale },
      channels: ["email"],
      bulk: false,
      key: `retention:${event.id}:${threshold}:${h.id}`,
    });
  }

  // Vendors: their own invoices and payment records (EVT-08).
  const contacts = await tx
    .select({ contact: vendorContacts, locale: users.locale })
    .from(vendorContacts)
    .innerJoin(vendors, eq(vendors.id, vendorContacts.vendorId))
    .leftJoin(users, eq(users.id, vendorContacts.userId))
    .where(and(eq(vendorContacts.eventId, event.id), isNull(vendorContacts.revokedAt), isNull(vendors.archivedAt)));
  const vendorUsers = contacts.filter((c) => c.contact.userId);
  for (const c of vendorUsers) {
    await notify(tx, {
      eventId: event.id,
      userIds: [c.contact.userId!],
      kind: "vendor.retention",
      data: { event: event.name, date: deletionDate },
      href: `/vendor/${c.contact.vendorId}`,
      noEmail: true,
    });
  }
  const contactEmails = await emailsOf(tx, vendorUsers.map((c) => c.contact.userId!));
  for (const c of contacts) {
    const email = c.contact.identifierType === "email" ? c.contact.identifierValue : c.contact.userId ? contactEmails.get(c.contact.userId) : undefined;
    if (!email) continue;
    const locale: Locale = isLocale(c.locale) ? c.locale : "en";
    const t = createTranslator(locale);
    const date = formatDay(locale, deletionDate, { dateStyle: "long" });
    items.push({
      eventId: event.id,
      purpose: "retention",
      templateKey: "plain",
      vars: { subject: t("retention.emailSubject", { event: event.name, date }), text: t("retention.emailVendor", { event: event.name, date, url: `${base}/vendor/${c.contact.vendorId}` }) },
      recipient: { userId: c.contact.userId, addresses: { email }, locale },
      channels: ["email"],
      bulk: false,
      key: `retention:${event.id}:${threshold}:v:${c.contact.id}`,
    });
  }
  await enqueue(tx, items);
}

// ---------------------------------------------------------------------------
// Purge (EVT-07) — also used for soft-deleted events (EVT-09)
// ---------------------------------------------------------------------------

/** Anonymised counts kept after deletion: numbers only, never names or ids of people. */
export async function anonymisedCounts(tx: Tx, eventId: string): Promise<Record<string, number>> {
  const tables: Record<string, PgTable> = {
    households,
    guests,
    functions,
    members: eventMembers,
    vendors,
    services,
    requirements,
    bookings,
    tasks,
    gifts,
    documents,
    messages,
    broadcasts,
  };
  const parts = Object.entries(tables).map(([name, t]) => sql`(select count(*) from ${t} where event_id = ${eventId})::int as ${sql.identifier(name)}`);
  parts.push(sql`(select count(*) from ${rsvps} r join ${guests} g on g.id = r.guest_id where g.event_id = ${eventId})::int as ${sql.identifier("rsvps")}`);
  const res = await tx.execute(sql`select ${sql.join(parts, sql`, `)}`);
  const row = (res.rows[0] ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
}

/**
 * Removes one event for good: metrics row, storage prefix queued, event row deleted (cascade).
 * Call inside a transaction holding the event row lock.
 */
export async function finalPurge(tx: Tx, event: Pick<Event, "id" | "createdAt">, reason: "retention" | "deleted", lastFn: string | null) {
  const counts = await anonymisedCounts(tx, event.id);
  await tx.insert(eventMetrics).values({
    reason,
    createdMonth: event.createdAt.toISOString().slice(0, 7),
    lastFunctionMonth: lastFn ? lastFn.slice(0, 7) : null,
    counts,
  });
  await queueStorageDeletion(tx, eventPrefix(event.id), reason === "retention" ? "retention" : "event_deleted");
  // Platform audit row (no event FK, no names): the event's own log goes with it.
  await audit(tx, { eventId: null, actor: null, action: reason === "retention" ? "event.retention_purged" : "event.purged", entityType: "event", entityId: event.id, data: { counts } });
  await tx.delete(events).where(eq(events.id, event.id));
}

/** Daily: hard-deletes events whose deletion date has arrived (event timezone). Returns how many. */
export async function purgeExpiredEvents(db: Database, now = new Date(), opts: { limit?: number } = {}): Promise<number> {
  const due = (await eventsWithDates(db)).filter(({ event, lastFn }) => {
    const d = deletionDateFor(lastFn, event.endDate);
    return d != null && todayIn(event.timezone, now) >= d;
  });
  let n = 0;
  for (const { event } of due.slice(0, opts.limit ?? 20)) {
    const purged = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(events).where(and(eq(events.id, event.id), isNull(events.deletedAt))).for("update");
      if (!locked) return false;
      // Re-check under the lock: a function may have been added since.
      const lastFn = await lastFunctionDate(tx, locked.id);
      const d = deletionDateFor(lastFn, locked.endDate);
      if (!d || todayIn(locked.timezone, now) < d) return false;
      await finalPurge(tx, locked, "retention", lastFn);
      return true;
    });
    if (purged) n++;
  }
  return n;
}

/** Soft-deleted events past their undo window (EVT-09), through the same purge. */
export async function purgeSoftDeleted(db: Database, now = new Date()): Promise<number> {
  const due = await db
    .select({ id: events.id })
    .from(events)
    .where(and(isNotNull(events.deletedAt), lte(events.purgeAfter, now)));
  let n = 0;
  for (const { id } of due) {
    const purged = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(events)
        .where(and(eq(events.id, id), isNotNull(events.deletedAt), lte(events.purgeAfter, now)))
        .for("update");
      if (!locked) return false;
      await finalPurge(tx, locked, "deleted", await lastFunctionDate(tx, id));
      return true;
    });
    if (purged) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Guest erasure requests (EVT-09, DPDP right to erasure)
// ---------------------------------------------------------------------------

export class RetentionError extends Error {
  constructor(public code: "not_found" | "already_processed" | "invalid") {
    super(code);
  }
}

/** Records that a family asked for their data to be erased (processed now or later). */
export async function recordErasureRequest(db: Database, eventId: string, householdId: string, actor: Actor, input: { requestedAt?: Date; note?: string | null } = {}) {
  return db.transaction(async (tx) => {
    const [h] = await tx.select().from(households).where(and(eq(households.id, householdId), eq(households.eventId, eventId)));
    if (!h) throw new RetentionError("not_found");
    const [open] = await tx
      .select()
      .from(guestErasureRequests)
      .where(and(eq(guestErasureRequests.eventId, eventId), eq(guestErasureRequests.householdId, householdId), isNull(guestErasureRequests.processedAt)));
    if (open) return open;
    const note = input.note?.trim().slice(0, 500) || null;
    const [req] = await tx
      .insert(guestErasureRequests)
      .values({ eventId, householdId, householdName: h.name, requestedAt: input.requestedAt ?? new Date(), note, recordedBy: actor.userId })
      .returning();
    await audit(tx, { eventId, actor, action: "erasure.requested", entityType: "household", entityId: householdId, data: { name: h.name } });
    return req;
  });
}

/**
 * Erases the family: deletes the household (members, invitations, RSVPs, travel, rooms, seats …
 * by cascade; gifts are kept anonymised), queues their stored files
 * (`events/<eid>/households/<hid>/`) for deletion and marks the request processed.
 */
export async function processErasureRequest(db: Database, eventId: string, requestId: string, actor: Actor, now = new Date()): Promise<GuestErasureRequest> {
  const [req] = await db.select().from(guestErasureRequests).where(and(eq(guestErasureRequests.id, requestId), eq(guestErasureRequests.eventId, eventId)));
  if (!req) throw new RetentionError("not_found");
  if (req.processedAt) throw new RetentionError("already_processed");
  const householdId = req.householdId;
  if (householdId) {
    try {
      await deleteHousehold(db, eventId, householdId, actor);
    } catch (e) {
      if (!(e instanceof GuestError && e.code === "not_found")) throw e;
    }
  }
  // deleteHousehold queued the family's storage prefix (`events/<eid>/households/<hid>/`).
  return db.transaction(async (tx) => {
    const [done] = await tx
      .update(guestErasureRequests)
      .set({ processedAt: now, processedBy: actor.userId, householdId: null })
      .where(and(eq(guestErasureRequests.id, requestId), isNull(guestErasureRequests.processedAt)))
      .returning();
    if (!done) throw new RetentionError("already_processed");
    await audit(tx, { eventId, actor, action: "erasure.processed", entityType: "erasure_request", entityId: done.id, data: { name: done.householdName } });
    return done;
  });
}

export async function listErasureRequests(db: Tx, eventId: string) {
  return db
    .select({ request: guestErasureRequests, recordedByName: users.name })
    .from(guestErasureRequests)
    .leftJoin(users, eq(users.id, guestErasureRequests.recordedBy))
    .where(eq(guestErasureRequests.eventId, eventId))
    .orderBy(desc(guestErasureRequests.createdAt))
    .limit(200);
}

export async function openErasureRequest(db: Tx, eventId: string, householdId: string) {
  const [row] = await db
    .select()
    .from(guestErasureRequests)
    .where(and(eq(guestErasureRequests.eventId, eventId), eq(guestErasureRequests.householdId, householdId), isNull(guestErasureRequests.processedAt)));
  return row ?? null;
}
