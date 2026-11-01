import { and, asc, count, eq, inArray, max, ne, or, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Database, Tx } from "@/db";
import { functionInvites, functions, guests, households, rsvps, seatAssignments, seatingTables, type Guest, type Household, type SeatingTable } from "@/db/schema";
import { audit, type Actor } from "./audit";

export class SeatingError extends Error {
  constructor(public code: "not_found" | "not_invited") {
    super(code);
  }
}

export const tableSchema = z.object({
  name: z.string().trim().min(1).max(60),
  capacity: z.coerce.number().int().min(1).max(100),
});

async function checkFunction(tx: Tx, eventId: string, functionId: string) {
  const [f] = await tx.select({ id: functions.id }).from(functions).where(and(eq(functions.id, functionId), eq(functions.eventId, eventId)));
  if (!f) throw new SeatingError("not_found");
}

/** Adds `count` tables named "<prefix> N", continuing the numbering. */
export async function addTables(db: Database, eventId: string, functionId: string, opts: { count: number; capacity: number; prefix: string }) {
  return db.transaction(async (tx) => {
    await checkFunction(tx, eventId, functionId);
    // Continue after the highest sort order, so deleting "Table 2" doesn't create a second "Table 3".
    const [{ m }] = await tx.select({ m: max(seatingTables.sortOrder) }).from(seatingTables).where(eq(seatingTables.functionId, functionId));
    const n = m ?? 0;
    const k = Math.max(1, Math.min(100, Math.trunc(opts.count)));
    const cap = Math.max(1, Math.min(100, Math.trunc(opts.capacity)));
    await tx.insert(seatingTables).values(
      Array.from({ length: k }, (_, i) => ({ eventId, functionId, name: `${opts.prefix} ${n + i + 1}`.trim(), capacity: cap, sortOrder: (m ?? 0) + i + 1 })),
    );
    return k;
  });
}

export async function updateTable(db: Database, eventId: string, tableId: string, input: z.infer<typeof tableSchema>) {
  const [t] = await db
    .update(seatingTables)
    .set(input)
    .where(and(eq(seatingTables.id, tableId), eq(seatingTables.eventId, eventId)))
    .returning();
  if (!t) throw new SeatingError("not_found");
}

export async function deleteTable(db: Database, eventId: string, tableId: string, actor: Actor) {
  await db.transaction(async (tx) => {
    const [{ n }] = await tx.select({ n: count() }).from(seatAssignments).where(eq(seatAssignments.tableId, tableId));
    const [t] = await tx
      .delete(seatingTables)
      .where(and(eq(seatingTables.id, tableId), eq(seatingTables.eventId, eventId)))
      .returning();
    if (!t) throw new SeatingError("not_found");
    if (n > 0) await audit(tx, { eventId, actor, action: "seating_table.deleted", entityType: "seating_table", entityId: tableId, data: { name: t.name, seated: n } });
  });
}

/**
 * Seats guests at a table (moving them if already seated at this function).
 * Only guests invited to the function can be seated (also enforced by a foreign key).
 */
export async function seatGuests(db: Database, eventId: string, functionId: string, tableId: string, guestIds: string[]) {
  const ids = [...new Set(guestIds)];
  if (ids.length === 0) return 0;
  return db.transaction(async (tx) => {
    const [table] = await tx
      .select()
      .from(seatingTables)
      .where(and(eq(seatingTables.id, tableId), eq(seatingTables.functionId, functionId), eq(seatingTables.eventId, eventId)));
    if (!table) throw new SeatingError("not_found");
    const invited = await tx
      .select({ guestId: functionInvites.guestId })
      .from(functionInvites)
      .innerJoin(guests, eq(guests.id, functionInvites.guestId))
      .where(and(eq(functionInvites.functionId, functionId), eq(guests.eventId, eventId), inArray(functionInvites.guestId, ids)));
    if (invited.length !== ids.length) throw new SeatingError("not_invited");
    await tx
      .insert(seatAssignments)
      .values(ids.map((guestId) => ({ eventId, functionId, tableId, guestId })))
      .onConflictDoUpdate({ target: [seatAssignments.functionId, seatAssignments.guestId], set: { tableId } });
    return ids.length;
  });
}

