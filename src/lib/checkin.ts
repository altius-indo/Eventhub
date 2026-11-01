import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { Database, Tx } from "@/db";
import { checkIns, functionInvites, functions, guests, households, rsvps, users, type Guest, type Household, type RsvpStatus } from "@/db/schema";
import { audit, type Actor } from "./audit";
import { resolveGuestToken, resolvePassToken } from "./guest-links";

export class CheckInError extends Error {
  constructor(public code: "invalid_pass" | "wrong_event" | "function_not_found" | "not_invited" | "not_found") {
    super(code);
  }
}

export type CheckInMember = Guest & { invited: boolean; rsvp: RsvpStatus | null; checkedInAt: Date | null; checkedInBy: string | null };
export type CheckInHousehold = { household: Household; members: CheckInMember[] };

async function checkFunction(db: Tx, eventId: string, functionId: string) {
  const [f] = await db.select().from(functions).where(and(eq(functions.id, functionId), eq(functions.eventId, eventId)));
  if (!f) throw new CheckInError("function_not_found");
  return f;
}

/** Pulls a token out of whatever the scanner read: a /c/ pass URL, a legacy /g/ link URL, or a bare token. */
export function extractToken(raw: string): { token: string; kind: "pass" | "link" | "unknown" } | null {
  const s = raw.trim();
  const m = s.match(/\/(c|g)\/([A-Za-z0-9_-]{44})(?:[/?#]|$)/);
  if (m) return { token: m[2], kind: m[1] === "c" ? "pass" : "link" };
  if (/^[A-Za-z0-9_-]{44}$/.test(s)) return { token: s, kind: "unknown" };
  return null;
}

async function membersFor(db: Tx, functionId: string, householdIds: string[]): Promise<Map<string, CheckInMember[]>> {
  if (householdIds.length === 0) return new Map();
  const rows = await db
    .select({
      guest: guests,
      invited: sql<boolean>`${functionInvites.guestId} is not null`,
      rsvp: rsvps.status,
      checkedInAt: checkIns.checkedInAt,
      checkedInBy: users.name,
    })
    .from(guests)
    .leftJoin(functionInvites, and(eq(functionInvites.guestId, guests.id), eq(functionInvites.functionId, functionId)))
    .leftJoin(rsvps, and(eq(rsvps.guestId, guests.id), eq(rsvps.functionId, functionId)))
    .leftJoin(checkIns, and(eq(checkIns.guestId, guests.id), eq(checkIns.functionId, functionId)))
    .leftJoin(users, eq(users.id, checkIns.checkedInBy))
    .where(inArray(guests.householdId, householdIds))
    .orderBy(asc(guests.sortOrder), asc(guests.createdAt));
  const out = new Map<string, CheckInMember[]>();
  for (const r of rows) {
    const list = out.get(r.guest.householdId) ?? [];
    list.push({ ...r.guest, invited: r.invited, rsvp: r.rsvp, checkedInAt: r.checkedInAt, checkedInBy: r.checkedInBy });
    out.set(r.guest.householdId, list);
  }
  return out;
}

/** Resolves a scanned pass to the family and their status for this function (SEAT-03). */
export async function lookupPass(db: Tx, eventId: string, functionId: string, raw: string): Promise<CheckInHousehold> {
  await checkFunction(db, eventId, functionId);
  const t = extractToken(raw);
  if (!t) throw new CheckInError("invalid_pass");
  const resolved = (t.kind !== "link" ? await resolvePassToken(db, t.token) : null) ?? (t.kind !== "pass" ? await resolveGuestToken(db, t.token) : null);
  if (!resolved) throw new CheckInError("invalid_pass");
  if (resolved.event.id !== eventId) throw new CheckInError("wrong_event");
  const members = (await membersFor(db, functionId, [resolved.household.id])).get(resolved.household.id) ?? [];
  return { household: resolved.household, members };
}

/** Manual fallback: search by guest name, family name or the last digits of a phone number. */
export async function searchForCheckIn(db: Tx, eventId: string, functionId: string, q: string): Promise<CheckInHousehold[]> {
  await checkFunction(db, eventId, functionId);
  const query = q.trim().slice(0, 60);
  if (query.length < 2) return [];
  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const digits = query.replace(/\D/g, "");
  const matches = await db
    .selectDistinct({ id: households.id, name: households.name })
    .from(guests)
    .innerJoin(households, eq(households.id, guests.householdId))
    .where(
      and(
        eq(guests.eventId, eventId),
        or(ilike(guests.name, pattern), ilike(households.name, pattern), digits.length >= 4 ? sql`${guests.phone} like ${`%${digits}`}` : undefined),
      ),
    )
    .orderBy(asc(households.name))
    .limit(20);
  if (matches.length === 0) return [];
  const hh = await db
    .select()
    .from(households)
    .where(
      inArray(
        households.id,
        matches.map((m) => m.id),
      ),
    )
    .orderBy(asc(households.name));
  const members = await membersFor(
    db,
    functionId,
    hh.map((h) => h.id),
  );
  return hh.map((household) => ({ household, members: members.get(household.id) ?? [] }));
}

export type CheckInItem = { guestId: string; at?: Date; source: "scan" | "manual" | "walk_in" };

/**
 * Marks guests as arrived. Idempotent: a guest already checked in for this function is
 * reported as `alreadyIn`, never counted twice, so retries and two gates are safe.
 */
export async function checkIn(
  db: Database,
  eventId: string,
  functionId: string,
  actor: Actor,
  items: CheckInItem[],
  opts: { allowUninvited?: boolean; now?: Date } = {},
): Promise<{ created: string[]; alreadyIn: string[] }> {
  const unique = [...new Map(items.map((i) => [i.guestId, i])).values()];
  if (unique.length === 0) return { created: [], alreadyIn: [] };
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    await checkFunction(tx, eventId, functionId);
    const ids = unique.map((i) => i.guestId);
    const found = await tx
      .select({ id: guests.id, invited: sql<boolean>`${functionInvites.guestId} is not null` })
      .from(guests)
      .leftJoin(functionInvites, and(eq(functionInvites.guestId, guests.id), eq(functionInvites.functionId, functionId)))
      .where(and(eq(guests.eventId, eventId), inArray(guests.id, ids)));
    if (found.length !== ids.length) throw new CheckInError("not_found");
    const invited = new Map(found.map((f) => [f.id, f.invited]));
    if (!opts.allowUninvited && found.some((f) => !f.invited)) throw new CheckInError("not_invited");
    // Device time is accepted for queued check-ins, but never in the future or older than a day.
    const clamp = (d?: Date) => (!d || d > now || now.getTime() - d.getTime() > 86_400_000 ? now : d);
    const inserted = await tx
      .insert(checkIns)
      .values(
        unique.map((i) => ({
          eventId,
          functionId,
          guestId: i.guestId,
          checkedInAt: clamp(i.at),
          checkedInBy: actor.userId,
          source: i.source,
          uninvited: !invited.get(i.guestId),
        })),
      )
      .onConflictDoNothing()
      .returning({ guestId: checkIns.guestId });
    const created = new Set(inserted.map((r) => r.guestId));
    return { created: ids.filter((id) => created.has(id)), alreadyIn: ids.filter((id) => !created.has(id)) };
  });
}

export async function undoCheckIn(db: Database, eventId: string, functionId: string, guestId: string, actor: Actor) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(checkIns)
      .where(and(eq(checkIns.eventId, eventId), eq(checkIns.functionId, functionId), eq(checkIns.guestId, guestId)))
      .returning();
    if (!row) throw new CheckInError("not_found");
    const [g] = await tx.select({ name: guests.name }).from(guests).where(eq(guests.id, guestId));
    await audit(tx, { eventId, actor, action: "checkin.undone", entityType: "guest", entityId: guestId, data: { name: g?.name ?? "" } });
  });
}

