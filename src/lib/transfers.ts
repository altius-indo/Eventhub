import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, Tx } from "@/db";
import {
  functionInvites,
  functions,
  guests,
  guestTravel,
  households,
  transferKind,
  transferPassengers,
  transferRuns,
  type Guest,
  type GuestTravel,
  type Household,
  type TransferRun,
} from "@/db/schema";
import { audit, type Actor } from "./audit";
import { normalizePhone } from "./guests";
import { addMinutes, parseWallClock, wallClockDay } from "./wall-clock";

export class TransferError extends Error {
  constructor(public code: "not_found" | "over_capacity" | "guest_not_found" | "bad_function" | "phone_invalid" | "capacity_below_load" | "invalid") {
    super(code);
  }
}

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => v || null);

export const runSchema = z.object({
  kind: z.enum(transferKind.enumValues),
  functionId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal(""))
    .transform((v) => v || null),
  departsAt: z.string().transform((v, ctx) => {
    const d = parseWallClock(v);
    if (!d) ctx.addIssue({ code: "custom", message: "departsAt" });
    return d as Date;
  }),
  fromPlace: z.string().trim().min(1).max(160),
  toPlace: z.string().trim().min(1).max(160),
  vehicle: text(80),
  driverName: text(80),
  driverPhone: text(30),
  capacity: z.coerce.number().int().min(1).max(100),
  notes: text(500),
});
export type RunInput = z.infer<typeof runSchema>;

async function validateRun(tx: Tx, eventId: string, input: RunInput): Promise<RunInput> {
  if (input.functionId) {
    const [f] = await tx.select({ id: functions.id }).from(functions).where(and(eq(functions.id, input.functionId), eq(functions.eventId, eventId)));
    if (!f) throw new TransferError("bad_function");
  }
  let driverPhone = input.driverPhone;
  if (driverPhone) {
    const p = normalizePhone(driverPhone);
    if (p === "invalid") throw new TransferError("phone_invalid");
    driverPhone = p;
  }
  return { ...input, driverPhone };
}

async function lockRun(tx: Tx, eventId: string, runId: string): Promise<TransferRun> {
  const [run] = await tx
    .select()
    .from(transferRuns)
    .where(and(eq(transferRuns.id, runId), eq(transferRuns.eventId, eventId)))
    .for("update");
  if (!run) throw new TransferError("not_found");
  return run;
}

async function passengerCount(tx: Tx, runId: string) {
  const [{ n }] = await tx.select({ n: count() }).from(transferPassengers).where(eq(transferPassengers.runId, runId));
  return n;
}

export async function createRun(db: Database, eventId: string, input: RunInput) {
  return db.transaction(async (tx) => {
    const data = await validateRun(tx, eventId, input);
    const [run] = await tx.insert(transferRuns).values({ eventId, ...data }).returning();
    return run;
  });
}

export async function updateRun(db: Database, eventId: string, runId: string, input: RunInput) {
  return db.transaction(async (tx) => {
    await lockRun(tx, eventId, runId);
    const data = await validateRun(tx, eventId, input);
    if (data.capacity < (await passengerCount(tx, runId))) throw new TransferError("capacity_below_load");
    const [run] = await tx.update(transferRuns).set({ ...data, updatedAt: new Date() }).where(eq(transferRuns.id, runId)).returning();
    return run;
  });
}

export async function deleteRun(db: Database, eventId: string, runId: string, actor: Actor) {
  await db.transaction(async (tx) => {
    const run = await lockRun(tx, eventId, runId);
    const passengers = await passengerCount(tx, runId);
    await tx.delete(transferRuns).where(eq(transferRuns.id, runId));
    await audit(tx, {
      eventId,
      actor,
      action: "transfer.deleted",
      entityType: "transfer",
      entityId: runId,
      data: { kind: run.kind, from: run.fromPlace, to: run.toPlace, passengers },
    });
  });
}

