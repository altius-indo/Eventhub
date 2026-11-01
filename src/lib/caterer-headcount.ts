import { and, asc, eq, inArray, isNotNull, isNull, lte, ne } from "drizzle-orm";
import type { Database, Tx } from "@/db";
import {
  bookings,
  catererHeadcountState,
  eventMembers,
  events,
  fulfilments,
  functions,
  requirements,
  serviceTypes,
  services,
  type HeadcountSnapshot,
} from "@/db/schema";
import { audit, type Actor } from "./audit";
import { notify } from "./notifications";
import { headcounts, type Headcount } from "./rsvp";
import { vendorUserIds } from "./vendor-access";
import { wallClockNow } from "./wall-clock";

/**
 * Caterer live headcount (RSV-06) and the final-guarantee lock (RSV-07), ADR-0028.
 *
 * A vendor with a confirmed booking on a Catering service sees an aggregate headcount for the
 * functions that booking covers, and only those: never names, phones or other personal data.
 * `caterer_headcount_state` holds, per (booking, function), the count the caterer last saw or
 * acknowledged (the alert baseline) and the lock: from `lock_at` the count shown to the caterer
 * is frozen in `locked_snapshot`, and the team sees later RSVP changes as a delta until they
 * release an updated final count.
 */

export class HeadcountError extends Error {
  constructor(public code: "not_found" | "not_locked" | "invalid") {
    super(code);
  }
}

export const CATERING_KEY = "catering";
/** Suggested final-guarantee time: this long before the function starts. */
export const DEFAULT_LOCK_HOURS = 72;

// ---------------------------------------------------------------------------
// Snapshots and thresholds
// ---------------------------------------------------------------------------

export function emptySnapshot(): HeadcountSnapshot {
  return { confirmed: 0, maybe: 0, pending: 0, adults: 0, children: 0, infants: 0, diet: { veg: 0, non_veg: 0, jain: 0, vegan: 0, other: 0, unknown: 0 }, allergies: 0 };
}

/** Aggregate numbers only. Ages, meals and allergies are of confirmed guests (as in RSV-05). */
export function snapshotFrom(h: Headcount | undefined): HeadcountSnapshot {
  if (!h) return emptySnapshot();
  return {
    confirmed: h.attending,
    maybe: h.maybe,
    pending: h.pending,
    adults: h.attendingBy.age.adult,
    children: h.attendingBy.age.child,
    infants: h.attendingBy.age.infant,
    diet: { ...h.attendingBy.diet },
    allergies: h.attendingBy.allergies,
  };
}

/** Expected attendees: confirmed plus maybe. */
export const snapshotTotal = (s: HeadcountSnapshot) => s.confirmed + s.maybe;

/** A change triggers an alert at ±abs guests or ±pct% of the previous count, whichever comes first. */
export function alertDue(from: number, to: number, pct: number, abs: number): boolean {
  const d = Math.abs(to - from);
  if (d === 0) return false;
  return d >= abs || (from > 0 && d * 100 >= pct * from);
}

/** An event-local date and time ("YYYY-MM-DD", "HH:MM[:SS]") as an instant. */
export function zonedInstant(date: string, time: string, timeZone: string): Date {
  const [h, m] = time.split(":").map(Number);
  const guess = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h || 0, m || 0));
  const offset = wallClockNow(timeZone, guess).getTime() - guess.getTime();
  return new Date(guess.getTime() - offset);
}

/** An instant as "YYYY-MM-DDTHH:MM" in the event's timezone (for datetime-local inputs). */
export const localInput = (d: Date, timeZone: string) => wallClockNow(timeZone, d).toISOString().slice(0, 16);

/** "72 h before the function starts", or null when the function has no date. */
export function suggestedLockAt(fn: { date: string | null; startTime: string | null }, timeZone: string): Date | null {
  if (!fn.date) return null;
  return new Date(zonedInstant(fn.date, fn.startTime ?? "00:00", timeZone).getTime() - DEFAULT_LOCK_HOURS * 3_600_000);
}

// ---------------------------------------------------------------------------
// Which (booking, function) pairs are catering
// ---------------------------------------------------------------------------

export type CateringPair = {
  eventId: string;
  bookingId: string;
  bookingCreatedAt: Date;
  vendorId: string;
  functionId: string;
  functionName: string;
  functionDate: string | null;
  startTime: string | null;
  /** Owners of the catering services involved (to notify). */
  ownerUserIds: string[];
  /** This booking's contracted quantity vs the requirements' quantity (split bookings). */
  share: { quantity: number; of: number } | null;
};