/**
 * Someone at the gate who isn't on the list: creates a family (tagged "walk-in") with
 * `count` people, invites them to this function and checks them in.
 */
export async function addWalkIn(
  db: Database,
  eventId: string,
  functionId: string,
  actor: Actor,
  input: { name: string; side: Household["side"]; count: number },
) {
  const name = input.name.trim().slice(0, 120);
  const n = Math.max(1, Math.min(20, Math.trunc(input.count)));
  if (!name) throw new CheckInError("not_found");
  const ids = await db.transaction(async (tx) => {
    await checkFunction(tx, eventId, functionId);
    const [h] = await tx.insert(households).values({ eventId, name, side: input.side, notes: "Walk-in" }).returning();
    const members = await tx
      .insert(guests)
      .values(Array.from({ length: n }, (_, i) => ({ eventId, householdId: h.id, name: i === 0 ? name : `${name} +${i}`, isHead: i === 0, sortOrder: i, tags: ["walk-in"] })))
      .returning({ id: guests.id });
    await tx.insert(functionInvites).values(members.map((m) => ({ functionId, guestId: m.id })));
    return members.map((m) => m.id);
  });
  return checkIn(
    db,
    eventId,
    functionId,
    actor,
    ids.map((guestId) => ({ guestId, source: "walk_in" as const })),
  );
}