/** Adds guests to a run, all or nothing. Vehicle capacity is a hard limit (row lock). */
export async function assignToRun(db: Database, eventId: string, runId: string, guestIds: string[]) {
  const ids = [...new Set(guestIds)];
  if (ids.length === 0) return 0;
  return db.transaction(async (tx) => {
    const run = await lockRun(tx, eventId, runId);
    const found = await tx
      .select({ id: guests.id })
      .from(guests)
      .where(and(eq(guests.eventId, eventId), inArray(guests.id, ids)));
    if (found.length !== ids.length) throw new TransferError("guest_not_found");
    const existing = new Set(
      (await tx.select({ id: transferPassengers.guestId }).from(transferPassengers).where(eq(transferPassengers.runId, runId))).map((r) => r.id),
    );
    const toAdd = ids.filter((id) => !existing.has(id));
    if (existing.size + toAdd.length > run.capacity) throw new TransferError("over_capacity");
    if (toAdd.length) await tx.insert(transferPassengers).values(toAdd.map((guestId) => ({ eventId, runId, guestId })));
    return toAdd.length;
  });
}

export async function unassignFromRun(db: Database, eventId: string, runId: string, guestId: string) {
  await db
    .delete(transferPassengers)
    .where(and(eq(transferPassengers.eventId, eventId), eq(transferPassengers.runId, runId), eq(transferPassengers.guestId, guestId)));
}

export async function getRun(db: Tx, eventId: string, runId: string) {
  const [run] = await db.select().from(transferRuns).where(and(eq(transferRuns.id, runId), eq(transferRuns.eventId, eventId)));
  if (!run) throw new TransferError("not_found");
  return run;
}

export async function listRuns(db: Tx, eventId: string) {
  return db
    .select({
      run: transferRuns,
      functionName: functions.name,
      passengers: sql<number>`(select count(*)::int from ${transferPassengers} tp where tp.run_id = ${transferRuns.id})`,
    })
    .from(transferRuns)
    .leftJoin(functions, eq(functions.id, transferRuns.functionId))
    .where(eq(transferRuns.eventId, eventId))
    .orderBy(asc(transferRuns.departsAt));
}

export type ManifestRow = { guest: Guest; household: Household; travel: GuestTravel | null; assignedAt: Date; contactPhone: string | null };

/** Passengers with their family, travel details and one contact phone per family. */
export async function getManifest(db: Tx, eventId: string, runId: string): Promise<ManifestRow[]> {
  const rows = await db
    .select({ guest: guests, household: households, travel: guestTravel, assignedAt: transferPassengers.createdAt })
    .from(transferPassengers)
    .innerJoin(guests, eq(guests.id, transferPassengers.guestId))
    .innerJoin(households, eq(households.id, guests.householdId))
    .leftJoin(guestTravel, eq(guestTravel.guestId, guests.id))
    .where(and(eq(transferPassengers.runId, runId), eq(transferPassengers.eventId, eventId)))
    .orderBy(asc(households.name), asc(guests.sortOrder));
  const phoneByHousehold = new Map<string, string>();
  for (const r of rows) if (r.guest.phone && (!phoneByHousehold.has(r.household.id) || r.guest.isHead)) phoneByHousehold.set(r.household.id, r.guest.phone);
  // Fall back to any family member's phone (they may not all be on this run).
  const missing = [...new Set(rows.map((r) => r.household.id))].filter((h) => !phoneByHousehold.has(h));
  if (missing.length) {
    const others = await db
      .select({ householdId: guests.householdId, phone: guests.phone, isHead: guests.isHead })
      .from(guests)
      .where(and(inArray(guests.householdId, missing), sql`${guests.phone} is not null`));
    for (const o of others.sort((a, b) => Number(b.isHead) - Number(a.isHead))) if (!phoneByHousehold.has(o.householdId)) phoneByHousehold.set(o.householdId, o.phone!);
  }
  return rows.map((r) => ({ ...r, contactPhone: phoneByHousehold.get(r.household.id) ?? null }));
}