/** Live fulfilments on Catering services, grouped per (booking, function). */
export async function cateringPairs(
  db: Tx,
  opts: { eventId?: string; vendorId?: string; bookingId?: string; functionId?: string; includePending?: boolean },
): Promise<CateringPair[]> {
  const rows = await db
    .select({
      eventId: bookings.eventId,
      bookingId: bookings.id,
      bookingCreatedAt: bookings.createdAt,
      vendorId: bookings.vendorId,
      functionId: functions.id,
      functionName: functions.name,
      functionDate: functions.date,
      startTime: functions.startTime,
      ownerUserId: services.ownerUserId,
      fQty: fulfilments.quantity,
      requirementId: fulfilments.requirementId,
      rQty: requirements.quantity,
    })
    .from(fulfilments)
    .innerJoin(bookings, eq(bookings.id, fulfilments.bookingId))
    .innerJoin(services, eq(services.id, fulfilments.serviceId))
    .innerJoin(serviceTypes, eq(serviceTypes.id, services.serviceTypeId))
    .innerJoin(functions, eq(functions.id, services.functionId))
    .innerJoin(events, eq(events.id, bookings.eventId))
    .leftJoin(requirements, eq(requirements.id, fulfilments.requirementId))
    .where(
      and(
        opts.eventId ? eq(bookings.eventId, opts.eventId) : undefined,
        opts.vendorId ? eq(bookings.vendorId, opts.vendorId) : undefined,
        opts.bookingId ? eq(bookings.id, opts.bookingId) : undefined,
        opts.functionId ? eq(functions.id, opts.functionId) : undefined,
        opts.includePending ? ne(bookings.status, "cancelled") : eq(bookings.status, "confirmed"),
        isNull(fulfilments.cancelledAt),
        isNull(services.cancelledAt),
        isNull(events.deletedAt),
        eq(serviceTypes.systemKey, CATERING_KEY),
      ),
    )
    .orderBy(asc(functions.date), asc(functions.startTime), asc(bookings.createdAt));
  const out = new Map<string, CateringPair & { reqs: Map<string, { mine: number; of: number }> }>();
  for (const r of rows) {
    const key = `${r.bookingId}:${r.functionId}`;
    let p = out.get(key);
    if (!p) {
      p = { ...r, ownerUserIds: [], share: null, reqs: new Map() };
      out.set(key, p);
    }
    if (r.ownerUserId && !p.ownerUserIds.includes(r.ownerUserId)) p.ownerUserIds.push(r.ownerUserId);
    if (r.requirementId && r.rQty != null) {
      const prev = p.reqs.get(r.requirementId) ?? { mine: 0, of: r.rQty };
      prev.mine += r.fQty ?? r.rQty;
      p.reqs.set(r.requirementId, prev);
    }
  }
  return [...out.values()].map(({ reqs, ...p }) => {
    const parts = [...reqs.values()];
    return { ...p, share: parts.length ? { quantity: parts.reduce((a, x) => a + x.mine, 0), of: parts.reduce((a, x) => a + x.of, 0) } : null };
  });
}

/** Functions a vendor sees a headcount for (confirmed catering bookings), one row per function. */
export async function catererFunctions(db: Tx, eventId: string, vendorId: string) {
  const pairs = await cateringPairs(db, { eventId, vendorId });
  const seen = new Set<string>();
  return pairs.filter((p) => (seen.has(p.functionId) ? false : (seen.add(p.functionId), true)));
}

async function stateOf(db: Tx, bookingId: string, functionId: string) {
  const [s] = await db
    .select()
    .from(catererHeadcountState)
    .where(and(eq(catererHeadcountState.bookingId, bookingId), eq(catererHeadcountState.functionId, functionId)));
  return s ?? null;
}

async function ensureState(db: Tx, eventId: string, bookingId: string, functionId: string) {
  await db.insert(catererHeadcountState).values({ eventId, bookingId, functionId }).onConflictDoNothing();
  return (await stateOf(db, bookingId, functionId))!;
}

async function teamOwners(db: Tx, eventId: string, userIds: string[]) {
  if (userIds.length === 0) return [];
  const rows = await db
    .select({ userId: eventMembers.userId })
    .from(eventMembers)
    .where(and(eq(eventMembers.eventId, eventId), inArray(eventMembers.userId, userIds)));
  return rows.map((r) => r.userId);
}

// ---------------------------------------------------------------------------
// Lock (RSV-07)
// ---------------------------------------------------------------------------