/** Seats every member of a family who's invited and hasn't declined (SEAT-02: keep families together). */
export async function seatHousehold(db: Database, eventId: string, functionId: string, tableId: string, householdId: string) {
  const members = await db
    .select({ id: guests.id })
    .from(guests)
    .innerJoin(functionInvites, and(eq(functionInvites.guestId, guests.id), eq(functionInvites.functionId, functionId)))
    .leftJoin(rsvps, and(eq(rsvps.guestId, guests.id), eq(rsvps.functionId, functionId)))
    .where(and(eq(guests.householdId, householdId), eq(guests.eventId, eventId), or(isNull(rsvps.status), ne(rsvps.status, "declined"))));
  return seatGuests(
    db,
    eventId,
    functionId,
    tableId,
    members.map((m) => m.id),
  );
}

export async function unseat(db: Database, eventId: string, functionId: string, guestId: string) {
  await db
    .delete(seatAssignments)
    .where(and(eq(seatAssignments.eventId, eventId), eq(seatAssignments.functionId, functionId), eq(seatAssignments.guestId, guestId)));
}

type SeatGuest = Guest & { householdName: string; side: Household["side"]; rsvp: string | null };
export type TableView = SeatingTable & { guests: SeatGuest[]; seatsUsed: number };
export type SeatingWarning = { code: "over_capacity"; table: string } | { code: "household_split"; household: string } | { code: "declined_but_seated"; guest: string };

/**
 * The plan for a function. Infants don't take a seat; children do.
 * "Unassigned" = invited and not declined, not yet at a table.
 */
export async function seatingPlan(db: Tx, eventId: string, functionId: string) {
  await checkFunction(db, eventId, functionId);
  const tables = await db.select().from(seatingTables).where(eq(seatingTables.functionId, functionId)).orderBy(asc(seatingTables.sortOrder));
  const invited = await db
    .select({ guest: guests, householdName: households.name, side: households.side, rsvp: rsvps.status, tableId: seatAssignments.tableId })
    .from(functionInvites)
    .innerJoin(guests, eq(guests.id, functionInvites.guestId))
    .innerJoin(households, eq(households.id, guests.householdId))
    .leftJoin(rsvps, and(eq(rsvps.guestId, guests.id), eq(rsvps.functionId, functionId)))
    .leftJoin(seatAssignments, and(eq(seatAssignments.guestId, guests.id), eq(seatAssignments.functionId, functionId)))
    .where(and(eq(functionInvites.functionId, functionId), eq(guests.eventId, eventId)))
    .orderBy(asc(households.name), asc(guests.sortOrder));

  const toGuest = (r: (typeof invited)[number]): SeatGuest => ({ ...r.guest, householdName: r.householdName, side: r.side, rsvp: r.rsvp });
  const views: TableView[] = tables.map((t) => {
    const gs = invited.filter((r) => r.tableId === t.id).map(toGuest);
    return { ...t, guests: gs, seatsUsed: gs.filter((g) => g.ageGroup !== "infant").length };
  });
  const unassigned = invited.filter((r) => !r.tableId && r.rsvp !== "declined").map(toGuest);

  const warnings: SeatingWarning[] = [];
  for (const t of views) if (t.seatsUsed > t.capacity) warnings.push({ code: "over_capacity", table: t.name });
  const tablesByHousehold = new Map<string, { name: string; tables: Set<string> }>();
  for (const r of invited) {
    if (!r.tableId) continue;
    const e = tablesByHousehold.get(r.guest.householdId) ?? { name: r.householdName, tables: new Set<string>() };
    e.tables.add(r.tableId);
    tablesByHousehold.set(r.guest.householdId, e);
    if (r.rsvp === "declined") warnings.push({ code: "declined_but_seated", guest: r.guest.name });
  }
  for (const e of tablesByHousehold.values()) if (e.tables.size > 1) warnings.push({ code: "household_split", household: e.name });

  const seated = invited.filter((r) => r.tableId).length;
  return { tables: views, unassigned, warnings, seated, invited: invited.filter((r) => r.rsvp !== "declined").length };
}

/** Tables for a family's own page (only shown when the event shares seating with guests). */
export async function tablesForHousehold(db: Tx, eventId: string, householdId: string) {
  return db
    .selectDistinct({ functionId: seatAssignments.functionId, tableName: seatingTables.name, functionName: functions.name })
    .from(seatAssignments)
    .innerJoin(guests, eq(guests.id, seatAssignments.guestId))
    .innerJoin(seatingTables, eq(seatingTables.id, seatAssignments.tableId))
    .innerJoin(functions, eq(functions.id, seatAssignments.functionId))
    .where(and(eq(seatAssignments.eventId, eventId), eq(guests.householdId, householdId)));
}