export type RunWarning =
  | { code: "over_capacity" }
  | { code: "time_mismatch"; guestName: string }
  | { code: "travel_changed"; guestName: string }
  | { code: "no_driver_phone" };

/**
 * Warnings for a run: a pickup leaving before the guest lands, or more than 90 minutes after;
 * travel details changed by the guest after they were assigned; no driver phone.
 */
export function runWarnings(run: TransferRun, manifest: ManifestRow[]): RunWarning[] {
  const out: RunWarning[] = [];
  if (manifest.length > run.capacity) out.push({ code: "over_capacity" });
  if (run.kind !== "shuttle" && !run.driverPhone) out.push({ code: "no_driver_phone" });
  for (const m of manifest) {
    const t = run.kind === "pickup" ? m.travel?.arrivalAt : run.kind === "drop" ? m.travel?.departureAt : null;
    if (t) {
      const diff = (run.departsAt.getTime() - t.getTime()) / 60_000;
      // Pickup: leave between landing and 90 min after. Drop: leave 6h..1h before departure.
      const bad = run.kind === "pickup" ? diff < 0 || diff > 90 : diff > -60 || diff < -360;
      if (bad) out.push({ code: "time_mismatch", guestName: m.guest.name });
    }
    if (m.travel?.updatedByGuest && m.travel.updatedAt > m.assignedAt) out.push({ code: "travel_changed", guestName: m.guest.name });
  }
  return out;
}

export type BoardEntry = {
  guest: Guest;
  household: Household;
  travel: GuestTravel;
  at: Date;
  point: string | null;
  needs: boolean;
  runIds: string[];
};
export type BoardWindow = { start: Date; entries: BoardEntry[] };