/**
 * Freezes the headcount of locks that are due (lock_at reached, not yet frozen). Called before
 * RSVP writes, when the headcount is read and by the daily job, so a post-lock answer never
 * lands in the frozen count. Returns how many locks were frozen.
 */
export async function freezeDueLocks(tx: Tx, eventId: string, functionIds: string[] | null, now = new Date()) {
  if (functionIds && functionIds.length === 0) return 0;
  const due = await tx
    .select({ state: catererHeadcountState, functionName: functions.name, vendorId: bookings.vendorId })
    .from(catererHeadcountState)
    .innerJoin(functions, eq(functions.id, catererHeadcountState.functionId))
    .innerJoin(bookings, eq(bookings.id, catererHeadcountState.bookingId))
    .where(
      and(
        eq(catererHeadcountState.eventId, eventId),
        functionIds ? inArray(catererHeadcountState.functionId, functionIds) : undefined,
        isNotNull(catererHeadcountState.lockAt),
        lte(catererHeadcountState.lockAt, now),
        isNull(catererHeadcountState.frozenAt),
        ne(bookings.status, "cancelled"),
      ),
    );
  if (due.length === 0) return 0;
  const hc = await headcounts(tx, eventId);
  let n = 0;
  for (const d of due) {
    const snap = snapshotFrom(hc.get(d.state.functionId));
    const res = await tx
      .update(catererHeadcountState)
      .set({ lockedSnapshot: snap, frozenAt: now })
      .where(and(eq(catererHeadcountState.bookingId, d.state.bookingId), eq(catererHeadcountState.functionId, d.state.functionId), isNull(catererHeadcountState.frozenAt)))
      .returning({ bookingId: catererHeadcountState.bookingId });
    if (res.length === 0) continue;
    n++;
    await notify(tx, {
      eventId,
      userIds: await vendorUserIds(tx, [d.vendorId]),
      kind: "headcount.locked",
      data: { function: d.functionName, total: snapshotTotal(snap) },
      href: `/vendor/${d.vendorId}/headcount/${d.state.functionId}`,
    });
  }
  return n;
}

/** Due locks across all events (daily job). */
export async function freezeAllDueLocks(db: Database, now = new Date()) {
  const rows = await db
    .selectDistinct({ eventId: catererHeadcountState.eventId })
    .from(catererHeadcountState)
    .where(and(isNotNull(catererHeadcountState.lockAt), lte(catererHeadcountState.lockAt, now), isNull(catererHeadcountState.frozenAt)));
  let n = 0;
  for (const r of rows) n += await db.transaction((tx) => freezeDueLocks(tx, r.eventId, null, now));
  return n;
}

/**
 * Sets (or clears, with null) the final-guarantee time of a catering booking for a function.
 * Moving the time drops an existing freeze; a time already passed freezes at once.
 */
export async function setHeadcountLock(db: Database, input: { eventId: string; actor: Actor; bookingId: string; functionId: string; lockAt: Date | null; now?: Date }) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [pair] = await cateringPairs(tx, { eventId: input.eventId, bookingId: input.bookingId, functionId: input.functionId, includePending: true });
    if (!pair) throw new HeadcountError("not_found");
    await ensureState(tx, input.eventId, input.bookingId, input.functionId);
    await tx
      .update(catererHeadcountState)
      .set({ lockAt: input.lockAt, lockedSnapshot: null, frozenAt: null, releasedAt: null, releasedBy: null })
      .where(and(eq(catererHeadcountState.bookingId, input.bookingId), eq(catererHeadcountState.functionId, input.functionId)));
    await audit(tx, {
      eventId: input.eventId,
      actor: input.actor,
      action: input.lockAt ? "headcount.lock_set" : "headcount.lock_cleared",
      entityType: "booking",
      entityId: input.bookingId,
      data: { function: pair.functionName },
    });
    if (input.lockAt) await freezeDueLocks(tx, input.eventId, [input.functionId], now);
    return stateOf(tx, input.bookingId, input.functionId);
  });
}

