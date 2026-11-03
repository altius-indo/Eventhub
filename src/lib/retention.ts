import { and, desc, eq, inArray, isNotNull, isNull, lte, max, min, or, sql } from "drizzle-orm";
import type { Database, Tx } from "@/db";
import {
  auditLogs,
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
  outboundMessages,
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
import { eventPrefix, getStore } from "./storage";
import { queueStorageDeletion, runStorageDeletions } from "./storage-gc";
import { free } from "./storage-quota";
import { todayIn } from "./tasks";
import { resolveAppUrl } from "@/lib/app-url";

/**
 * Data retention and deletion (EVT-07, EVT-08, EVT-09; ADR-0033).
 *
 * - The clock starts at the event's last function; data is deleted 1 year later (on the
 *   deletion date, in the event's timezone). Without function dates the event's end date is used;
 *   with neither, the data goes 2 years after the event was created (fallback, flagged in the
 *   admin list).
 * - Hosts are reminded 60, 30 and 7 days before; vendors are told to download their records.
 * - Nothing is deleted unless Hosts were warned at least 7 days earlier: if no reminder went out
 *   for the current deletion date (job down, dates changed late), the purge sends the notice and
 *   deletes 7 days later instead.
 * - Purging writes anonymised counts to `event_metrics`, queues the event's storage prefix for
 *   deletion and hard-deletes the event (every event-owned table cascades).
 */

export const REMINDER_DAYS = [60, 30, 7] as const;
/** Minimum days between the first deletion notice and the purge (EVT-08). */
export const FINAL_NOTICE_DAYS = 7;
/** Events with no dates at all are deleted this many years after they were created. */
export const FALLBACK_YEARS = 2;

/** `YYYY-MM-DD` + n years. 29 Feb rolls to 1 Mar, so the period is never cut short. */
export function addYears(isoDate: string, years: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y + years, m - 1, d)).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` + 1 year. */
export function addOneYear(isoDate: string): string {
  return addYears(isoDate, 1);
}

const addDaysIso = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * The deletion date for an event: last function (else end date) + 1 year; with neither, the day
 * it was created (`createdDay`, event timezone) + 2 years; null only when that isn't given.
 */
export function deletionDateFor(lastFunctionDate: string | null, endDate: string | null, createdDay?: string | null): string | null {
  const start = lastFunctionDate ?? endDate;
  if (start) return addOneYear(start);
  return createdDay ? addYears(createdDay, FALLBACK_YEARS) : null;
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
  /** The event has no dates: the deletion date is the creation-date fallback (2 years). */
  fallback: boolean;
};

type RetentionEvent = Pick<Event, "endDate" | "timezone"> & { createdAt?: Date };

export async function lastFunctionDate(db: Tx, eventId: string): Promise<string | null> {
  const [row] = await db.select({ d: max(functions.date) }).from(functions).where(eq(functions.eventId, eventId));
  return row?.d ?? null;
}

export function retentionFor(event: RetentionEvent, lastFn: string | null, now = new Date()): RetentionInfo {
  const today = todayIn(event.timezone, now);
  const dated = lastFn ?? event.endDate;
  if (dated) {
    const deletionDate = addOneYear(dated);
    return { clockDate: dated, deletionDate, started: today > dated, daysLeft: dayNum(deletionDate) - dayNum(today), fallback: false };
  }
  if (!event.createdAt) return { clockDate: null, deletionDate: null, started: false, daysLeft: null, fallback: false };
  // No dates: the banner shows in the last year, like for a dated event.
  const created = todayIn(event.timezone, event.createdAt);
  const deletionDate = addYears(created, FALLBACK_YEARS);
  const clockDate = addYears(created, FALLBACK_YEARS - 1);
  return { clockDate, deletionDate, started: today > clockDate, daysLeft: dayNum(deletionDate) - dayNum(today), fallback: true };
}

/** Earliest deletion notice sent for this deletion date (null: none yet). */
async function firstNotice(db: Tx, eventId: string, deletionDate: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: min(retentionNotices.sentAt) })
    .from(retentionNotices)
    .where(and(eq(retentionNotices.eventId, eventId), eq(retentionNotices.deletionDate, deletionDate)));
  return row?.at ?? null;
}

/**
 * The day the data will really go: the deletion date, but never earlier than 7 days after the
 * first notice (if none was sent yet, 7 days from today at the earliest).
 */
function effectiveDeletion(deletionDate: string, today: string, noticeDay: string | null) {
  const earliest = addDaysIso(noticeDay ?? today, FINAL_NOTICE_DAYS);
  return deletionDate >= earliest ? deletionDate : earliest;
}

export async function getRetention(db: Tx, event: Pick<Event, "id" | "endDate" | "timezone"> & { createdAt?: Date }, now = new Date()) {
  const info = retentionFor(event, await lastFunctionDate(db, event.id), now);
  if (info.deletionDate && info.daysLeft != null && info.daysLeft < FINAL_NOTICE_DAYS) {
    // Late or missed notices push the deletion back (EVT-08); show the real date.
    const today = todayIn(event.timezone, now);
    const sent = await firstNotice(db, event.id, info.deletionDate);
    const date = effectiveDeletion(info.deletionDate, today, sent ? todayIn(event.timezone, sent) : null);
    return { ...info, deletionDate: date, daysLeft: dayNum(date) - dayNum(today) };
  }
  return info;
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
    .select({ id: events.id, endDate: events.endDate, timezone: events.timezone, createdAt: events.createdAt, lastFn: max(functions.date) })
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
export async function sendRetentionReminders(db: Database, now = new Date(), appUrl = resolveAppUrl()): Promise<number> {
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
        .values(due.map((days) => ({ eventId: event.id, days, deletionDate, sentAt: now })))
        .onConflictDoNothing()
        .returning({ days: retentionNotices.days });
      if (!claimed.some((c) => c.days === target)) return false;
      await remindEvent(tx, event, deletionDate, info.daysLeft!, target, base, deletionDate);
      return true;
    });
    if (did) sent++;
  }
  return sent;
}

/**
 * Notifies Hosts and vendor contacts. `deletionDate` is the date shown; `keyDate` the deletion date
 * the notice belongs to, part of the email idempotency key so restarted reminders (moved date) send.
 */
async function remindEvent(tx: Tx, event: Event, deletionDate: string, daysLeft: number, threshold: number, base: string, keyDate: string) {
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
      key: `retention:${event.id}:${keyDate}:${threshold}:${h.id}`,
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
      key: `retention:${event.id}:${keyDate}:${threshold}:v:${c.contact.id}`,
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

/**
 * Daily: hard-deletes events whose deletion date has arrived (event timezone), but only once
 * Hosts were warned at least 7 days earlier (EVT-08). When no notice went out for the current
 * deletion date (the job was down, the date moved, the event was set up late), this run sends the
 * 7-day notice instead and the event goes 7 days later. Returns how many events were purged.
 */
export async function purgeExpiredEvents(
  db: Database,
  now = new Date(),
  opts: { limit?: number; budgetMs?: number; appUrl?: string } = {},
): Promise<number> {
  const started = Date.now();
  const base = (opts.appUrl || resolveAppUrl()).replace(/\/$/, "");
  const due = (await eventsWithDates(db)).filter(({ event, lastFn }) => {
    const d = retentionFor(event, lastFn, now).deletionDate;
    return d != null && todayIn(event.timezone, now) >= d;
  });
  const limit = opts.limit ?? 20;
  let n = 0;
  for (const { event } of due) {
    if (n >= limit || (opts.budgetMs != null && Date.now() - started > opts.budgetMs)) break;
    const purged = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(events).where(and(eq(events.id, event.id), isNull(events.deletedAt))).for("update");
      if (!locked) return false;
      // Re-check under the lock: a function may have been added since.
      const lastFn = await lastFunctionDate(tx, locked.id);
      const d = retentionFor(locked, lastFn, now).deletionDate;
      const today = todayIn(locked.timezone, now);
      if (!d || today < d) return false;
      await tx.delete(retentionNotices).where(and(eq(retentionNotices.eventId, locked.id), sql`${retentionNotices.deletionDate} <> ${d}`));
      const sent = await firstNotice(tx, locked.id, d);
      if (!sent) {
        // Never warned for this date: warn now, delete in 7 days.
        await tx
          .insert(retentionNotices)
          .values(REMINDER_DAYS.map((days) => ({ eventId: locked.id, days, deletionDate: d, sentAt: now })))
          .onConflictDoNothing();
        const effective = effectiveDeletion(d, today, today);
        await remindEvent(tx, locked, effective, FINAL_NOTICE_DAYS, FINAL_NOTICE_DAYS, base, d);
        return false;
      }
      if (today < effectiveDeletion(d, today, todayIn(locked.timezone, sent))) return false;
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

/** What the erasure log shows once a family is erased: no name, just a reference (ADR-0033). */
export function erasedFamilyLabel(requestId: string) {
  return `Erased family #${requestId.slice(0, 8)}`;
}