export type CheckInCounts = {
  expected: number;
  maybe: number;
  noReply: number;
  arrived: number;
  arrivedExpected: number;
  arrivedUninvited: number;
  walkIns: number;
  arrivedBySide: { bride: number; groom: number; both: number };
  arrivedByAge: { adult: number; child: number; infant: number };
};

/** Live counts for the gate (expected = replied "attending"). One query. */
export async function checkInCounts(db: Tx, eventId: string, functionId: string): Promise<CheckInCounts> {
  const [r] = await db
    .select({
      expected: sql<number>`count(*) filter (where ${rsvps.status} = 'attending')::int`,
      maybe: sql<number>`count(*) filter (where ${rsvps.status} = 'maybe')::int`,
      noReply: sql<number>`count(*) filter (where ${functionInvites.guestId} is not null and ${rsvps.status} is null and ${checkIns.source} is distinct from 'walk_in')::int`,
      arrived: sql<number>`count(${checkIns.guestId})::int`,
      arrivedExpected: sql<number>`count(${checkIns.guestId}) filter (where ${rsvps.status} = 'attending')::int`,
      arrivedUninvited: sql<number>`count(*) filter (where ${checkIns.uninvited} and ${checkIns.source} <> 'walk_in')::int`,
      walkIns: sql<number>`count(*) filter (where ${checkIns.source} = 'walk_in')::int`,
      bride: sql<number>`count(${checkIns.guestId}) filter (where ${households.side} = 'bride')::int`,
      groom: sql<number>`count(${checkIns.guestId}) filter (where ${households.side} = 'groom')::int`,
      both: sql<number>`count(${checkIns.guestId}) filter (where ${households.side} = 'both')::int`,
      adult: sql<number>`count(${checkIns.guestId}) filter (where ${guests.ageGroup} = 'adult')::int`,
      child: sql<number>`count(${checkIns.guestId}) filter (where ${guests.ageGroup} = 'child')::int`,
      infant: sql<number>`count(${checkIns.guestId}) filter (where ${guests.ageGroup} = 'infant')::int`,
    })
    .from(guests)
    .innerJoin(households, eq(households.id, guests.householdId))
    .leftJoin(functionInvites, and(eq(functionInvites.guestId, guests.id), eq(functionInvites.functionId, functionId)))
    .leftJoin(rsvps, and(eq(rsvps.guestId, guests.id), eq(rsvps.functionId, functionId)))
    .leftJoin(checkIns, and(eq(checkIns.guestId, guests.id), eq(checkIns.functionId, functionId)))
    .where(and(eq(guests.eventId, eventId), sql`(${functionInvites.guestId} is not null or ${checkIns.guestId} is not null)`));
  return {
    expected: r.expected,
    maybe: r.maybe,
    noReply: r.noReply,
    arrived: r.arrived,
    arrivedExpected: r.arrivedExpected,
    arrivedUninvited: r.arrivedUninvited,
    walkIns: r.walkIns,
    arrivedBySide: { bride: r.bride, groom: r.groom, both: r.both },
    arrivedByAge: { adult: r.adult, child: r.child, infant: r.infant },
  };
}

export async function recentCheckIns(db: Tx, eventId: string, functionId: string, limit = 10) {
  return db
    .select({ guestId: checkIns.guestId, name: guests.name, householdName: households.name, at: checkIns.checkedInAt, by: users.name, source: checkIns.source })
    .from(checkIns)
    .innerJoin(guests, eq(guests.id, checkIns.guestId))
    .innerJoin(households, eq(households.id, guests.householdId))
    .leftJoin(users, eq(users.id, checkIns.checkedInBy))
    .where(and(eq(checkIns.eventId, eventId), eq(checkIns.functionId, functionId)))
    .orderBy(desc(checkIns.checkedInAt))
    .limit(limit);
}