/** After the lock, the team releases an updated final count to the caterer (RSV-07). */
export async function releaseFinalCount(db: Database, input: { eventId: string; actor: Actor; bookingId: string; functionId: string; now?: Date }) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [pair] = await cateringPairs(tx, { eventId: input.eventId, bookingId: input.bookingId, functionId: input.functionId, includePending: true });
    if (!pair) throw new HeadcountError("not_found");
    const [s] = await tx
      .select()
      .from(catererHeadcountState)
      .where(and(eq(catererHeadcountState.bookingId, input.bookingId), eq(catererHeadcountState.functionId, input.functionId)))
      .for("update");
    if (!s?.frozenAt) throw new HeadcountError("not_locked");
    const snap = snapshotFrom((await headcounts(tx, input.eventId)).get(input.functionId));
    await tx
      .update(catererHeadcountState)
      .set({ lockedSnapshot: snap, releasedAt: now, releasedBy: input.actor.userId })
      .where(and(eq(catererHeadcountState.bookingId, input.bookingId), eq(catererHeadcountState.functionId, input.functionId)));
    await audit(tx, {
      eventId: input.eventId,
      actor: input.actor,
      action: "headcount.released",
      entityType: "booking",
      entityId: input.bookingId,
      data: { function: pair.functionName, total: snapshotTotal(snap) },
    });
    await notify(tx, {
      eventId: input.eventId,
      userIds: await vendorUserIds(tx, [pair.vendorId]),
      kind: "headcount.locked",
      data: { function: pair.functionName, total: snapshotTotal(snap) },
      href: `/vendor/${pair.vendorId}/headcount/${input.functionId}`,
    });
    return snap;
  });
}

// ---------------------------------------------------------------------------
// The caterer's view (vendor portal)
// ---------------------------------------------------------------------------

export type CatererView = {
  functionId: string;
  functionName: string;
  functionDate: string | null;
  startTime: string | null;
  /** What the caterer sees: the frozen count after the lock, else the live one. */
  snapshot: HeadcountSnapshot;
  total: number;
  frozen: boolean;
  lockAt: Date | null;
  releasedAt: Date | null;
  /** Change in expected attendees since the caterer last saw/acknowledged it (0 when frozen). */
  baselineTotal: number | null;
  change: number;
  ackedAt: Date | null;
  share: { quantity: number; of: number } | null;
};

/**
 * The aggregate headcount of one function for a caterer booked on it (404 otherwise).
 * Viewing it sets the alert baseline if there is none yet.
 */
export async function getCatererView(db: Database, eventId: string, vendorId: string, functionId: string, now = new Date()): Promise<CatererView> {
  return db.transaction(async (tx) => {
    const pairs = await cateringPairs(tx, { eventId, vendorId, functionId });
    if (pairs.length === 0) throw new HeadcountError("not_found");
    const p = pairs[0];
    await freezeDueLocks(tx, eventId, [functionId], now);
    const live = snapshotFrom((await headcounts(tx, eventId)).get(functionId));
    let s = await ensureState(tx, eventId, p.bookingId, functionId);
    const frozen = !!(s.frozenAt && s.lockedSnapshot);
    const shown = frozen ? s.lockedSnapshot! : live;
    if (s.baselineTotal == null) {
      [s] = await tx
        .update(catererHeadcountState)
        .set({ baseline: shown, baselineTotal: snapshotTotal(shown), baselineAt: now })
        .where(and(eq(catererHeadcountState.bookingId, p.bookingId), eq(catererHeadcountState.functionId, functionId)))
        .returning();
    }
    const quantity = pairs.reduce((a, x) => a + (x.share?.quantity ?? 0), 0);
    const of = pairs.reduce((a, x) => a + (x.share?.of ?? 0), 0);
    return {
      functionId,
      functionName: p.functionName,
      functionDate: p.functionDate,
      startTime: p.startTime,
      snapshot: shown,
      total: snapshotTotal(shown),
      frozen,
      lockAt: s.lockAt,
      releasedAt: s.releasedAt,
      baselineTotal: s.baselineTotal,
      change: frozen || s.baselineTotal == null ? 0 : snapshotTotal(shown) - s.baselineTotal,
      ackedAt: s.ackedAt,
      share: pairs.some((x) => x.share) ? { quantity, of } : null,
    };
  });
}

/** The caterer acknowledges the count it sees: that becomes the baseline for change alerts. */
export async function acknowledgeHeadcount(db: Database, input: { eventId: string; vendorId: string; functionId: string; actor: Actor; now?: Date }) {
  const now = input.now ?? new Date();
  const view = await getCatererView(db, input.eventId, input.vendorId, input.functionId, now);
  await db.transaction(async (tx) => {
    const pairs = await cateringPairs(tx, { eventId: input.eventId, vendorId: input.vendorId, functionId: input.functionId });
    for (const p of pairs) {
      await ensureState(tx, input.eventId, p.bookingId, input.functionId);
      await tx
        .update(catererHeadcountState)
        .set({ baseline: view.snapshot, baselineTotal: view.total, baselineAt: now, ackedAt: now, ackedBy: input.actor.userId, lastAlertedTotal: null })
        .where(and(eq(catererHeadcountState.bookingId, p.bookingId), eq(catererHeadcountState.functionId, input.functionId)));
    }
    await audit(tx, { eventId: input.eventId, actor: input.actor, action: "headcount.acknowledged", entityType: "function", entityId: input.functionId, data: { function: view.functionName, total: view.total } });
  });
  return view.total;
}