/**
 * Erases the family, in one transaction (ADR-0033):
 * - deletes the household (members, invitations, RSVPs, travel, rooms, seats … by cascade; gifts
 *   stay, anonymised) and queues their stored files (`events/<eid>/households/<hid>/`);
 * - deletes documents attached to their gifts (photos of items), with their stored objects;
 * - deletes queued messages to them and blanks the address and text of sent ones;
 * - blanks `data` of audit rows about the household or its members (names, contact details);
 * - replaces the family's name in the request log with a neutral label and drops the note.
 */
export async function processErasureRequest(db: Database, eventId: string, requestId: string, actor: Actor, now = new Date()): Promise<GuestErasureRequest> {
  const queued: number[] = [];
  const done = await db.transaction(async (tx) => {
    const [req] = await tx
      .select()
      .from(guestErasureRequests)
      .where(and(eq(guestErasureRequests.id, requestId), eq(guestErasureRequests.eventId, eventId)))
      .for("update");
    if (!req) throw new RetentionError("not_found");
    if (req.processedAt) throw new RetentionError("already_processed");
    const householdId = req.householdId;
    const entityIds: string[] = [];
    const giftIds: string[] = [];
    if (householdId) {
      const guestIds = (await tx.select({ id: guests.id }).from(guests).where(and(eq(guests.householdId, householdId), eq(guests.eventId, eventId)))).map((g) => g.id);
      entityIds.push(householdId, ...guestIds);
      giftIds.push(...(await tx.select({ id: gifts.id }).from(gifts).where(and(eq(gifts.eventId, eventId), eq(gifts.householdId, householdId)))).map((g) => g.id));

      // Gift photos and other files attached to the family's gifts.
      const giftDocs = giftIds.length
        ? await tx
            .delete(documents)
            .where(and(eq(documents.eventId, eventId), inArray(documents.giftId, giftIds)))
            .returning()
        : [];
      // Their upload log rows carry the file name, which can name the family.
      entityIds.push(...giftDocs.map((d) => d.id));
      for (const doc of giftDocs) {
        await free(tx, eventId, doc.bytes);
        if (doc.storageKey) queued.push(await queueStorageDeletion(tx, doc.storageKey, "erasure"));
      }

      // Messages: nothing more goes out to them; sent ones keep only the delivery status.
      const toThem = or(eq(outboundMessages.householdId, householdId), guestIds.length ? inArray(outboundMessages.guestId, guestIds) : undefined);
      await tx.delete(outboundMessages).where(and(eq(outboundMessages.eventId, eventId), toThem, eq(outboundMessages.status, "queued")));
      await tx
        .update(outboundMessages)
        .set({ toAddress: "", vars: {}, guestId: null })
        .where(and(eq(outboundMessages.eventId, eventId), toThem));

      try {
        // Savepoint: a household that's already gone just skips this step.
        await deleteHousehold(tx as unknown as Database, eventId, householdId, actor);
      } catch (e) {
        if (!(e instanceof GuestError && e.code === "not_found")) throw e;
      }
    }
    const [row] = await tx
      .update(guestErasureRequests)
      .set({ processedAt: now, processedBy: actor.userId, householdId: null, householdName: erasedFamilyLabel(req.id), note: null })
      .where(and(eq(guestErasureRequests.id, requestId), isNull(guestErasureRequests.processedAt)))
      .returning();
    if (!row) throw new RetentionError("already_processed");
    // Audit rows stay (who did what, when) but lose what they said about the family.
    if (entityIds.length) {
      await tx
        .update(auditLogs)
        .set({ data: null })
        .where(and(eq(auditLogs.eventId, eventId), inArray(auditLogs.entityId, entityIds)));
    }
    // Their gifts' log rows keep amounts/changes but lose the giver's name.
    if (giftIds.length) {
      await tx
        .update(auditLogs)
        .set({ data: sql`${auditLogs.data} - 'name'` })
        .where(and(eq(auditLogs.eventId, eventId), eq(auditLogs.entityType, "gift"), inArray(auditLogs.entityId, giftIds)));
    }
    await audit(tx, { eventId, actor, action: "erasure.processed", entityType: "erasure_request", entityId: row.id, data: { name: row.householdName } });
    return row;
  });
  await runStorageDeletions(db, getStore(), queued).catch(() => undefined);
  return done;
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