/** Arrivals (or departures) on a day, grouped into time windows (TRV-03). */
export async function arrivalsBoard(
  db: Tx,
  eventId: string,
  opts: { date: string; windowMinutes: number; direction: "arrival" | "departure" },
): Promise<BoardWindow[]> {
  const col = opts.direction === "arrival" ? guestTravel.arrivalAt : guestTravel.departureAt;
  const start = new Date(`${opts.date}T00:00:00Z`);
  const end = addMinutes(start, 24 * 60);
  const rows = await db
    .select({ guest: guests, household: households, travel: guestTravel })
    .from(guestTravel)
    .innerJoin(guests, eq(guests.id, guestTravel.guestId))
    .innerJoin(households, eq(households.id, guests.householdId))
    .where(and(eq(guests.eventId, eventId), sql`${col} >= ${start.toISOString().slice(0, 19)}::timestamp and ${col} < ${end.toISOString().slice(0, 19)}::timestamp`))
    .orderBy(asc(col), asc(households.name), asc(guests.sortOrder));
  const runs = rows.length
    ? await db
        .select({ guestId: transferPassengers.guestId, runId: transferPassengers.runId, kind: transferRuns.kind })
        .from(transferPassengers)
        .innerJoin(transferRuns, eq(transferRuns.id, transferPassengers.runId))
        .where(
          and(
            eq(transferRuns.eventId, eventId),
            eq(transferRuns.kind, opts.direction === "arrival" ? "pickup" : "drop"),
            inArray(
              transferPassengers.guestId,
              rows.map((r) => r.guest.id),
            ),
          ),
        )
    : [];
  const windowMs = opts.windowMinutes * 60_000;
  const windows = new Map<number, BoardWindow>();
  for (const r of rows) {
    const at = (opts.direction === "arrival" ? r.travel.arrivalAt : r.travel.departureAt)!;
    const key = Math.floor((at.getTime() - start.getTime()) / windowMs);
    let w = windows.get(key);
    if (!w) {
      w = { start: new Date(start.getTime() + key * windowMs), entries: [] };
      windows.set(key, w);
    }
    w.entries.push({
      guest: r.guest,
      household: r.household,
      travel: r.travel,
      at,
      point: (opts.direction === "arrival" ? r.travel.arrivalPoint : r.travel.departurePoint) ?? null,
      needs: opts.direction === "arrival" ? r.travel.needsPickup : r.travel.needsDrop,
      runIds: runs.filter((x) => x.guestId === r.guest.id).map((x) => x.runId),
    });
  }
  return [...windows.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Days that have any arrivals or departures, for the board's day picker. */
export async function travelDays(db: Tx, eventId: string): Promise<string[]> {
  const rows = await db
    .select({ a: guestTravel.arrivalAt, d: guestTravel.departureAt })
    .from(guestTravel)
    .innerJoin(guests, eq(guests.id, guestTravel.guestId))
    .where(eq(guests.eventId, eventId));
  const days = new Set<string>();
  for (const r of rows) for (const d of [r.a, r.d]) if (d) days.add(wallClockDay(d));
  return [...days].sort();
}

/** A family's own runs, plus shuttles for functions they're invited to (ITN-04, TRV-06). */
export async function runsForHousehold(db: Tx, eventId: string, householdId: string) {
  const own = await db
    .select({ run: transferRuns, guestId: transferPassengers.guestId })
    .from(transferPassengers)
    .innerJoin(transferRuns, eq(transferRuns.id, transferPassengers.runId))
    .innerJoin(guests, eq(guests.id, transferPassengers.guestId))
    .where(and(eq(transferRuns.eventId, eventId), eq(guests.householdId, householdId)))
    .orderBy(asc(transferRuns.departsAt));
  const shuttles = await db
    .selectDistinct({ run: transferRuns })
    .from(transferRuns)
    .innerJoin(functionInvites, eq(functionInvites.functionId, transferRuns.functionId))
    .innerJoin(guests, eq(guests.id, functionInvites.guestId))
    .where(and(eq(transferRuns.eventId, eventId), eq(transferRuns.kind, "shuttle"), eq(guests.householdId, householdId)));
  const byRun = new Map<string, { run: TransferRun; guestIds: string[] }>();
  for (const o of own) {
    const e = byRun.get(o.run.id) ?? { run: o.run, guestIds: [] };
    e.guestIds.push(o.guestId);
    byRun.set(o.run.id, e);
  }
  for (const s of shuttles) if (!byRun.has(s.run.id)) byRun.set(s.run.id, { run: s.run, guestIds: [] });
  return [...byRun.values()].sort((a, b) => a.run.departsAt.getTime() - b.run.departsAt.getTime());
}

/** Plain-text manifest for sharing with a driver on WhatsApp (drivers have no login). */
export function manifestText(run: TransferRun, rows: ManifestRow[], fmt: (d: Date) => string): string {
  const lines = [`${run.fromPlace} → ${run.toPlace}`, fmt(run.departsAt), run.vehicle ?? "", ""];
  const byFamily = new Map<string, ManifestRow[]>();
  for (const r of rows) byFamily.set(r.household.id, [...(byFamily.get(r.household.id) ?? []), r]);
  for (const fam of byFamily.values()) {
    const t = fam[0].travel;
    const flight = run.kind === "pickup" ? t?.arrivalNumber : t?.departureNumber;
    const at = run.kind === "pickup" ? t?.arrivalAt : t?.departureAt;
    lines.push(`• ${fam.map((r) => r.guest.name).join(", ")} (${fam.length})${flight ? ` · ${flight}` : ""}${at ? ` ${fmt(at)}` : ""}${fam[0].contactPhone ? ` · ${fam[0].contactPhone}` : ""}`);
  }
  lines.push("", `${rows.length}/${run.capacity}`);
  return lines.filter((l, i) => l !== "" || i > 2).join("\n");
}