// ---------------------------------------------------------------------------
// Change alerts (RSV-06)
// ---------------------------------------------------------------------------

/**
 * Compares each confirmed catering booking's live count with the caterer's baseline and alerts
 * the caterer's logins and the service owners once per move past the event's threshold.
 * Frozen (locked) counts don't alert. Returns the number of alerts sent.
 */
export async function checkHeadcountAlerts(db: Database, now = new Date(), eventId?: string) {
  const pairs = await cateringPairs(db, { eventId });
  const byEvent = new Map<string, CateringPair[]>();
  for (const p of pairs) byEvent.set(p.eventId, [...(byEvent.get(p.eventId) ?? []), p]);
  let alerts = 0;
  for (const [evId, list] of byEvent) {
    alerts += await db.transaction(async (tx) => {
      await freezeDueLocks(tx, evId, null, now);
      const [ev] = await tx.select({ pct: events.headcountAlertPct, abs: events.headcountAlertAbs }).from(events).where(eq(events.id, evId));
      const hc = await headcounts(tx, evId);
      let n = 0;
      for (const p of list) {
        const s = await ensureState(tx, evId, p.bookingId, p.functionId);
        if (s.frozenAt) continue;
        const live = snapshotFrom(hc.get(p.functionId));
        const total = snapshotTotal(live);
        const where = and(eq(catererHeadcountState.bookingId, p.bookingId), eq(catererHeadcountState.functionId, p.functionId));
        if (s.baselineTotal == null) {
          await tx.update(catererHeadcountState).set({ baseline: live, baselineTotal: total, baselineAt: now }).where(where);
          continue;
        }
        if (!alertDue(s.baselineTotal, total, ev.pct, ev.abs)) continue;
        if (s.lastAlertedTotal != null && !alertDue(s.lastAlertedTotal, total, ev.pct, ev.abs)) continue;
        await tx.update(catererHeadcountState).set({ lastAlertedTotal: total }).where(where);
        const data = { function: p.functionName, from: s.baselineTotal, to: total };
        await notify(tx, { eventId: evId, userIds: await vendorUserIds(tx, [p.vendorId]), kind: "headcount.changed", data, href: `/vendor/${p.vendorId}/headcount/${p.functionId}` });
        await notify(tx, { eventId: evId, userIds: await teamOwners(tx, evId, p.ownerUserIds), kind: "headcount.changed", data, href: `/events/${evId}/vendors/bookings/${p.bookingId}` });
        n++;
      }
      return n;
    });
  }
  return alerts;
}

// ---------------------------------------------------------------------------
// The team's view on a catering booking (lock card)
// ---------------------------------------------------------------------------

export async function bookingHeadcountLocks(db: Database, eventId: string, bookingId: string, timeZone: string, now = new Date()) {
  return db.transaction(async (tx) => {
    const pairs = await cateringPairs(tx, { eventId, bookingId, includePending: true });
    if (pairs.length === 0) return [];
    await freezeDueLocks(tx, eventId, pairs.map((p) => p.functionId), now);
    const hc = await headcounts(tx, eventId);
    const out = [];
    for (const p of pairs) {
      const s = await stateOf(tx, bookingId, p.functionId);
      const live = snapshotFrom(hc.get(p.functionId));
      const locked = s?.frozenAt ? s.lockedSnapshot : null;
      out.push({
        functionId: p.functionId,
        functionName: p.functionName,
        functionDate: p.functionDate,
        lockAt: s?.lockAt ?? null,
        frozen: !!locked,
        releasedAt: s?.releasedAt ?? null,
        liveTotal: snapshotTotal(live),
        lockedTotal: locked ? snapshotTotal(locked) : null,
        delta: locked ? snapshotTotal(live) - snapshotTotal(locked) : null,
        suggestedLockAt: suggestedLockAt({ date: p.functionDate, startTime: p.startTime }, timeZone),
        share: p.share,
      });
    }
    return out;
  });
}
